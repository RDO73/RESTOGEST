import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middlewares/auth-middleware.js';
import { withTenantContext } from '../../db/tenant-context.js';

export const salesRouter = Router();

salesRouter.use(requireAuth);
salesRouter.use((req, res, next) => {
  const method = req.method.toUpperCase();
  if (method === 'GET') {
    requirePermission('pos:read', 'reports:read', 'tables:read', 'cash:read')(req, res, next);
    return;
  }
  const pathStr = req.path || '';
  if (/\/(payments|complete|cancel)$/i.test(pathStr)) {
    requirePermission('pos:pay', 'cash:write')(req, res, next);
    return;
  }
  requirePermission('pos:write')(req, res, next);
});

// -------------------------------------------------------------
// 1. LISTE DES VENTES AVEC FILTRES AVANCÉS
// -------------------------------------------------------------
salesRouter.get('/', async (req, res, next) => {
  try {
    const { status, customerId, cashSessionId, startDate, endDate, limit = '50', offset = '0' } = req.query;

    const sales = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT s.id, s.invoice_number, s.status, s.notes, s.subtotal, s.tax_amount,
               s.discount_amount, s.total_amount, s.created_at, s.completed_at,
               c.id as customer_id, c.full_name as customer_name, c.phone as customer_phone,
               u.full_name as server_name,
               cs.id as cash_session_id,
               COALESCE((SELECT SUM(amount) FROM public.payments WHERE sale_id = s.id), 0) as paid_amount,
               COUNT(si.id)::INT as total_items_count
        FROM public.sales s
        LEFT JOIN public.customers c ON c.id = s.customer_id
        LEFT JOIN public.users u ON u.id = s.user_id
        LEFT JOIN public.cash_sessions cs ON cs.id = s.cash_session_id
        LEFT JOIN public.sale_items si ON si.sale_id = s.id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (status) {
        params.push(status);
        query += ` AND s.status = $${params.length}`;
      }

      if (customerId) {
        params.push(customerId);
        query += ` AND s.customer_id = $${params.length}`;
      }

      if (cashSessionId) {
        params.push(cashSessionId);
        query += ` AND s.cash_session_id = $${params.length}`;
      }

      if (startDate) {
        params.push(startDate);
        query += ` AND s.created_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        query += ` AND s.created_at <= $${params.length}`;
      }

      query += ` GROUP BY s.id, s.notes, c.id, c.full_name, c.phone, u.full_name, cs.id ORDER BY s.created_at DESC`;

      params.push(parseInt(limit as string, 10));
      query += ` LIMIT $${params.length}`;

      params.push(parseInt(offset as string, 10));
      query += ` OFFSET $${params.length}`;

      const result = await client.query(query, params);
      return result.rows;
    });

    res.json({ success: true, data: sales });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 2. DÉTAIL D'UNE VENTE
// -------------------------------------------------------------
salesRouter.get('/:id', async (req, res, next) => {
  try {
    const saleId = req.params.id;
    const sale = await withTenantContext(req.auth!, async (client) => {
      const saleRes = await client.query(
        `SELECT s.*, c.full_name as customer_name, c.phone as customer_phone, u.full_name as server_name
         FROM public.sales s
         LEFT JOIN public.customers c ON c.id = s.customer_id
         LEFT JOIN public.users u ON u.id = s.user_id
         WHERE s.id = $1`,
        [saleId]
      );

      if (saleRes.rows.length === 0) {
        return null;
      }

      const itemsRes = await client.query(
        `SELECT si.*, p.name as product_name, p.unit, p.inventory_tracking
         FROM public.sale_items si
         JOIN public.products p ON p.id = si.product_id
         WHERE si.sale_id = $1
         ORDER BY si.created_at ASC`,
        [saleId]
      );

      const paymentsRes = await client.query(
        `SELECT * FROM public.payments WHERE sale_id = $1 ORDER BY paid_at ASC`,
        [saleId]
      );

      const paidAmount = paymentsRes.rows.reduce((sum, p) => sum + parseFloat(p.amount), 0);

      return {
        ...saleRes.rows[0],
        paidAmount,
        items: itemsRes.rows,
        payments: paymentsRes.rows,
      };
    });

    if (!sale) {
      res.status(404).json({ success: false, error: 'Vente introuvable' });
      return;
    }

    res.json({ success: true, data: sale });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 3. CRÉATION D'UNE NOUVELLE VENTE (STATUT DRAFT / PENDING)
// -------------------------------------------------------------
salesRouter.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      cashSessionId: z.string().uuid().optional(),
      notes: z.string().optional(),
      discountAmount: z.number().min(0).default(0),
    });
    const data = schema.parse(req.body);

    const sale = await withTenantContext(req.auth!, async (client) => {
      // Si aucune session de caisse n'est passée, chercher la session ouverte de l'entreprise
      let sessionId = data.cashSessionId;
      if (!sessionId) {
        const activeSession = await client.query(
          `SELECT id FROM public.cash_sessions WHERE company_id = $1 AND status = 'open' LIMIT 1`,
          [req.auth!.companyId]
        );
        if (activeSession.rows.length > 0) {
          sessionId = activeSession.rows[0].id;
        }
      }

      const invoiceNumber = `FAC-${Date.now().toString().slice(-6)}`;

      const result = await client.query(
        `INSERT INTO public.sales (company_id, user_id, customer_id, cash_session_id, invoice_number, notes, discount_amount, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
         RETURNING *`,
        [
          req.auth!.companyId,
          req.auth!.userId,
          data.customerId || null,
          sessionId || null,
          invoiceNumber,
          data.notes || null,
          data.discountAmount,
        ]
      );
      return result.rows[0];
    });

    res.status(201).json({ success: true, data: sale });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 4. MISE À JOUR D'UNE VENTE EN COURS
// -------------------------------------------------------------
salesRouter.put('/:id', async (req, res, next) => {
  try {
    const saleId = req.params.id;
    const schema = z.object({
      customerId: z.string().uuid().optional(),
      notes: z.string().optional(),
      discountAmount: z.number().min(0).optional(),
    });
    const data = schema.parse(req.body);

    const updated = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `UPDATE public.sales
         SET customer_id = COALESCE($1, customer_id),
             notes = COALESCE($2, notes),
             discount_amount = COALESCE($3, discount_amount)
         WHERE id = $4
         RETURNING *`,
        [data.customerId, data.notes, data.discountAmount, saleId]
      );
      return result.rows[0];
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Vente introuvable' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 5. AJOUT D'UNE LIGNE D'ARTICLE
// -------------------------------------------------------------
salesRouter.post('/:id/items', async (req, res, next) => {
  try {
    const saleId = req.params.id;
    const schema = z.object({
      productId: z.string().uuid(),
      quantity: z.number().positive({ message: 'La quantité doit être strictement positive' }),
      unitPrice: z.number().min(0).optional(),
      notes: z.string().optional(),
    });
    const data = schema.parse(req.body);

    const item = await withTenantContext(req.auth!, async (client) => {
      // Récupérer le prix de vente par défaut si non spécifié
      let price = data.unitPrice;
      if (price === undefined) {
        const prod = await client.query(
          `SELECT selling_price FROM public.products WHERE id = $1`,
          [data.productId]
        );
        if (prod.rows.length === 0) {
          throw new Error('Produit introuvable');
        }
        price = parseFloat(prod.rows[0].selling_price);
      }

      const subtotal = Math.round(data.quantity * price * 100) / 100;

      const result = await client.query(
        `INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.auth!.companyId,
          saleId,
          data.productId,
          data.quantity,
          price,
          subtotal,
          data.notes || null,
        ]
      );
      return result.rows[0];
    });

    res.status(201).json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 6. SUPPRESSION D'UNE LIGNE D'ARTICLE
// -------------------------------------------------------------
salesRouter.delete('/:id/items/:itemId', async (req, res, next) => {
  try {
    const { id: saleId, itemId } = req.params;

    const deleted = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `DELETE FROM public.sale_items WHERE id = $1 AND sale_id = $2 RETURNING id`,
        [itemId, saleId]
      );
      return result.rows.length > 0;
    });

    if (!deleted) {
      res.status(404).json({ success: false, error: 'Ligne d\'article introuvable' });
      return;
    }

    res.json({ success: true, message: 'Article retiré de la vente' });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 7. ENREGISTREMENT D'UN PAIEMENT
// -------------------------------------------------------------
salesRouter.post('/:id/payments', async (req, res, next) => {
  try {
    const saleId = req.params.id;
    const schema = z.object({
      amount: z.number().positive({ message: 'Le montant du paiement doit être supérieur à 0' }),
      paymentMethod: z.enum(['cash', 'card', 'mobile_money', 'transfer', 'check', 'other']),
      reference: z.string().optional(),
    });
    const data = schema.parse(req.body);

    const payment = await withTenantContext(req.auth!, async (client) => {
      // Récupérer la session de caisse rattachée à la vente
      const sale = await client.query(
        `SELECT cash_session_id FROM public.sales WHERE id = $1`,
        [saleId]
      );
      const cashSessionId = sale.rows[0]?.cash_session_id || null;

      const result = await client.query(
        `INSERT INTO public.payments (company_id, sale_id, cash_session_id, amount, payment_method, reference)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          req.auth!.companyId,
          saleId,
          cashSessionId,
          data.amount,
          data.paymentMethod,
          data.reference || null,
        ]
      );
      return result.rows[0];
    });

    res.status(201).json({ success: true, data: payment });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 8. FINALISATION DE LA VENTE (Procédure SECURITY DEFINER complete_sale)
// -------------------------------------------------------------
salesRouter.post('/:id/complete', async (req, res, next) => {
  try {
    const saleId = req.params.id;

    const completed = await withTenantContext(req.auth!, async (client) => {
      await client.query(
        `SELECT public.complete_sale($1::UUID)`,
        [saleId]
      );

      const sRes = await client.query(
        `SELECT * FROM public.sales WHERE id = $1`,
        [saleId]
      );
      return sRes.rows[0];
    });

    res.json({
      success: true,
      message: 'Vente finalisée avec succès : totaux verrouillés et déstockage atomique effectué',
      data: completed,
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 9. ANNULATION D'UNE VENTE (Procédure SECURITY DEFINER cancel_sale)
// -------------------------------------------------------------
salesRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const saleId = req.params.id;
    const schema = z.object({
      reason: z.string().min(3, { message: 'Un motif d\'annulation de 3 caractères minimum est requis' }),
    });
    const data = schema.parse(req.body);

    const cancelled = await withTenantContext(req.auth!, async (client) => {
      await client.query(
        `SELECT public.cancel_sale($1::UUID, $2::TEXT)`,
        [saleId, data.reason]
      );

      const sRes = await client.query(
        `SELECT * FROM public.sales WHERE id = $1`,
        [saleId]
      );
      return sRes.rows[0];
    });

    res.json({
      success: true,
      message: 'Vente annulée avec succès : stocks réintégrés si la vente était finalisée',
      data: cancelled,
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 10. GÉNÉRATION DE TICKET DE CAISSE / REÇU
// -------------------------------------------------------------
salesRouter.get('/:id/receipt', async (req, res, next) => {
  try {
    const saleId = req.params.id;

    const receipt = await withTenantContext(req.auth!, async (client) => {
      const compRes = await client.query(
        `SELECT name, currency, default_tax_rate FROM public.companies WHERE id = $1`,
        [req.auth!.companyId]
      );
      const company = compRes.rows[0];

      const saleRes = await client.query(
        `SELECT s.*, u.full_name as server_name, c.full_name as customer_name, c.phone as customer_phone
         FROM public.sales s
         LEFT JOIN public.users u ON u.id = s.user_id
         LEFT JOIN public.customers c ON c.id = s.customer_id
         WHERE s.id = $1`,
        [saleId]
      );

      if (saleRes.rows.length === 0) return null;
      const sale = saleRes.rows[0];

      const itemsRes = await client.query(
        `SELECT si.*, p.name as product_name
         FROM public.sale_items si
         JOIN public.products p ON p.id = si.product_id
         WHERE si.sale_id = $1`,
        [saleId]
      );

      const paymentsRes = await client.query(
        `SELECT * FROM public.payments WHERE sale_id = $1 ORDER BY paid_at ASC`,
        [saleId]
      );

      return {
        company: {
          name: company.name,
          currency: company.currency,
          taxRate: company.default_tax_rate,
        },
        receiptHeader: {
          invoiceNumber: sale.invoice_number,
          date: sale.completed_at || sale.created_at,
          serverName: sale.server_name,
          customerName: sale.customer_name || 'Client Comptoir',
          customerPhone: sale.customer_phone || null,
          notes: sale.notes || null,
          status: sale.status,
        },
        items: itemsRes.rows.map((it) => ({
          productName: it.product_name,
          quantity: parseFloat(it.quantity),
          unitPrice: parseFloat(it.unit_price),
          subtotal: parseFloat(it.subtotal),
        })),
        totals: {
          subtotal: parseFloat(sale.subtotal),
          discountAmount: parseFloat(sale.discount_amount),
          taxAmount: parseFloat(sale.tax_amount),
          totalAmount: parseFloat(sale.total_amount),
        },
        payments: paymentsRes.rows.map((p) => ({
          method: p.payment_method,
          amount: parseFloat(p.amount),
          reference: p.reference,
          date: p.paid_at,
        })),
      };
    });

    if (!receipt) {
      res.status(404).json({ success: false, error: 'Vente introuvable' });
      return;
    }

    res.json({ success: true, data: receipt });
  } catch (error) {
    next(error);
  }
});
