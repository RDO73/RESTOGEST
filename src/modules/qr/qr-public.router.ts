import crypto from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { adminPool, type IDbClient } from '../../db/pool.js';
import {
  ensureDefaultCompanyTablesAndSettings,
  createLinkedPendingSaleForQrOrder,
} from './qr-admin.router.js';

export const qrPublicRouter = Router();

function createSlidingWindowLimiter(opts: {
  windowMs: number;
  max: number;
  code: string;
  message: string;
}) {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (req: Request, res: Response, next: NextFunction) => {
    const key = String(req.ip || req.headers['x-forwarded-for'] || 'local');
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }
    entry.count += 1;
    if (entry.count > opts.max) {
      res.status(429).json({
        error: {
          code: opts.code,
          message: opts.message,
        },
      });
      return;
    }
    next();
  };
}

const publicMenuLimiter = createSlidingWindowLimiter({
  windowMs: 60 * 1000,
  max: 180,
  code: 'RATE_LIMIT_EXCEEDED',
  message: 'Trop de requêtes depuis cet appareil. Veuillez patienter quelques secondes.',
});

const publicOrderSubmitLimiter = createSlidingWindowLimiter({
  windowMs: 60 * 1000,
  max: 40,
  code: 'ORDER_RATE_LIMIT',
  message: 'Trop de tentatives de commande rapprochées. Veuillez patienter une minute.',
});

qrPublicRouter.use(publicMenuLimiter);

async function withPublicTransaction<T>(fn: (client: IDbClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function parseProductPresentationMeta(product: any): {
  description: string;
  imageUrl: string | null;
  isPopular: boolean;
  isTemporarilyUnavailable: boolean;
  isVisibleOnQr: boolean;
  allergens: string[];
  prepTimeMinutes: number | null;
} {
  return {
    description: product.description || '',
    imageUrl: product.image_url || null,
    isPopular: Boolean(product.is_popular),
    isTemporarilyUnavailable: Boolean(product.is_temporarily_unavailable),
    isVisibleOnQr: product.is_visible_on_qr !== false,
    allergens: Array.isArray(product.allergens) ? product.allergens : [],
    prepTimeMinutes: product.prep_time_minutes ? Number(product.prep_time_minutes) : null,
  };
}

// -------------------------------------------------------------
// 1. MENU DIGITAL PUBLIC PAR QR TOKEN
// -------------------------------------------------------------
qrPublicRouter.get('/menu/:qrToken', async (req, res, next) => {
  try {
    const qrToken = String(req.params.qrToken || '').trim();
    if (qrToken.length < 8) {
      res.status(404).json({
        error: {
          code: 'INVALID_QR_TOKEN',
          message: 'Ce QR Code est invalide ou a été remplacé.',
        },
      });
      return;
    }

    const payload = await withPublicTransaction(async (client) => {
      const tableRes = await client.query(
        `SELECT dt.*, c.name AS company_name, c.is_active AS company_is_active, c.currency AS company_currency
         FROM public.dining_tables dt
         JOIN public.companies c ON c.id = dt.company_id
         WHERE dt.qr_token = $1`,
        [qrToken]
      );

      if (tableRes.rows.length === 0) {
        return { errorStatus: 404, errorCode: 'INVALID_QR_TOKEN', errorMessage: 'Ce QR Code est invalide ou a été révoqué.' };
      }

      const table = tableRes.rows[0];
      if (!table.company_is_active) {
        return { errorStatus: 403, errorCode: 'ESTABLISHMENT_INACTIVE', errorMessage: 'Cet établissement est actuellement indisponible.' };
      }
      if (!table.is_active) {
        return {
          errorStatus: 403,
          errorCode: 'TABLE_DISABLED',
          errorMessage: 'Cette table est temporairement désactivée. Veuillez vous adresser à un serveur.',
        };
      }

      const companyId = table.company_id as string;
      await ensureDefaultCompanyTablesAndSettings(client, companyId);

      const settingsRes = await client.query(
        `SELECT * FROM public.qr_menu_settings WHERE company_id = $1`,
        [companyId]
      );
      const settings = settingsRes.rows[0] || {};

      const categoriesRes = await client.query(
        `SELECT id, name, description
         FROM public.categories
         WHERE company_id = $1
         ORDER BY name ASC`,
        [companyId]
      );

      // STRICT FILTER: Only active finished_good & service products.
      // Never expose raw_material, semi_finished, cost_price, or exact stock quantities.
      const productsRes = await client.query(
        `SELECT p.id, p.category_id, p.name, p.unit, p.selling_price,
                p.inventory_tracking AS stock_deduction_mode,
                sl.current_quantity AS stock_quantity,
                p.min_stock_alert AS stock_alert_threshold,
                c.name AS category_name
         FROM public.products p
         LEFT JOIN public.categories c ON c.id = p.category_id AND c.company_id = p.company_id
         LEFT JOIN public.stock_levels sl ON sl.product_id = p.id AND sl.company_id = p.company_id
         WHERE p.company_id = $1
           AND p.is_active = TRUE
           AND p.product_type IN ('finished_good', 'service')
         ORDER BY c.name ASC NULLS LAST, p.name ASC`,
        [companyId]
      );

      const groupsRes = await client.query(
        `SELECT id, product_id, name, is_required, selection_type, min_choices, max_choices, allow_custom_text, sort_order
         FROM public.product_option_groups
         WHERE company_id = $1 AND is_active = TRUE
         ORDER BY sort_order ASC, created_at ASC`,
        [companyId]
      );

      const valuesRes = await client.query(
        `SELECT id, group_id, label, price_delta, is_default, is_available, sort_order
         FROM public.product_option_values
         WHERE company_id = $1 AND is_available = TRUE
         ORDER BY sort_order ASC, created_at ASC`,
        [companyId]
      );

      const valuesByGroup = new Map<string, any[]>();
      for (const v of valuesRes.rows) {
        const list = valuesByGroup.get(v.group_id) || [];
        list.push({
          id: v.id,
          label: v.label,
          priceDelta: Number(v.price_delta),
          isDefault: Boolean(v.is_default),
        });
        valuesByGroup.set(v.group_id, list);
      }

      const groupsByProduct = new Map<string, any[]>();
      for (const g of groupsRes.rows) {
        const key = g.product_id || '__GLOBAL__';
        const list = groupsByProduct.get(key) || [];
        list.push({
          id: g.id,
          name: g.name,
          isRequired: Boolean(g.is_required),
          selectionType: g.selection_type,
          minChoices: Number(g.min_choices || 0),
          maxChoices: Number(g.max_choices || 1),
          allowCustomText: Boolean(g.allow_custom_text),
          values: valuesByGroup.get(g.id) || [],
        });
        groupsByProduct.set(key, list);
      }

      const rawMetaMap =
        settings.opening_hours && typeof settings.opening_hours === 'object' && settings.opening_hours.__productMeta
          ? settings.opening_hours.__productMeta
          : {};

      const publicProducts = productsRes.rows
        .map((p: any) => {
          const customMeta = rawMetaMap[p.id] || {};
          const merged = { ...p, ...customMeta };
          const meta = parseProductPresentationMeta(merged);
          if (!meta.isVisibleOnQr) return null;

          // Determine public availability without leaking exact stock numbers
          const isDirectOut =
            p.stock_deduction_mode === 'direct' &&
            Number(p.stock_alert_threshold) > 0 &&
            p.stock_quantity !== null &&
            p.stock_quantity !== undefined &&
            Number(p.stock_quantity) <= 0;
          const isOutOfStock = Boolean(customMeta.is_out_of_stock) || isDirectOut;
          const isAvailable = !meta.isTemporarilyUnavailable && !isOutOfStock;

          const productGroups = [
            ...(groupsByProduct.get(p.id) || []),
            ...(groupsByProduct.get('__GLOBAL__') || []),
          ];

          return {
            id: p.id,
            categoryId: p.category_id,
            categoryName: p.category_name || 'Carte & Spécialités',
            name: p.name,
            description: meta.description,
            imageUrl: meta.imageUrl,
            sellingPrice: Number(p.selling_price),
            isPopular: meta.isPopular,
            isTemporarilyUnavailable: meta.isTemporarilyUnavailable,
            isOutOfStock,
            isAvailable,
            allergens: meta.allergens,
            prepTimeMinutes: meta.prepTimeMinutes,
            optionGroups: productGroups,
          };
        })
        .filter(Boolean);

      return {
        establishment: {
          displayName: settings.display_name || table.company_name,
          tagline: settings.tagline || 'Commandez directement depuis votre table',
          logoUrl: settings.logo_url || null,
          coverImageUrl: settings.cover_image_url || null,
          welcomeMessage:
            settings.welcome_message ||
            'Bienvenue ! Sélectionnez vos plats, boissons ou pâtisseries et envoyez votre commande en un clic.',
          currency: settings.currency || 'XOF',
          phone: settings.phone || table.company_phone || null,
          whatsappPhone: settings.whatsapp_phone || table.company_phone || null,
          address: settings.address || table.company_address || null,
          openingHours: settings.opening_hours || {},
          qrOrderingEnabled: settings.qr_ordering_enabled !== false,
          allowTakeawayQr: settings.allow_takeaway_qr !== false,
          allowCallWaiter: settings.allow_call_waiter !== false,
          allowRequestBill: settings.allow_request_bill !== false,
          requireCustomerName: Boolean(settings.require_customer_name),
          requireCustomerPhone: Boolean(settings.require_customer_phone),
          primaryColor: settings.primary_color || '#f97316',
        },
        table: {
          id: table.id,
          code: table.code,
          name: table.name,
          zone: table.zone,
          seats: Number(table.seats),
          tableType: table.table_type,
          currentStatus: table.current_status,
        },
        categories: categoriesRes.rows,
        products: publicProducts,
      };
    });

    if ('errorStatus' in payload && payload.errorStatus) {
      res.status(payload.errorStatus).json({
        error: { code: payload.errorCode, message: payload.errorMessage },
      });
      return;
    }

    res.json({ data: payload });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 2. PASSAGE DE COMMANDE CLIENT DEPUIS LE QR CODE (MODULE 4)
// -------------------------------------------------------------
const submitQrOrderSchema = z.object({
  orderType: z.enum(['dine_in', 'takeaway', 'counter']).optional(),
  customerName: z.string().max(120).optional().nullable(),
  customerPhone: z.string().max(40).optional().nullable(),
  customerNote: z.string().max(600).optional().nullable(),
  idempotencyKey: z.string().min(6).max(120).optional().nullable(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        quantity: z.number().int().min(1).max(99),
        selectedOptionValueIds: z.array(z.string().uuid()).max(25).optional().default([]),
        customMessage: z.string().max(250).optional().nullable(),
        itemNote: z.string().max(300).optional().nullable(),
      })
    )
    .min(1)
    .max(50),
});

qrPublicRouter.post('/menu/:qrToken/orders', publicOrderSubmitLimiter, async (req, res, next) => {
  try {
    const qrToken = String(req.params.qrToken || '').trim();
    const parsed = submitQrOrderSchema.parse(req.body);

    const result = await withPublicTransaction(async (client) => {
      const tableRes = await client.query(
        `SELECT dt.*, c.name AS company_name, c.is_active AS company_is_active
         FROM public.dining_tables dt
         JOIN public.companies c ON c.id = dt.company_id
         WHERE dt.qr_token = $1
         FOR UPDATE OF dt`,
        [qrToken]
      );

      if (tableRes.rows.length === 0) {
        return { errorStatus: 404, errorCode: 'INVALID_QR_TOKEN', errorMessage: 'Ce QR Code est invalide ou révoqué.' };
      }
      const table = tableRes.rows[0];
      if (!table.company_is_active) {
        return { errorStatus: 403, errorCode: 'ESTABLISHMENT_INACTIVE', errorMessage: 'Établissement indisponible.' };
      }
      if (!table.is_active) {
        return { errorStatus: 403, errorCode: 'TABLE_DISABLED', errorMessage: 'Cette table est actuellement désactivée.' };
      }

      const companyId = table.company_id as string;
      const settingsRes = await client.query(
        `SELECT * FROM public.qr_menu_settings WHERE company_id = $1`,
        [companyId]
      );
      const settings = settingsRes.rows[0] || {};

      if (settings.qr_ordering_enabled === false) {
        return {
          errorStatus: 403,
          errorCode: 'QR_ORDERING_DISABLED',
          errorMessage: 'La prise de commande par QR Code est temporairement suspendue par l’établissement.',
        };
      }

      if (settings.require_customer_name && (!parsed.customerName || !parsed.customerName.trim())) {
        return {
          errorStatus: 400,
          errorCode: 'CUSTOMER_NAME_REQUIRED',
          errorMessage: 'Veuillez indiquer votre nom pour valider la commande.',
        };
      }
      if (settings.require_customer_phone && (!parsed.customerPhone || !parsed.customerPhone.trim())) {
        return {
          errorStatus: 400,
          errorCode: 'CUSTOMER_PHONE_REQUIRED',
          errorMessage: 'Veuillez indiquer votre numéro de téléphone pour valider la commande.',
        };
      }

      // Check idempotency key to prevent duplicate submissions
      if (parsed.idempotencyKey) {
        const existingRes = await client.query(
          `SELECT id, order_number, tracking_token, status, payment_status, total_amount, created_at
           FROM public.qr_orders
           WHERE company_id = $1 AND idempotency_key = $2`,
          [companyId, parsed.idempotencyKey]
        );
        if (existingRes.rows.length > 0) {
          return {
            idempotentReplay: true,
            order: existingRes.rows[0],
          };
        }
      }

      const rawMetaMap =
        settings.opening_hours && typeof settings.opening_hours === 'object' && settings.opening_hours.__productMeta
          ? settings.opening_hours.__productMeta
          : {};

      let calculatedSubtotal = 0;
      const resolvedItems: Array<{
        productId: string;
        productName: string;
        quantity: number;
        baseUnitPrice: number;
        optionsUnitPrice: number;
        unitPrice: number;
        lineSubtotal: number;
        customMessage: string | null;
        itemNote: string | null;
        selectedOptions: Array<{
          optionValueId: string;
          groupNameSnapshot: string;
          optionLabelSnapshot: string;
          priceDeltaSnapshot: number;
        }>;
      }> = [];

      for (const reqItem of parsed.items) {
        const prodRes = await client.query(
          `SELECT p.id, p.name, p.selling_price, p.product_type, p.is_active,
                  p.inventory_tracking AS stock_deduction_mode,
                  sl.current_quantity AS stock_quantity,
                  p.min_stock_alert AS stock_alert_threshold
           FROM public.products p
           LEFT JOIN public.stock_levels sl ON sl.product_id = p.id AND sl.company_id = p.company_id
           WHERE p.id = $1 AND p.company_id = $2`,
          [reqItem.productId, companyId]
        );
        if (prodRes.rows.length === 0) {
          return {
            errorStatus: 400,
            errorCode: 'PRODUCT_NOT_FOUND',
            errorMessage: 'Un des produits sélectionnés n’existe plus.',
          };
        }
        const product = prodRes.rows[0];
        if (!product.is_active || !['finished_good', 'service'].includes(product.product_type)) {
          return {
            errorStatus: 400,
            errorCode: 'PRODUCT_UNAVAILABLE',
            errorMessage: `Le produit "${product.name}" n'est pas disponible à la vente publique.`,
          };
        }

        const customMeta = rawMetaMap[product.id] || {};
        const isDirectOut =
          product.stock_deduction_mode === 'direct' &&
          Number(product.stock_alert_threshold) > 0 &&
          product.stock_quantity !== null &&
          product.stock_quantity !== undefined &&
          Number(product.stock_quantity) <= 0;
        if (
          customMeta.is_temporarily_unavailable ||
          customMeta.is_out_of_stock ||
          customMeta.is_visible_on_qr === false ||
          isDirectOut
        ) {
          return {
            errorStatus: 400,
            errorCode: 'PRODUCT_OUT_OF_STOCK',
            errorMessage: `Le produit "${product.name}" est temporairement épuisé ou indisponible.`,
          };
        }

        // Load option groups for this product
        const groupsRes = await client.query(
          `SELECT id, name, is_required, selection_type, min_choices, max_choices, allow_custom_text
           FROM public.product_option_groups
           WHERE company_id = $1 AND is_active = TRUE AND (product_id = $2 OR product_id IS NULL)`,
          [companyId, product.id]
        );
        const groups = groupsRes.rows;
        const groupMap = new Map<string, any>(groups.map((g: any) => [g.id, g]));

        const uniqueValueIds = Array.from(new Set(reqItem.selectedOptionValueIds || []));
        const selectedOptions: Array<{
          optionValueId: string;
          groupId: string;
          groupNameSnapshot: string;
          optionLabelSnapshot: string;
          priceDeltaSnapshot: number;
        }> = [];

        if (uniqueValueIds.length > 0) {
          const valsRes = await client.query(
            `SELECT id, group_id, label, price_delta, is_available
             FROM public.product_option_values
             WHERE company_id = $1 AND id = ANY($2::UUID[])`,
            [companyId, uniqueValueIds]
          );
          if (valsRes.rows.length !== uniqueValueIds.length) {
            return {
              errorStatus: 400,
              errorCode: 'INVALID_OPTION_VALUE',
              errorMessage: `Option invalide sélectionnée pour "${product.name}".`,
            };
          }
          for (const val of valsRes.rows) {
            const grp = groupMap.get(val.group_id);
            if (!grp || !val.is_available) {
              return {
                errorStatus: 400,
                errorCode: 'INVALID_OPTION_GROUP',
                errorMessage: `L'option "${val.label}" n'est pas valide pour "${product.name}".`,
              };
            }
            selectedOptions.push({
              optionValueId: val.id,
              groupId: grp.id,
              groupNameSnapshot: grp.name,
              optionLabelSnapshot: val.label,
              priceDeltaSnapshot: Number(val.price_delta),
            });
          }
        }

        // Verify required options and min/max choices per group
        for (const grp of groups) {
          const chosenInGroup = selectedOptions.filter((o) => o.groupId === grp.id);
          const minRequired = grp.is_required ? Math.max(1, Number(grp.min_choices || 1)) : Number(grp.min_choices || 0);
          const maxAllowed = grp.selection_type === 'single' ? 1 : Math.max(1, Number(grp.max_choices || 10));

          if (chosenInGroup.length < minRequired) {
            return {
              errorStatus: 400,
              errorCode: 'MISSING_REQUIRED_OPTION',
              errorMessage: `Veuillez choisir une option pour "${grp.name}" sur le produit "${product.name}".`,
            };
          }
          if (chosenInGroup.length > maxAllowed) {
            return {
              errorStatus: 400,
              errorCode: 'TOO_MANY_OPTIONS',
              errorMessage: `Trop d'options sélectionnées dans "${grp.name}" pour "${product.name}" (max: ${maxAllowed}).`,
            };
          }
        }

        const baseUnitPrice = Number(product.selling_price);
        const optionsUnitPrice = selectedOptions.reduce((acc, o) => acc + o.priceDeltaSnapshot, 0);
        const unitPrice = Math.round((baseUnitPrice + optionsUnitPrice) * 100) / 100;
        const lineSubtotal = Math.round(unitPrice * reqItem.quantity * 100) / 100;
        calculatedSubtotal = Math.round((calculatedSubtotal + lineSubtotal) * 100) / 100;

        resolvedItems.push({
          productId: product.id,
          productName: product.name,
          quantity: reqItem.quantity,
          baseUnitPrice,
          optionsUnitPrice,
          unitPrice,
          lineSubtotal,
          customMessage: reqItem.customMessage?.trim() || null,
          itemNote: reqItem.itemNote?.trim() || null,
          selectedOptions: selectedOptions.map((o) => ({
            optionValueId: o.optionValueId,
            groupNameSnapshot: o.groupNameSnapshot,
            optionLabelSnapshot: o.optionLabelSnapshot,
            priceDeltaSnapshot: o.priceDeltaSnapshot,
          })),
        });
      }

      const orderNumber = `RG-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}-${crypto
        .randomBytes(2)
        .toString('hex')
        .toUpperCase()}`;
      const trackingToken = crypto.randomBytes(24).toString('hex');
      const effectiveOrderType =
        parsed.orderType || (table.table_type === 'takeaway_qr' ? 'takeaway' : table.table_type === 'counter' ? 'counter' : 'dine_in');

      const autoAccept = Boolean(settings.auto_accept_orders);
      const initialStatus = autoAccept ? 'accepted' : 'received';

      const orderRes = await client.query(
        `INSERT INTO public.qr_orders (
           company_id, table_id, order_number, tracking_token, order_type,
           status, payment_status, customer_name, customer_phone, customer_note,
           table_code_snapshot, table_name_snapshot, subtotal, tax_amount, total_amount,
           idempotency_key, source_ip, user_agent, accepted_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, 'unpaid', $7, $8, $9, $10, $11, $12, 0, $12, $13, $14, $15, $16)
         RETURNING id, order_number, tracking_token, status, payment_status, subtotal, tax_amount, total_amount, created_at`,
        [
          companyId,
          table.id,
          orderNumber,
          trackingToken,
          effectiveOrderType,
          initialStatus,
          parsed.customerName?.trim() || null,
          parsed.customerPhone?.trim() || null,
          parsed.customerNote?.trim() || null,
          table.code,
          table.name,
          calculatedSubtotal,
          parsed.idempotencyKey || null,
          req.ip || null,
          String(req.headers['user-agent'] || '').slice(0, 250) || null,
          autoAccept ? new Date().toISOString() : null,
        ]
      );
      const createdOrder = orderRes.rows[0];

      for (const item of resolvedItems) {
        const itemRes = await client.query(
          `INSERT INTO public.qr_order_items (
             company_id, qr_order_id, product_id, product_name_snapshot,
             quantity, base_unit_price, options_unit_price, unit_price, subtotal,
             item_note, custom_message
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING id`,
          [
            companyId,
            createdOrder.id,
            item.productId,
            item.productName,
            item.quantity,
            item.baseUnitPrice,
            item.optionsUnitPrice,
            item.unitPrice,
            item.lineSubtotal,
            item.itemNote,
            item.customMessage,
          ]
        );
        const qrOrderItemId = itemRes.rows[0].id;

        for (const opt of item.selectedOptions) {
          await client.query(
            `INSERT INTO public.qr_order_item_options (
               company_id, qr_order_item_id, option_value_id,
               group_name_snapshot, option_label_snapshot, price_delta_snapshot
             )
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              companyId,
              qrOrderItemId,
              opt.optionValueId,
              opt.groupNameSnapshot,
              opt.optionLabelSnapshot,
              opt.priceDeltaSnapshot,
            ]
          );
        }
      }

      await client.query(
        `INSERT INTO public.qr_order_status_history (company_id, qr_order_id, previous_status, new_status, note)
         VALUES ($1, $2, NULL, $3, $4)`,
        [
          companyId,
          createdOrder.id,
          initialStatus,
          autoAccept ? 'Commande reçue et acceptée automatiquement' : 'Commande envoyée depuis la table',
        ]
      );

      if (table.table_type === 'table') {
        const nextTblStatus = initialStatus === 'accepted' ? 'preparing' : 'order_pending';
        await client.query(
          `UPDATE public.dining_tables
           SET current_status = $3,
               updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [table.id, companyId, nextTblStatus]
        );
      }

      if (autoAccept) {
        const ownerRes = await client.query(
          `SELECT cu.user_id AS id
           FROM public.company_users cu
           JOIN public.users u ON u.id = cu.user_id
           WHERE cu.company_id = $1 AND u.is_active = TRUE
           ORDER BY cu.created_at ASC LIMIT 1`,
          [companyId]
        );
        if (ownerRes.rows[0]?.id) {
          await createLinkedPendingSaleForQrOrder(client, companyId, ownerRes.rows[0].id, createdOrder.id);
        }
      }

      return {
        idempotentReplay: false,
        order: createdOrder,
      };
    });

    if ('errorStatus' in result && result.errorStatus) {
      res.status(result.errorStatus).json({
        error: { code: result.errorCode, message: result.errorMessage },
      });
      return;
    }

    res.status(result.idempotentReplay ? 200 : 201).json({
      data: result.order,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 3. SUIVI DE COMMANDE SÉCURISÉ PAR TRACKING TOKEN (MODULE 6)
// -------------------------------------------------------------
qrPublicRouter.get('/orders/:trackingToken', async (req, res, next) => {
  try {
    const trackingToken = String(req.params.trackingToken || '').trim();
    if (trackingToken.length < 12) {
      res.status(404).json({
        error: { code: 'ORDER_NOT_FOUND', message: 'Commande introuvable.' },
      });
      return;
    }

    const data = await withPublicTransaction(async (client) => {
      const ordRes = await client.query(
        `SELECT qo.id, qo.company_id, qo.table_id, qo.order_number, qo.tracking_token,
                qo.order_type, qo.status, qo.payment_status, qo.customer_name,
                qo.customer_note, qo.table_code_snapshot, qo.table_name_snapshot,
                qo.subtotal, qo.tax_amount, qo.total_amount, qo.rejection_reason,
                qo.created_at, qo.accepted_at, qo.preparing_at, qo.ready_at,
                qo.served_at, qo.rejected_at, qo.cancelled_at,
                dt.qr_token AS table_qr_token,
                c.name AS company_name
         FROM public.qr_orders qo
         JOIN public.companies c ON c.id = qo.company_id
         LEFT JOIN public.dining_tables dt ON dt.id = qo.table_id
         WHERE qo.tracking_token = $1`,
        [trackingToken]
      );

      if (ordRes.rows.length === 0) {
        return null;
      }
      const order = ordRes.rows[0];
      const companyId = order.company_id;

      const settingsRes = await client.query(
        `SELECT display_name, currency, whatsapp_phone, allow_call_waiter, allow_request_bill
         FROM public.qr_menu_settings
         WHERE company_id = $1`,
        [companyId]
      );
      const settings = settingsRes.rows[0] || {};

      const itemsRes = await client.query(
        `SELECT id, product_name_snapshot, quantity, base_unit_price, options_unit_price,
                unit_price, subtotal, item_note, custom_message
         FROM public.qr_order_items
         WHERE qr_order_id = $1 AND company_id = $2
         ORDER BY created_at ASC`,
        [order.id, companyId]
      );

      const optsRes = await client.query(
        `SELECT oio.qr_order_item_id, oio.group_name_snapshot, oio.option_label_snapshot, oio.price_delta_snapshot
         FROM public.qr_order_item_options oio
         JOIN public.qr_order_items qoi ON qoi.id = oio.qr_order_item_id
         WHERE qoi.qr_order_id = $1 AND oio.company_id = $2`,
        [order.id, companyId]
      );

      const optsByItem = new Map<string, any[]>();
      for (const opt of optsRes.rows) {
        const list = optsByItem.get(opt.qr_order_item_id) || [];
        list.push({
          groupName: opt.group_name_snapshot,
          label: opt.option_label_snapshot,
          priceDelta: Number(opt.price_delta_snapshot),
        });
        optsByItem.set(opt.qr_order_item_id, list);
      }

      const historyRes = await client.query(
        `SELECT previous_status, new_status, note, created_at
         FROM public.qr_order_status_history
         WHERE qr_order_id = $1 AND company_id = $2
         ORDER BY created_at ASC`,
        [order.id, companyId]
      );

      return {
        order: {
          id: order.id,
          orderNumber: order.order_number,
          trackingToken: order.tracking_token,
          orderType: order.order_type,
          status: order.status,
          paymentStatus: order.payment_status,
          customerName: order.customer_name,
          customerNote: order.customer_note,
          tableCode: order.table_code_snapshot,
          tableName: order.table_name_snapshot,
          tableQrToken: order.table_qr_token,
          subtotal: Number(order.subtotal),
          taxAmount: Number(order.tax_amount),
          totalAmount: Number(order.total_amount),
          rejectionReason: order.rejection_reason,
          createdAt: order.created_at,
          acceptedAt: order.accepted_at,
          preparingAt: order.preparing_at,
          readyAt: order.ready_at,
          servedAt: order.served_at,
        },
        establishment: {
          displayName: settings.display_name || order.company_name,
          currency: settings.currency || 'XOF',
          whatsappPhone: settings.whatsapp_phone || null,
          allowCallWaiter: settings.allow_call_waiter !== false,
          allowRequestBill: settings.allow_request_bill !== false,
        },
        items: itemsRes.rows.map((it: any) => ({
          id: it.id,
          productName: it.product_name_snapshot,
          quantity: Number(it.quantity),
          unitPrice: Number(it.unit_price),
          subtotal: Number(it.subtotal),
          itemNote: it.item_note,
          customMessage: it.custom_message,
          options: optsByItem.get(it.id) || [],
        })),
        statusHistory: historyRes.rows,
      };
    });

    if (!data) {
      res.status(404).json({
        error: { code: 'ORDER_NOT_FOUND', message: 'Commande introuvable ou jeton de suivi invalide.' },
      });
      return;
    }

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 4. APPELER UN SERVEUR / DEMANDER L'ADDITION (MODULE 6)
// -------------------------------------------------------------
const serviceRequestSchema = z.object({
  requestType: z.enum(['call_waiter', 'request_bill']),
  customerNote: z.string().max(250).optional().nullable(),
  qrOrderId: z.string().uuid().optional().nullable(),
});

qrPublicRouter.post('/menu/:qrToken/service-request', publicOrderSubmitLimiter, async (req, res, next) => {
  try {
    const qrToken = String(req.params.qrToken || '').trim();
    const parsed = serviceRequestSchema.parse(req.body);

    const result = await withPublicTransaction(async (client) => {
      const tableRes = await client.query(
        `SELECT dt.*, c.is_active AS company_is_active
         FROM public.dining_tables dt
         JOIN public.companies c ON c.id = dt.company_id
         WHERE dt.qr_token = $1`,
        [qrToken]
      );

      if (tableRes.rows.length === 0) {
        return { errorStatus: 404, errorCode: 'INVALID_QR_TOKEN', errorMessage: 'Ce QR Code est invalide.' };
      }
      const table = tableRes.rows[0];
      if (!table.company_is_active || !table.is_active) {
        return { errorStatus: 403, errorCode: 'TABLE_DISABLED', errorMessage: 'Cette table est désactivée.' };
      }

      const companyId = table.company_id as string;
      const settingsRes = await client.query(
        `SELECT allow_call_waiter, allow_request_bill FROM public.qr_menu_settings WHERE company_id = $1`,
        [companyId]
      );
      const settings = settingsRes.rows[0] || {};

      if (parsed.requestType === 'call_waiter' && settings.allow_call_waiter === false) {
        return { errorStatus: 403, errorCode: 'CALL_WAITER_DISABLED', errorMessage: 'Option non activée.' };
      }
      if (parsed.requestType === 'request_bill' && settings.allow_request_bill === false) {
        return { errorStatus: 403, errorCode: 'REQUEST_BILL_DISABLED', errorMessage: 'Option non activée.' };
      }

      const dupRes = await client.query(
        `SELECT id, request_type, status, created_at
         FROM public.table_service_requests
         WHERE company_id = $1 AND table_id = $2 AND request_type = $3 AND status = 'pending'
         ORDER BY created_at DESC LIMIT 1`,
        [companyId, table.id, parsed.requestType]
      );
      if (dupRes.rows.length > 0) {
        return { request: dupRes.rows[0], deduplicated: true };
      }

      const insRes = await client.query(
        `INSERT INTO public.table_service_requests (
           company_id, table_id, qr_order_id, request_type, status,
           table_code_snapshot, customer_note
         )
         VALUES ($1, $2, $3, $4, 'pending', $5, $6)
         RETURNING id, request_type, status, table_code_snapshot, created_at`,
        [
          companyId,
          table.id,
          parsed.qrOrderId || null,
          parsed.requestType,
          table.code,
          parsed.customerNote?.trim() || null,
        ]
      );

      if (parsed.requestType === 'request_bill') {
        await client.query(
          `UPDATE public.dining_tables
           SET current_status = 'bill_requested', updated_at = NOW()
           WHERE id = $1 AND company_id = $2`,
          [table.id, companyId]
        );
      }

      return { request: insRes.rows[0], deduplicated: false };
    });

    if ('errorStatus' in result && result.errorStatus) {
      res.status(result.errorStatus).json({
        error: { code: result.errorCode, message: result.errorMessage },
      });
      return;
    }

    res.status(201).json({ data: result.request, deduplicated: result.deduplicated });
  } catch (err) {
    next(err);
  }
});
