import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middlewares/auth-middleware.js';
import { withTenantContext } from '../../db/tenant-context.js';
import type { IDbClient } from '../../db/pool.js';
import { generateTableQrPosterSvg } from '../../utils/qrcode-svg.js';

export const qrAdminRouter = Router();

qrAdminRouter.use(requireAuth);
qrAdminRouter.use((req, res, next) => {
  const method = req.method.toUpperCase();
  const pathStr = req.path || '';

  if (pathStr.startsWith('/analytics')) {
    requirePermission('reports:read', 'dashboard:read', 'qr_orders:read')(req, res, next);
    return;
  }
  if (pathStr.startsWith('/orders') || pathStr.startsWith('/service-requests')) {
    if (method === 'GET') {
      requirePermission('qr_orders:read', 'tables:read', 'pos:read')(req, res, next);
      return;
    }
    if (/\/pay$/i.test(pathStr)) {
      requirePermission('pos:pay', 'cash:write')(req, res, next);
      return;
    }
    requirePermission('qr_orders:write')(req, res, next);
    return;
  }
  if (method === 'GET') {
    requirePermission('tables:read', 'qr_orders:read', 'catalog:read')(req, res, next);
    return;
  }
  if (/\/close-session$/i.test(pathStr)) {
    requirePermission('tables:write', 'pos:write', 'pos:pay')(req, res, next);
    return;
  }
  requirePermission('tables:write')(req, res, next);
});

function generateSecureToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('hex');
}

const DEFAULT_TABLES_SEED = [
  ...Array.from({ length: 12 }, (_, idx) => ({
    code: `T${String(idx + 1).padStart(2, '0')}`,
    name: `Table ${String(idx + 1).padStart(2, '0')}`,
    zone: 'Salle intérieure',
    seats: idx < 4 ? 2 : idx < 10 ? 4 : 6,
    tableType: 'table' as const,
  })),
  { code: 'TER1', name: 'Terrasse 1', zone: 'Terrasse', seats: 4, tableType: 'table' as const },
  { code: 'TER2', name: 'Terrasse 2', zone: 'Terrasse', seats: 6, tableType: 'table' as const },
  { code: 'VIP1', name: 'Salon VIP 1', zone: 'Espace VIP', seats: 6, tableType: 'table' as const },
  {
    code: 'EMPORTER',
    name: 'Comptoir & À Emporter',
    zone: 'Comptoir',
    seats: 1,
    tableType: 'takeaway_qr' as const,
  },
];

export async function ensureDefaultCompanyTablesAndSettings(
  client: IDbClient,
  companyId: string
): Promise<void> {
  const compRes = await client.query(
    `SELECT name FROM public.companies WHERE id = $1`,
    [companyId]
  );
  const companyName = compRes.rows[0]?.name || 'Mon Établissement';

  await client.query(
    `INSERT INTO public.qr_menu_settings (company_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (company_id) DO NOTHING`,
    [companyId, companyName]
  );

  const countRes = await client.query(
    `SELECT COUNT(*)::INT AS cnt FROM public.dining_tables WHERE company_id = $1`,
    [companyId]
  );
  if (Number(countRes.rows[0]?.cnt || 0) === 0) {
    for (const t of DEFAULT_TABLES_SEED) {
      await client.query(
        `INSERT INTO public.dining_tables (company_id, code, name, zone, seats, table_type, qr_token, is_active, current_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'free')
         ON CONFLICT (company_id, code) DO NOTHING`,
        [companyId, t.code, t.name, t.zone, t.seats, t.tableType, generateSecureToken(24)]
      );
    }
  }
}

export async function createLinkedPendingSaleForQrOrder(
  client: IDbClient,
  companyId: string,
  userId: string,
  qrOrderId: string
): Promise<string> {
  const ordRes = await client.query(
    `SELECT * FROM public.qr_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
    [qrOrderId, companyId]
  );
  if (ordRes.rows.length === 0) {
    throw new Error('Commande QR introuvable');
  }
  const order = ordRes.rows[0];
  if (order.linked_sale_id) {
    return order.linked_sale_id;
  }

  const cashRes = await client.query(
    `SELECT id FROM public.cash_sessions WHERE company_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
    [companyId]
  );
  const cashSessionId = cashRes.rows[0]?.id || null;

  const metaNote = `RG_META:${JSON.stringify({
    serviceMode: order.order_type === 'takeaway' ? 'takeaway' : 'dine_in',
    tableCode: order.table_code_snapshot,
    tableName: order.table_name_snapshot,
    tableState: 'occupied',
    customerName: order.customer_name || '',
    customerPhone: order.customer_phone || '',
    qrOrderId: order.id,
    qrOrderNumber: order.order_number,
  })}`;

  const saleRes = await client.query(
    `INSERT INTO public.sales (company_id, user_id, cash_session_id, invoice_number, subtotal, tax_amount, total_amount, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)
     RETURNING id`,
    [
      companyId,
      userId,
      cashSessionId,
      order.order_number,
      order.subtotal,
      order.tax_amount,
      order.total_amount,
      metaNote,
    ]
  );
  const saleId = saleRes.rows[0].id;

  const itemsRes = await client.query(
    `SELECT * FROM public.qr_order_items WHERE qr_order_id = $1 AND company_id = $2 ORDER BY created_at ASC`,
    [qrOrderId, companyId]
  );

  for (const item of itemsRes.rows) {
    const optsRes = await client.query(
      `SELECT group_name_snapshot, option_label_snapshot FROM public.qr_order_item_options
       WHERE qr_order_item_id = $1 AND company_id = $2`,
      [item.id, companyId]
    );
    const optSummary = optsRes.rows
      .map((o: any) => `${o.group_name_snapshot}: ${o.option_label_snapshot}`)
      .join(' | ');
    const lineNote = [optSummary, item.custom_message ? `Message: ${item.custom_message}` : '', item.item_note || '']
      .filter(Boolean)
      .join(' — ');

    await client.query(
      `INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        companyId,
        saleId,
        item.product_id,
        item.quantity,
        item.unit_price,
        item.subtotal,
        lineNote || null,
      ]
    );
  }

  await client.query(
    `UPDATE public.qr_orders SET linked_sale_id = $1 WHERE id = $2 AND company_id = $3`,
    [saleId, qrOrderId, companyId]
  );

  return saleId;
}

// -------------------------------------------------------------
// 1. GESTION DES TABLES ET DES QR CODES
// -------------------------------------------------------------
qrAdminRouter.get('/tables', async (req, res, next) => {
  try {
    const tables = await withTenantContext(req.auth!, async (client) => {
      await ensureDefaultCompanyTablesAndSettings(client, req.auth!.companyId);

      const result = await client.query(
        `SELECT dt.*,
                COUNT(qo.id) FILTER (
                  WHERE qo.status IN ('received', 'accepted', 'preparing', 'ready')
                    AND qo.closed_at IS NULL
                )::INT AS active_orders_count,
                COALESCE(SUM(qo.total_amount) FILTER (
                  WHERE qo.status NOT IN ('rejected', 'cancelled')
                    AND qo.closed_at IS NULL
                ), 0) AS session_amount,
                MAX(qo.created_at) AS last_order_at,
                (
                  SELECT qo2.order_number
                  FROM public.qr_orders qo2
                  WHERE qo2.table_id = dt.id AND qo2.company_id = dt.company_id
                  ORDER BY qo2.created_at DESC
                  LIMIT 1
                ) AS last_order_number,
                (
                  SELECT COUNT(*)::INT
                  FROM public.table_service_requests tsr
                  WHERE tsr.table_id = dt.id
                    AND tsr.company_id = dt.company_id
                    AND tsr.status = 'pending'
                ) AS pending_requests_count
         FROM public.dining_tables dt
         LEFT JOIN public.qr_orders qo ON qo.table_id = dt.id AND qo.company_id = dt.company_id
         WHERE dt.company_id = $1
         GROUP BY dt.id
         ORDER BY dt.table_type ASC, dt.code ASC`,
        [req.auth!.companyId]
      );

      return result.rows.map((row: any) => ({
        ...row,
        public_menu_path: `/menu/${row.qr_token}`,
      }));
    });

    res.json({ success: true, data: tables });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/tables', async (req, res, next) => {
  try {
    const schema = z.object({
      code: z.string().min(1).max(40),
      name: z.string().min(1).max(120),
      zone: z.string().min(1).max(80).default('Salle intérieure'),
      seats: z.number().int().min(1).max(100).default(4),
      tableType: z.enum(['table', 'takeaway_qr', 'counter']).default('table'),
    });
    const data = schema.parse(req.body);

    const created = await withTenantContext(req.auth!, async (client) => {
      const qrToken = generateSecureToken(24);
      const result = await client.query(
        `INSERT INTO public.dining_tables (company_id, code, name, zone, seats, table_type, qr_token, is_active, current_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, 'free')
         RETURNING *`,
        [
          req.auth!.companyId,
          data.code.trim().toUpperCase(),
          data.name.trim(),
          data.zone.trim(),
          data.seats,
          data.tableType,
          qrToken,
        ]
      );
      return {
        ...result.rows[0],
        public_menu_path: `/menu/${result.rows[0].qr_token}`,
      };
    });

    res.status(201).json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.put('/tables/:id', async (req, res, next) => {
  try {
    const tableId = req.params.id;
    const schema = z.object({
      code: z.string().min(1).max(40).optional(),
      name: z.string().min(1).max(120).optional(),
      zone: z.string().min(1).max(80).optional(),
      seats: z.number().int().min(1).max(100).optional(),
      tableType: z.enum(['table', 'takeaway_qr', 'counter']).optional(),
      isActive: z.boolean().optional(),
      currentStatus: z
        .enum(['free', 'occupied', 'order_pending', 'in_preparation', 'ready', 'bill_requested'])
        .optional(),
    });
    const data = schema.parse(req.body);

    const updated = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `UPDATE public.dining_tables
         SET code = COALESCE($1, code),
             name = COALESCE($2, name),
             zone = COALESCE($3, zone),
             seats = COALESCE($4, seats),
             table_type = COALESCE($5, table_type),
             is_active = COALESCE($6, is_active),
             current_status = COALESCE($7, current_status),
             updated_at = NOW()
         WHERE id = $8 AND company_id = $9
         RETURNING *`,
        [
          data.code ? data.code.trim().toUpperCase() : null,
          data.name ? data.name.trim() : null,
          data.zone ? data.zone.trim() : null,
          data.seats ?? null,
          data.tableType ?? null,
          typeof data.isActive === 'boolean' ? data.isActive : null,
          data.currentStatus ?? null,
          tableId,
          req.auth!.companyId,
        ]
      );
      return result.rows[0] || null;
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Table introuvable' });
      return;
    }

    res.json({
      success: true,
      data: { ...updated, public_menu_path: `/menu/${updated.qr_token}` },
    });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/tables/:id/regenerate-qr', async (req, res, next) => {
  try {
    const tableId = req.params.id;
    const updated = await withTenantContext(req.auth!, async (client) => {
      const newToken = generateSecureToken(24);
      const result = await client.query(
        `UPDATE public.dining_tables
         SET qr_token = $1, updated_at = NOW()
         WHERE id = $2 AND company_id = $3
         RETURNING *`,
        [newToken, tableId, req.auth!.companyId]
      );
      return result.rows[0] || null;
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Table introuvable' });
      return;
    }

    res.json({
      success: true,
      message: 'Nouveau QR Code généré (l\'ancien jeton est immédiatement révoqué)',
      data: { ...updated, public_menu_path: `/menu/${updated.qr_token}` },
    });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/tables/:id/close-session', async (req, res, next) => {
  try {
    const tableId = req.params.id;
    const updated = await withTenantContext(req.auth!, async (client) => {
      const tRes = await client.query(
        `UPDATE public.dining_tables
         SET current_status = 'free', updated_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [tableId, req.auth!.companyId]
      );
      if (tRes.rows.length === 0) return null;

      await client.query(
        `UPDATE public.qr_orders
         SET closed_at = NOW()
         WHERE table_id = $1 AND company_id = $2 AND closed_at IS NULL
           AND status IN ('served', 'rejected', 'cancelled')`,
        [tableId, req.auth!.companyId]
      );

      await client.query(
        `UPDATE public.table_service_requests
         SET status = 'resolved', resolved_at = NOW()
         WHERE table_id = $1 AND company_id = $2 AND status <> 'resolved'`,
        [tableId, req.auth!.companyId]
      );

      return tRes.rows[0];
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Table introuvable' });
      return;
    }

    res.json({
      success: true,
      message: 'Session de table clôturée (l\'historique des commandes est intégralement conservé)',
      data: updated,
    });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.delete('/tables/:id', async (req, res, next) => {
  try {
    const tableId = req.params.id;
    const result = await withTenantContext(req.auth!, async (client) => {
      const ordCheck = await client.query(
        `SELECT COUNT(*)::INT AS cnt FROM public.qr_orders WHERE table_id = $1 AND company_id = $2`,
        [tableId, req.auth!.companyId]
      );
      if (Number(ordCheck.rows[0]?.cnt || 0) > 0) {
        return { blocked: true, count: Number(ordCheck.rows[0].cnt) };
      }

      const delRes = await client.query(
        `DELETE FROM public.dining_tables WHERE id = $1 AND company_id = $2 RETURNING id`,
        [tableId, req.auth!.companyId]
      );
      return { blocked: false, deleted: delRes.rows.length > 0 };
    });

    if (result.blocked) {
      res.status(409).json({
        success: false,
        error: {
          code: 'TABLE_HAS_HISTORY',
          message: `Suppression refusée : ${result.count} commande(s) sont rattachées à l'historique de cette table. Désactivez la table pour conserver l'intégrité de l'historique.`,
        },
      });
      return;
    }

    if (!result.deleted) {
      res.status(404).json({ success: false, error: 'Table introuvable' });
      return;
    }

    res.json({ success: true, message: 'Table supprimée avec succès' });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.get('/tables/:id/history', async (req, res, next) => {
  try {
    const tableId = req.params.id;
    const history = await withTenantContext(req.auth!, async (client) => {
      const ordersRes = await client.query(
        `SELECT qo.*,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'id', qoi.id,
                      'productName', qoi.product_name_snapshot,
                      'quantity', qoi.quantity,
                      'unitPrice', qoi.unit_price,
                      'subtotal', qoi.subtotal,
                      'itemNote', qoi.item_note,
                      'customMessage', qoi.custom_message
                    )
                  ) FILTER (WHERE qoi.id IS NOT NULL),
                  '[]'::json
                ) AS items
         FROM public.qr_orders qo
         LEFT JOIN public.qr_order_items qoi ON qoi.qr_order_id = qo.id AND qoi.company_id = qo.company_id
         WHERE qo.table_id = $1 AND qo.company_id = $2
         GROUP BY qo.id
         ORDER BY qo.created_at DESC
         LIMIT 50`,
        [tableId, req.auth!.companyId]
      );
      return ordersRes.rows;
    });

    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.get('/tables/:id/qrcode.svg', async (req, res, next) => {
  try {
    const tableId = req.params.id;
    const origin = `${req.protocol}://${req.get('host') || 'myrestogest.com'}`;

    const svgData = await withTenantContext(req.auth!, async (client) => {
      const tRes = await client.query(
        `SELECT dt.*, c.name AS company_name, qms.display_name, qms.primary_color, qms.footer_note
         FROM public.dining_tables dt
         JOIN public.companies c ON c.id = dt.company_id
         LEFT JOIN public.qr_menu_settings qms ON qms.company_id = dt.company_id
         WHERE dt.id = $1 AND dt.company_id = $2`,
        [tableId, req.auth!.companyId]
      );
      if (tRes.rows.length === 0) return null;
      const row = tRes.rows[0];
      const menuUrl = `${origin}/menu/${row.qr_token}`;
      return generateTableQrPosterSvg({
        companyName: row.display_name || row.company_name,
        tableName: row.name,
        tableCode: row.code,
        zone: row.zone,
        menuUrl,
        primaryColor: row.primary_color || '#ea580c',
        footerText: row.footer_note || 'Scannez pour consulter notre menu et commander',
      });
    });

    if (!svgData) {
      res.status(404).json({ success: false, error: 'Table introuvable' });
      return;
    }

    res.type('image/svg+xml').send(svgData);
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 2. PARAMÈTRES DU MENU DIGITAL & OPTIONS PRODUITS (MODULES 3 & 9)
// -------------------------------------------------------------
qrAdminRouter.get('/settings', async (req, res, next) => {
  try {
    const settings = await withTenantContext(req.auth!, async (client) => {
      await ensureDefaultCompanyTablesAndSettings(client, req.auth!.companyId);
      const sRes = await client.query(
        `SELECT * FROM public.qr_menu_settings WHERE company_id = $1`,
        [req.auth!.companyId]
      );
      return sRes.rows[0];
    });

    res.json({ success: true, data: settings });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.put('/settings', async (req, res, next) => {
  try {
    const schema = z.object({
      displayName: z.string().max(255).optional(),
      logoUrl: z.string().max(2000).optional().nullable(),
      coverUrl: z.string().max(2000).optional().nullable(),
      primaryColor: z.string().max(20).optional(),
      accentColor: z.string().max(20).optional(),
      phone: z.string().max(60).optional().nullable(),
      address: z.string().max(500).optional().nullable(),
      openingHours: z.string().max(500).optional(),
      welcomeMessage: z.string().max(1000).optional(),
      footerNote: z.string().max(500).optional(),
      qrOrderingEnabled: z.boolean().optional(),
      takeawayEnabled: z.boolean().optional(),
      autoAcceptOrders: z.boolean().optional(),
      callWaiterEnabled: z.boolean().optional(),
      requestBillEnabled: z.boolean().optional(),
      showPrices: z.boolean().optional(),
      estimatedPrepMinutes: z.number().int().min(0).max(240).optional(),
      hiddenCategoryIds: z.array(z.string()).optional(),
      categoryOrder: z.array(z.string()).optional(),
      hiddenProductIds: z.array(z.string()).optional(),
      productOrder: z.array(z.string()).optional(),
      productMetadata: z.record(z.any()).optional(),
    });
    const data = schema.parse(req.body);

    const updated = await withTenantContext(req.auth!, async (client) => {
      await ensureDefaultCompanyTablesAndSettings(client, req.auth!.companyId);
      const result = await client.query(
        `UPDATE public.qr_menu_settings
         SET display_name = COALESCE($1, display_name),
             logo_url = CASE WHEN $2::BOOLEAN THEN $3 ELSE logo_url END,
             cover_url = CASE WHEN $4::BOOLEAN THEN $5 ELSE cover_url END,
             primary_color = COALESCE($6, primary_color),
             accent_color = COALESCE($7, accent_color),
             phone = CASE WHEN $8::BOOLEAN THEN $9 ELSE phone END,
             address = CASE WHEN $10::BOOLEAN THEN $11 ELSE address END,
             opening_hours = COALESCE($12, opening_hours),
             welcome_message = COALESCE($13, welcome_message),
             footer_note = COALESCE($14, footer_note),
             qr_ordering_enabled = COALESCE($15, qr_ordering_enabled),
             takeaway_enabled = COALESCE($16, takeaway_enabled),
             auto_accept_orders = COALESCE($17, auto_accept_orders),
             call_waiter_enabled = COALESCE($18, call_waiter_enabled),
             request_bill_enabled = COALESCE($19, request_bill_enabled),
             show_prices = COALESCE($20, show_prices),
             estimated_prep_minutes = COALESCE($21, estimated_prep_minutes),
             hidden_category_ids = COALESCE($22::jsonb, hidden_category_ids),
             category_order = COALESCE($23::jsonb, category_order),
             hidden_product_ids = COALESCE($24::jsonb, hidden_product_ids),
             product_order = COALESCE($25::jsonb, product_order),
             product_metadata = COALESCE(product_metadata || $26::jsonb, product_metadata),
             updated_at = NOW()
         WHERE company_id = $27
         RETURNING *`,
        [
          data.displayName ?? null,
          data.logoUrl !== undefined,
          data.logoUrl ?? null,
          data.coverUrl !== undefined,
          data.coverUrl ?? null,
          data.primaryColor ?? null,
          data.accentColor ?? null,
          data.phone !== undefined,
          data.phone ?? null,
          data.address !== undefined,
          data.address ?? null,
          data.openingHours ?? null,
          data.welcomeMessage ?? null,
          data.footerNote ?? null,
          typeof data.qrOrderingEnabled === 'boolean' ? data.qrOrderingEnabled : null,
          typeof data.takeawayEnabled === 'boolean' ? data.takeawayEnabled : null,
          typeof data.autoAcceptOrders === 'boolean' ? data.autoAcceptOrders : null,
          typeof data.callWaiterEnabled === 'boolean' ? data.callWaiterEnabled : null,
          typeof data.requestBillEnabled === 'boolean' ? data.requestBillEnabled : null,
          typeof data.showPrices === 'boolean' ? data.showPrices : null,
          data.estimatedPrepMinutes ?? null,
          data.hiddenCategoryIds ? JSON.stringify(data.hiddenCategoryIds) : null,
          data.categoryOrder ? JSON.stringify(data.categoryOrder) : null,
          data.hiddenProductIds ? JSON.stringify(data.hiddenProductIds) : null,
          data.productOrder ? JSON.stringify(data.productOrder) : null,
          data.productMetadata ? JSON.stringify(data.productMetadata) : null,
          req.auth!.companyId,
        ]
      );
      return result.rows[0];
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.get('/options', async (req, res, next) => {
  try {
    const groups = await withTenantContext(req.auth!, async (client) => {
      const resGroups = await client.query(
        `SELECT pog.*, p.name AS product_name,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'id', pov.id,
                      'label', pov.label,
                      'priceDelta', pov.price_delta,
                      'isAvailable', pov.is_available,
                      'sortOrder', pov.sort_order
                    ) ORDER BY pov.sort_order ASC, pov.created_at ASC
                  ) FILTER (WHERE pov.id IS NOT NULL),
                  '[]'::json
                ) AS values
         FROM public.product_option_groups pog
         LEFT JOIN public.products p ON p.id = pog.product_id AND p.company_id = pog.company_id
         LEFT JOIN public.product_option_values pov ON pov.group_id = pog.id AND pov.company_id = pog.company_id
         WHERE pog.company_id = $1
         GROUP BY pog.id, p.name
         ORDER BY pog.sort_order ASC, pog.created_at ASC`,
        [req.auth!.companyId]
      );
      return resGroups.rows;
    });

    res.json({ success: true, data: groups });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/options/groups', async (req, res, next) => {
  try {
    const schema = z.object({
      productId: z.string().uuid().optional().nullable(),
      name: z.string().min(1).max(120),
      isRequired: z.boolean().default(false),
      selectionType: z.enum(['single', 'multiple']).optional(),
      allowMultiple: z.boolean().default(false),
      minChoices: z.number().int().min(0).default(0),
      maxChoices: z.number().int().min(1).default(1),
      allowCustomText: z.boolean().default(false),
      sortOrder: z.number().int().default(0),
      values: z
        .array(
          z.object({
            label: z.string().min(1).max(120),
            priceDelta: z.number().min(0).default(0),
            isDefault: z.boolean().default(false),
            isAvailable: z.boolean().default(true),
          })
        )
        .optional(),
    });
    const data = schema.parse(req.body);
    const isMultiple = data.selectionType === 'multiple' || Boolean(data.allowMultiple);
    const effectiveSelectionType = isMultiple ? 'multiple' : 'single';
    const effectiveMaxChoices = isMultiple ? Math.max(data.maxChoices, 2) : 1;

    const created = await withTenantContext(req.auth!, async (client) => {
      const gRes = await client.query(
        `INSERT INTO public.product_option_groups
           (company_id, product_id, name, is_required, selection_type, allow_multiple, min_choices, max_choices, allow_custom_text, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
         RETURNING *`,
        [
          req.auth!.companyId,
          data.productId || null,
          data.name.trim(),
          data.isRequired,
          effectiveSelectionType,
          isMultiple,
          data.isRequired && data.minChoices === 0 ? 1 : data.minChoices,
          effectiveMaxChoices,
          data.allowCustomText,
          data.sortOrder,
        ]
      );
      const group = gRes.rows[0];
      const insertedValues = [];

      for (const [idx, val] of (data.values || []).entries()) {
        const vRes = await client.query(
          `INSERT INTO public.product_option_values (company_id, group_id, label, price_delta, is_default, is_available, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [req.auth!.companyId, group.id, val.label.trim(), val.priceDelta, Boolean(val.isDefault), val.isAvailable, idx]
        );
        insertedValues.push(vRes.rows[0]);
      }

      return { ...group, values: insertedValues };
    });

    res.status(201).json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/options/groups/:id/values', async (req, res, next) => {
  try {
    const groupId = req.params.id;
    const schema = z.object({
      label: z.string().min(1).max(120),
      priceDelta: z.number().min(0).default(0),
      isAvailable: z.boolean().default(true),
      sortOrder: z.number().int().default(0),
    });
    const data = schema.parse(req.body);

    const created = await withTenantContext(req.auth!, async (client) => {
      const vRes = await client.query(
        `INSERT INTO public.product_option_values (company_id, group_id, label, price_delta, is_available, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [req.auth!.companyId, groupId, data.label.trim(), data.priceDelta, data.isAvailable, data.sortOrder]
      );
      return vRes.rows[0];
    });

    res.status(201).json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.delete('/options/groups/:id', async (req, res, next) => {
  try {
    const groupId = req.params.id;
    await withTenantContext(req.auth!, async (client) => {
      await client.query(
        `DELETE FROM public.product_option_groups WHERE id = $1 AND company_id = $2`,
        [groupId, req.auth!.companyId]
      );
    });
    res.json({ success: true, message: 'Groupe d\'options supprimé' });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.delete('/options/values/:id', async (req, res, next) => {
  try {
    const valueId = req.params.id;
    await withTenantContext(req.auth!, async (client) => {
      await client.query(
        `DELETE FROM public.product_option_values WHERE id = $1 AND company_id = $2`,
        [valueId, req.auth!.companyId]
      );
    });
    res.json({ success: true, message: 'Option supprimée' });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 3. COMMANDES EN TEMPS RÉEL, ÉCRAN CUISINE (KDS) & CAISSE (MODULES 5 & 7)
// -------------------------------------------------------------
qrAdminRouter.get('/orders', async (req, res, next) => {
  try {
    const { status, tableId, includeClosed = 'true', limit = '60' } = req.query;

    const payload = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT qo.*,
               s.status AS sale_status,
               COALESCE((SELECT SUM(p.amount) FROM public.payments p WHERE p.sale_id = qo.linked_sale_id), 0) AS paid_amount,
               ROUND(EXTRACT(EPOCH FROM (NOW() - qo.created_at)) / 60)::INT AS elapsed_minutes
        FROM public.qr_orders qo
        LEFT JOIN public.sales s ON s.id = qo.linked_sale_id AND s.company_id = qo.company_id
        WHERE qo.company_id = $1
      `;
      const params: any[] = [req.auth!.companyId];

      if (status) {
        params.push(status);
        query += ` AND qo.status = $${params.length}`;
      }
      if (tableId) {
        params.push(tableId);
        query += ` AND qo.table_id = $${params.length}`;
      }
      if (includeClosed === 'false') {
        query += ` AND qo.closed_at IS NULL`;
      }

      params.push(parseInt(limit as string, 10) || 60);
      query += ` ORDER BY qo.created_at DESC LIMIT $${params.length}`;

      const ordersRes = await client.query(query, params);
      const orders = ordersRes.rows;

      if (orders.length > 0) {
        const orderIds = orders.map((o: any) => o.id);
        const itemsRes = await client.query(
          `SELECT qoi.*,
                  COALESCE(
                    json_agg(
                      json_build_object(
                        'id', qoio.id,
                        'groupName', qoio.group_name_snapshot,
                        'optionLabel', qoio.option_label_snapshot,
                        'priceDelta', qoio.price_delta_snapshot
                      )
                    ) FILTER (WHERE qoio.id IS NOT NULL),
                    '[]'::json
                  ) AS options
           FROM public.qr_order_items qoi
           LEFT JOIN public.qr_order_item_options qoio ON qoio.qr_order_item_id = qoi.id AND qoio.company_id = qoi.company_id
           WHERE qoi.company_id = $1 AND qoi.qr_order_id = ANY($2::UUID[])
           GROUP BY qoi.id
           ORDER BY qoi.created_at ASC`,
          [req.auth!.companyId, orderIds]
        );

        const itemsByOrder = new Map<string, any[]>();
        for (const item of itemsRes.rows) {
          const list = itemsByOrder.get(item.qr_order_id) || [];
          list.push(item);
          itemsByOrder.set(item.qr_order_id, list);
        }

        for (const ord of orders) {
          ord.items = itemsByOrder.get(ord.id) || [];
          ord.paid_amount = parseFloat(ord.paid_amount || 0);
          ord.remaining_amount = Math.max(
            0,
            Math.round((parseFloat(ord.total_amount) - ord.paid_amount) * 100) / 100
          );
        }
      }

      const requestsRes = await client.query(
        `SELECT * FROM public.table_service_requests
         WHERE company_id = $1 AND status <> 'resolved'
         ORDER BY created_at DESC LIMIT 30`,
        [req.auth!.companyId]
      );

      return {
        orders,
        serviceRequests: requestsRes.rows,
      };
    });

    res.json({ success: true, data: payload });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/orders/:id/status', async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const schema = z.object({
      status: z.enum(['accepted', 'preparing', 'ready', 'served', 'rejected', 'cancelled']),
      reason: z.string().max(500).optional(),
    });
    const data = schema.parse(req.body);

    const updated = await withTenantContext(req.auth!, async (client) => {
      const ordRes = await client.query(
        `SELECT * FROM public.qr_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [orderId, req.auth!.companyId]
      );
      if (ordRes.rows.length === 0) return null;
      const order = ordRes.rows[0];

      if (order.status === 'rejected' || order.status === 'cancelled') {
        throw new Error(`Cette commande est déjà au statut ${order.status}`);
      }

      let linkedSaleId: string | null = order.linked_sale_id;

      // Si la commande est acceptée/préparée/prête/servie, créer une seule vente pending si pas encore liée
      if (['accepted', 'preparing', 'ready', 'served'].includes(data.status) && !linkedSaleId) {
        linkedSaleId = await createLinkedPendingSaleForQrOrder(
          client,
          req.auth!.companyId,
          req.auth!.userId,
          order.id
        );
      }

      // Si la commande est refusée ou annulée et qu'une vente existait, l'annuler proprement via cancel_sale()
      let nextPaymentStatus = order.payment_status;
      if (['rejected', 'cancelled'].includes(data.status) && linkedSaleId) {
        const sCheck = await client.query(
          `SELECT status FROM public.sales WHERE id = $1 AND company_id = $2`,
          [linkedSaleId, req.auth!.companyId]
        );
        if (sCheck.rows[0]?.status && sCheck.rows[0].status !== 'cancelled') {
          await client.query(`SELECT public.cancel_sale($1::UUID, $2::TEXT)`, [
            linkedSaleId,
            data.reason || `Commande QR ${data.status}`,
          ]);
          if (sCheck.rows[0].status === 'completed') {
            nextPaymentStatus = 'refunded';
          }
        }
      }

      const updRes = await client.query(
        `UPDATE public.qr_orders
         SET status = $1::VARCHAR,
             rejection_reason = COALESCE($2, rejection_reason),
             payment_status = $3,
             accepted_at = CASE WHEN $1::VARCHAR IN ('accepted', 'preparing', 'ready', 'served') AND accepted_at IS NULL THEN NOW() ELSE accepted_at END,
             preparing_at = CASE WHEN $1::VARCHAR IN ('preparing', 'ready', 'served') AND preparing_at IS NULL THEN NOW() ELSE preparing_at END,
             ready_at = CASE WHEN $1::VARCHAR IN ('ready', 'served') AND ready_at IS NULL THEN NOW() ELSE ready_at END,
             served_at = CASE WHEN $1::VARCHAR = 'served' AND served_at IS NULL THEN NOW() ELSE served_at END
         WHERE id = $4 AND company_id = $5
         RETURNING *`,
        [data.status, data.reason || null, nextPaymentStatus, order.id, req.auth!.companyId]
      );

      await client.query(
        `INSERT INTO public.qr_order_status_history (company_id, qr_order_id, old_status, new_status, changed_by, note)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.auth!.companyId,
          order.id,
          order.status,
          data.status,
          req.auth!.userId,
          data.reason || null,
        ]
      );

      if (order.table_id) {
        const tableStatusMap: Record<string, string> = {
          accepted: 'occupied',
          preparing: 'in_preparation',
          ready: 'ready',
          served: 'occupied',
          rejected: 'free',
          cancelled: 'free',
        };
        const nextTableStatus = tableStatusMap[data.status];
        if (nextTableStatus) {
          await client.query(
            `UPDATE public.dining_tables
             SET current_status = $1, updated_at = NOW()
             WHERE id = $2 AND company_id = $3`,
            [nextTableStatus, order.table_id, req.auth!.companyId]
          );
        }
      }

      return updRes.rows[0];
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Commande QR introuvable' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/orders/:id/pay', async (req, res, next) => {
  try {
    const orderId = req.params.id;
    const schema = z.object({
      amount: z.number().positive().optional(),
      paymentMethod: z.enum(['cash', 'card', 'mobile_money', 'wave', 'orange_money', 'transfer', 'check', 'other']),
      reference: z.string().max(100).optional().nullable(),
    });
    const data = schema.parse(req.body);

    const result = await withTenantContext(req.auth!, async (client) => {
      const ordRes = await client.query(
        `SELECT * FROM public.qr_orders WHERE id = $1 AND company_id = $2 FOR UPDATE`,
        [orderId, req.auth!.companyId]
      );
      if (ordRes.rows.length === 0) return { notFound: true };
      const order = ordRes.rows[0];

      if (order.payment_status === 'paid') {
        return { alreadyPaid: true };
      }

      if (['rejected', 'cancelled'].includes(order.status)) {
        throw new Error('Impossible d\'encaisser une commande refusée ou annulée');
      }

      let saleId: string = order.linked_sale_id;
      if (!saleId) {
        saleId = await createLinkedPendingSaleForQrOrder(
          client,
          req.auth!.companyId,
          req.auth!.userId,
          order.id
        );
      }

      const cashRes = await client.query(
        `SELECT id FROM public.cash_sessions WHERE company_id = $1 AND status = 'open' ORDER BY opened_at DESC LIMIT 1`,
        [req.auth!.companyId]
      );
      const activeCashSessionId = cashRes.rows[0]?.id || null;

      await client.query(
        `UPDATE public.sales
         SET cash_session_id = COALESCE(cash_session_id, $1)
         WHERE id = $2 AND company_id = $3 AND status = 'pending'`,
        [activeCashSessionId, saleId, req.auth!.companyId]
      );

      const orderTotal = parseFloat(order.total_amount || 0);
      const effectiveAmount = data.amount ?? orderTotal;
      const dbPaymentMethod = ['wave', 'orange_money'].includes(data.paymentMethod)
        ? 'mobile_money'
        : data.paymentMethod;
      const effectiveRef =
        data.reference ||
        (data.paymentMethod === 'wave' ? 'Wave' : data.paymentMethod === 'orange_money' ? 'Orange Money' : null);

      await client.query(
        `INSERT INTO public.payments (company_id, sale_id, cash_session_id, payment_method, amount, reference)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.auth!.companyId,
          saleId,
          activeCashSessionId,
          dbPaymentMethod,
          effectiveAmount,
          effectiveRef,
        ]
      );

      const paidRes = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_paid FROM public.payments WHERE sale_id = $1 AND company_id = $2`,
        [saleId, req.auth!.companyId]
      );
      const totalPaid = parseFloat(paidRes.rows[0]?.total_paid || 0);

      let paymentStatus = 'partial';
      if (Math.abs(totalPaid - orderTotal) < 0.01 || totalPaid >= orderTotal) {
        const sCheck = await client.query(
          `SELECT status FROM public.sales WHERE id = $1 AND company_id = $2`,
          [saleId, req.auth!.companyId]
        );
        if (sCheck.rows[0]?.status === 'pending') {
          await client.query(`SELECT public.complete_sale($1::UUID)`, [saleId]);
        }
        paymentStatus = 'paid';
      }

      const nextOrderStatus = order.status === 'received' ? 'accepted' : order.status;
      const paidAtIso = paymentStatus === 'paid' ? new Date().toISOString() : null;
      const updOrd = await client.query(
        `UPDATE public.qr_orders
         SET payment_status = $1,
             payment_method = $2,
             payment_reference = $3,
             paid_at = COALESCE($4::TIMESTAMPTZ, paid_at),
             status = $5,
             accepted_at = COALESCE(accepted_at, NOW())
         WHERE id = $6 AND company_id = $7
         RETURNING *`,
        [paymentStatus, data.paymentMethod, effectiveRef, paidAtIso, nextOrderStatus, order.id, req.auth!.companyId]
      );

      return {
        notFound: false,
        alreadyPaid: false,
        order: updOrd.rows[0],
        saleId,
        totalPaid,
        paymentStatus,
      };
    });

    if (result.notFound) {
      res.status(404).json({ success: false, error: { code: 'ORDER_NOT_FOUND', message: 'Commande QR introuvable' } });
      return;
    }
    if (result.alreadyPaid) {
      res.status(409).json({
        success: false,
        error: { code: 'ALREADY_PAID', message: 'Cette commande QR a déjà été encaissée.' },
      });
      return;
    }

    res.status(200).json({
      success: true,
      message:
        result.paymentStatus === 'paid'
          ? 'Paiement enregistré, vente comptabilisée et stocks déduits atomiquement'
          : 'Acompte enregistré sur la commande',
      data: {
        ...result.order,
        order: result.order,
        saleId: result.saleId,
        totalPaid: result.totalPaid,
        paymentStatus: result.paymentStatus,
      },
    });
  } catch (error) {
    next(error);
  }
});

qrAdminRouter.post('/service-requests/:id/resolve', async (req, res, next) => {
  try {
    const reqId = req.params.id;
    const updated = await withTenantContext(req.auth!, async (client) => {
      const rRes = await client.query(
        `UPDATE public.table_service_requests
         SET status = 'resolved', resolved_at = NOW()
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [reqId, req.auth!.companyId]
      );
      return rRes.rows[0] || null;
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Demande introuvable' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 4. STATISTIQUES ET ANALYSES COMMERCIALES DIGITALES (MODULE 10)
// -------------------------------------------------------------
qrAdminRouter.get('/analytics', async (req, res, next) => {
  try {
    const { period = 'month', startDate, endDate } = req.query;

    const stats = await withTenantContext(req.auth!, async (client) => {
      let dateFilterSql = `qo.created_at >= NOW() - INTERVAL '30 days'`;
      const params: any[] = [req.auth!.companyId];

      if (period === 'today') {
        dateFilterSql = `qo.created_at >= CURRENT_DATE`;
      } else if (period === 'yesterday') {
        dateFilterSql = `qo.created_at >= CURRENT_DATE - INTERVAL '1 day' AND qo.created_at < CURRENT_DATE`;
      } else if (period === 'week') {
        dateFilterSql = `qo.created_at >= NOW() - INTERVAL '7 days'`;
      } else if (period === 'custom' && startDate && endDate) {
        params.push(startDate, endDate);
        dateFilterSql = `qo.created_at >= $2::TIMESTAMPTZ AND qo.created_at <= $3::TIMESTAMPTZ`;
      }

      const summaryRes = await client.query(
        `SELECT
           COUNT(*)::INT AS total_orders,
           COUNT(*) FILTER (WHERE qo.order_type = 'takeaway')::INT AS takeaway_orders,
           COUNT(*) FILTER (WHERE qo.order_type <> 'takeaway')::INT AS dine_in_orders,
           COALESCE(SUM(qo.total_amount) FILTER (WHERE qo.status NOT IN ('rejected', 'cancelled')), 0) AS total_sold_amount,
           COALESCE((
             SELECT SUM(p.amount)
             FROM public.payments p
             JOIN public.qr_orders qo2 ON qo2.linked_sale_id = p.sale_id AND qo2.company_id = p.company_id
             WHERE qo2.company_id = $1
               AND qo2.status NOT IN ('rejected', 'cancelled')
               AND ${dateFilterSql.replace(/qo\./g, 'qo2.')}
           ), 0) AS total_collected_amount,
           ROUND(AVG(EXTRACT(EPOCH FROM (qo.ready_at - qo.accepted_at)) / 60) FILTER (
             WHERE qo.ready_at IS NOT NULL AND qo.accepted_at IS NOT NULL AND qo.ready_at >= qo.accepted_at
           ), 1) AS avg_prep_minutes
         FROM public.qr_orders qo
         WHERE qo.company_id = $1 AND ${dateFilterSql}`,
        params
      );

      const byStatusRes = await client.query(
        `SELECT qo.status, COUNT(*)::INT AS count, COALESCE(SUM(qo.total_amount), 0) AS amount
         FROM public.qr_orders qo
         WHERE qo.company_id = $1 AND ${dateFilterSql}
         GROUP BY qo.status`,
        params
      );

      const byTableRes = await client.query(
        `SELECT qo.table_code_snapshot AS table_code,
                qo.table_name_snapshot AS table_name,
                COUNT(*)::INT AS orders_count,
                COALESCE(SUM(qo.total_amount) FILTER (WHERE qo.status NOT IN ('rejected', 'cancelled')), 0) AS revenue
         FROM public.qr_orders qo
         WHERE qo.company_id = $1 AND ${dateFilterSql}
         GROUP BY qo.table_code_snapshot, qo.table_name_snapshot
         ORDER BY orders_count DESC, revenue DESC
         LIMIT 15`,
        params
      );

      const topProductsRes = await client.query(
        `SELECT qoi.product_name_snapshot AS product_name,
                SUM(qoi.quantity)::NUMERIC(14,2) AS total_qty,
                SUM(qoi.subtotal)::NUMERIC(14,2) AS total_revenue
         FROM public.qr_order_items qoi
         JOIN public.qr_orders qo ON qo.id = qoi.qr_order_id AND qo.company_id = qoi.company_id
         WHERE qo.company_id = $1
           AND qo.status NOT IN ('rejected', 'cancelled')
           AND ${dateFilterSql}
         GROUP BY qoi.product_name_snapshot
         ORDER BY total_qty DESC, total_revenue DESC
         LIMIT 10`,
        params
      );

      const topCategoriesRes = await client.query(
        `SELECT COALESCE(c.name, 'Autres') AS category_name,
                SUM(qoi.quantity)::NUMERIC(14,2) AS total_qty,
                SUM(qoi.subtotal)::NUMERIC(14,2) AS total_revenue
         FROM public.qr_order_items qoi
         JOIN public.qr_orders qo ON qo.id = qoi.qr_order_id AND qo.company_id = qoi.company_id
         JOIN public.products p ON p.id = qoi.product_id AND p.company_id = qoi.company_id
         LEFT JOIN public.categories c ON c.id = p.category_id AND c.company_id = p.company_id
         WHERE qo.company_id = $1
           AND qo.status NOT IN ('rejected', 'cancelled')
           AND ${dateFilterSql}
         GROUP BY COALESCE(c.name, 'Autres')
         ORDER BY total_revenue DESC`,
        params
      );

      const peakHoursRes = await client.query(
        `SELECT EXTRACT(HOUR FROM qo.created_at)::INT AS hour_of_day,
                COUNT(*)::INT AS orders_count
         FROM public.qr_orders qo
         WHERE qo.company_id = $1
           AND qo.status NOT IN ('rejected', 'cancelled')
           AND ${dateFilterSql}
         GROUP BY EXTRACT(HOUR FROM qo.created_at)::INT
         ORDER BY orders_count DESC`,
        params
      );

      const sumRow = summaryRes.rows[0] || {};
      const sold = parseFloat(sumRow.total_sold_amount || 0);
      const collected = parseFloat(sumRow.total_collected_amount || 0);

      return {
        summary: {
          totalOrders: Number(sumRow.total_orders || 0),
          takeawayOrders: Number(sumRow.takeaway_orders || 0),
          dineInOrders: Number(sumRow.dine_in_orders || 0),
          totalSoldAmount: sold,
          totalCollectedAmount: collected,
          remainingToPayAmount: Math.max(0, Math.round((sold - collected) * 100) / 100),
          avgPrepMinutes: sumRow.avg_prep_minutes !== null ? parseFloat(sumRow.avg_prep_minutes) : null,
        },
        byStatus: byStatusRes.rows,
        byTable: byTableRes.rows,
        topProducts: topProductsRes.rows,
        topCategories: topCategoriesRes.rows,
        peakHours: peakHoursRes.rows,
      };
    });

    res.json({ success: true, data: stats });
  } catch (error) {
    next(error);
  }
});
