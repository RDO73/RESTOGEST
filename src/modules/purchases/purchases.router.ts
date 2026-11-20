import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middlewares/auth-middleware.js';
import { withTenantContext } from '../../db/tenant-context.js';

export const purchasesRouter = Router();

purchasesRouter.use(requireAuth);
purchasesRouter.use((req, res, next) => {
  if (req.method.toUpperCase() === 'GET') {
    requirePermission('purchases:read', 'reports:read')(req, res, next);
  } else {
    requirePermission('purchases:write')(req, res, next);
  }
});

// -------------------------------------------------------------
// FOURNISSEURS (SUPPLIERS)
// -------------------------------------------------------------
purchasesRouter.get('/suppliers', async (req, res, next) => {
  try {
    const { search, limit = '50', offset = '0' } = req.query;

    const suppliers = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT s.id, s.name, s.email, s.phone, s.address, s.created_at,
               COUNT(p.id)::INT as total_orders_count,
               COALESCE(SUM(p.total_amount), 0) as total_spend
        FROM public.suppliers s
        LEFT JOIN public.purchases p ON p.supplier_id = s.id AND p.status = 'received'
        WHERE 1=1
      `;
      const params: any[] = [];

      if (search) {
        params.push(`%${search}%`);
        query += ` AND (s.name ILIKE $${params.length} OR s.email ILIKE $${params.length} OR s.phone ILIKE $${params.length})`;
      }

      query += ` GROUP BY s.id ORDER BY s.name ASC`;

      params.push(parseInt(limit as string, 10));
      query += ` LIMIT $${params.length}`;

      params.push(parseInt(offset as string, 10));
      query += ` OFFSET $${params.length}`;

      const result = await client.query(query, params);
      return result.rows;
    });

    res.json({ success: true, data: suppliers });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.get('/suppliers/:id', async (req, res, next) => {
  try {
    const supplierId = req.params.id;

    const supplier = await withTenantContext(req.auth!, async (client) => {
      const sRes = await client.query(
        `SELECT * FROM public.suppliers WHERE id = $1`,
        [supplierId]
      );
      if (sRes.rows.length === 0) return null;

      const purchasesRes = await client.query(
        `SELECT id, reference, status, total_amount, purchased_at, received_at
         FROM public.purchases
         WHERE supplier_id = $1
         ORDER BY purchased_at DESC
         LIMIT 20`,
        [supplierId]
      );

      return {
        ...sRes.rows[0],
        recentPurchases: purchasesRes.rows,
      };
    });

    if (!supplier) {
      res.status(404).json({ success: false, error: 'Fournisseur introuvable' });
      return;
    }

    res.json({ success: true, data: supplier });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.post('/suppliers', async (req, res, next) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(255),
      email: z.string().email().optional().or(z.literal('')),
      phone: z.string().max(50).optional().or(z.literal('')),
      address: z.string().optional().or(z.literal('')),
    });
    const data = schema.parse(req.body);

    const supplier = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `INSERT INTO public.suppliers (company_id, name, email, phone, address)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          req.auth!.companyId,
          data.name,
          data.email || null,
          data.phone || null,
          data.address || null,
        ]
      );
      return result.rows[0];
    });

    res.status(201).json({ success: true, data: supplier });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.put('/suppliers/:id', async (req, res, next) => {
  try {
    const supplierId = req.params.id;
    const schema = z.object({
      name: z.string().min(1).max(255).optional(),
      email: z.string().email().optional().or(z.literal('')),
      phone: z.string().max(50).optional().or(z.literal('')),
      address: z.string().optional().or(z.literal('')),
    });
    const data = schema.parse(req.body);

    const updated = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `UPDATE public.suppliers
         SET name = COALESCE($1, name),
             email = COALESCE($2, email),
             phone = COALESCE($3, phone),
             address = COALESCE($4, address)
         WHERE id = $5
         RETURNING *`,
        [
          data.name,
          data.email,
          data.phone,
          data.address,
          supplierId,
        ]
      );
      return result.rows[0];
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Fournisseur introuvable' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// COMMANDES ET ACHATS FOURNISSEURS
// -------------------------------------------------------------
purchasesRouter.get('/', async (req, res, next) => {
  try {
    const { supplierId, status, startDate, endDate, limit = '50', offset = '0' } = req.query;

    const purchases = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT p.id, p.reference, p.status, p.total_amount, p.purchased_at, p.received_at,
                s.name as supplier_name, s.phone as supplier_phone,
                COUNT(pi.id)::INT as items_count
         FROM public.purchases p
         LEFT JOIN public.suppliers s ON s.id = p.supplier_id
         LEFT JOIN public.purchase_items pi ON pi.purchase_id = p.id
         WHERE 1=1
      `;
      const params: any[] = [];

      if (supplierId) {
        params.push(supplierId);
        query += ` AND p.supplier_id = $${params.length}`;
      }

      if (status) {
        params.push(status);
        query += ` AND p.status = $${params.length}`;
      }

      if (startDate) {
        params.push(startDate);
        query += ` AND p.purchased_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        query += ` AND p.purchased_at <= $${params.length}`;
      }

      query += ` GROUP BY p.id, s.name, s.phone ORDER BY p.purchased_at DESC`;

      params.push(parseInt(limit as string, 10));
      query += ` LIMIT $${params.length}`;

      params.push(parseInt(offset as string, 10));
      query += ` OFFSET $${params.length}`;

      const result = await client.query(query, params);
      return result.rows;
    });

    res.json({ success: true, data: purchases });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.get('/:id', async (req, res, next) => {
  try {
    const purchaseId = req.params.id;

    const purchase = await withTenantContext(req.auth!, async (client) => {
      const pRes = await client.query(
        `SELECT p.*, s.name as supplier_name, s.phone as supplier_phone, s.email as supplier_email, s.address as supplier_address
         FROM public.purchases p
         LEFT JOIN public.suppliers s ON s.id = p.supplier_id
         WHERE p.id = $1`,
        [purchaseId]
      );

      if (pRes.rows.length === 0) return null;

      const itemsRes = await client.query(
        `SELECT pi.*, pr.name as product_name, pr.unit, pr.cost_price as current_product_pmp
         FROM public.purchase_items pi
         JOIN public.products pr ON pr.id = pi.product_id
         WHERE pi.purchase_id = $1
         ORDER BY pr.name ASC`,
        [purchaseId]
      );

      return {
        ...pRes.rows[0],
        items: itemsRes.rows,
      };
    });

    if (!purchase) {
      res.status(404).json({ success: false, error: 'Commande d\'achat introuvable' });
      return;
    }

    res.json({ success: true, data: purchase });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.post('/', async (req, res, next) => {
  try {
    const schema = z.object({
      supplierId: z.string().uuid().optional(),
      reference: z.string().min(1).max(100),
      notes: z.string().optional(),
    });
    const data = schema.parse(req.body);

    const purchase = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `INSERT INTO public.purchases (company_id, supplier_id, reference, notes, status, total_amount)
         VALUES ($1, $2, $3, $4, 'ordered', 0)
         RETURNING *`,
        [req.auth!.companyId, data.supplierId || null, data.reference, data.notes || null]
      );
      return result.rows[0];
    });

    res.status(201).json({ success: true, data: purchase });
  } catch (error) {
    next(error);
  }
});

purchasesRouter.put('/:id', async (req, res, next) => {
  try {
    const purchaseId = req.params.id;
    const schema = z.object({
      supplierId: z.string().uuid().optional(),
      reference: z.string().min(1).max(100).optional(),
      notes: z.string().optional(),
    });
    const data = schema.parse(req.body);

    const updated = await withTenantContext(req.auth!, async (client) => {
      // Vérifier que la commande n'est pas déjà reçue
      const check = await client.query(`SELECT status FROM public.purchases WHERE id = $1`, [purchaseId]);
      if (check.rows.length === 0) return null;
      if (check.rows[0].status === 'received') {
        throw new Error('Une commande déjà réceptionnée ne peut plus être modifiée');
      }

      const result = await client.query(
        `UPDATE public.purchases
         SET supplier_id = COALESCE($1, supplier_id),
             reference = COALESCE($2, reference),
             notes = COALESCE($3, notes)
         WHERE id = $4
         RETURNING *`,
        [data.supplierId, data.reference, data.notes, purchaseId]
      );
      return result.rows[0];
    });

    if (!updated) {
      res.status(404).json({ success: false, error: 'Commande d\'achat introuvable' });
      return;
    }

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
});

// Ajout d'une ligne d'achat
purchasesRouter.post('/:id/items', async (req, res, next) => {
  try {
    const purchaseId = req.params.id;
    const schema = z.object({
      productId: z.string().uuid(),
      quantity: z.number().positive({ message: 'La quantité doit être strictement positive' }),
      unitCost: z.number().min(0, { message: 'Le prix unitaire doit être positif ou nul' }),
    });
    const data = schema.parse(req.body);

    const subtotal = Math.round(data.quantity * data.unitCost * 100) / 100;

    const item = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `INSERT INTO public.purchase_items (company_id, purchase_id, product_id, quantity, unit_cost, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [req.auth!.companyId, purchaseId, data.productId, data.quantity, data.unitCost, subtotal]
      );

      // Mettre à jour le montant total de la commande
      await client.query(
        `UPDATE public.purchases
         SET total_amount = (SELECT COALESCE(SUM(subtotal), 0) FROM public.purchase_items WHERE purchase_id = $1)
         WHERE id = $1`,
        [purchaseId]
      );

      return result.rows[0];
    });

    res.status(201).json({ success: true, data: item });
  } catch (error) {
    next(error);
  }
});

// Modification d'une ligne d'achat
purchasesRouter.put('/:id/items/:itemId', async (req, res, next) => {
  try {
    const { id: purchaseId, itemId } = req.params;
    const schema = z.object({
      quantity: z.number().positive(),
      unitCost: z.number().min(0),
    });
    const data = schema.parse(req.body);

    const subtotal = Math.round(data.quantity * data.unitCost * 100) / 100;

    const updatedItem = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `UPDATE public.purchase_items
         SET quantity = $1, unit_cost = $2, subtotal = $3
         WHERE id = $4 AND purchase_id = $5
         RETURNING *`,
        [data.quantity, data.unitCost, subtotal, itemId, purchaseId]
      );

      if (result.rows.length === 0) return null;

      // Recalcul du total de la commande
      await client.query(
        `UPDATE public.purchases
         SET total_amount = (SELECT COALESCE(SUM(subtotal), 0) FROM public.purchase_items WHERE purchase_id = $1)
         WHERE id = $1`,
        [purchaseId]
      );

      return result.rows[0];
    });

    if (!updatedItem) {
      res.status(404).json({ success: false, error: 'Ligne d\'achat introuvable' });
      return;
    }

    res.json({ success: true, data: updatedItem });
  } catch (error) {
    next(error);
  }
});

// Suppression d'une ligne d'achat
purchasesRouter.delete('/:id/items/:itemId', async (req, res, next) => {
  try {
    const { id: purchaseId, itemId } = req.params;

    const deleted = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `DELETE FROM public.purchase_items
         WHERE id = $1 AND purchase_id = $2
         RETURNING id`,
        [itemId, purchaseId]
      );

      if (result.rows.length === 0) return false;

      // Recalcul du total de la commande
      await client.query(
        `UPDATE public.purchases
         SET total_amount = (SELECT COALESCE(SUM(subtotal), 0) FROM public.purchase_items WHERE purchase_id = $1)
         WHERE id = $1`,
        [purchaseId]
      );

      return true;
    });

    if (!deleted) {
      res.status(404).json({ success: false, error: 'Ligne d\'achat introuvable' });
      return;
    }

    res.json({ success: true, message: 'Ligne d\'achat supprimée' });
  } catch (error) {
    next(error);
  }
});

// Réception officielle d'un achat (calcul PMP & stocks via procédure stockée)
purchasesRouter.post('/:id/receive', async (req, res, next) => {
  try {
    const purchaseId = req.params.id;

    const receivedPurchase = await withTenantContext(req.auth!, async (client) => {
      await client.query(
        `SELECT public.receive_purchase($1::UUID)`,
        [purchaseId]
      );

      const pRes = await client.query(
        `SELECT * FROM public.purchases WHERE id = $1`,
        [purchaseId]
      );
      return pRes.rows[0];
    });

    res.json({
      success: true,
      message: 'Commande d\'achat réceptionnée : stocks incrémentés et PMP recalculé avec succès',
      data: receivedPurchase,
    });
  } catch (error) {
    next(error);
  }
});

// Annulation d'une commande d'achat (Procédure SECURITY DEFINER)
purchasesRouter.post('/:id/cancel', async (req, res, next) => {
  try {
    const purchaseId = req.params.id;
    const schema = z.object({
      reason: z.string().min(2, { message: 'Un motif d\'annulation est requis' }).optional(),
    });
    const data = schema.parse(req.body);

    const cancelled = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `SELECT * FROM public.cancel_purchase($1::UUID, $2::TEXT)`,
        [purchaseId, data.reason || null]
      );
      return result.rows[0];
    });

    res.json({
      success: true,
      message: 'Commande d\'achat annulée avec succès',
      data: cancelled,
    });
  } catch (error) {
    next(error);
  }
});
