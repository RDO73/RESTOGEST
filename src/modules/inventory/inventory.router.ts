import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middlewares/auth-middleware.js';
import { withTenantContext } from '../../db/tenant-context.js';
import { requireActiveSubscriptionWriteAccess } from '../subscriptions/subscription-guard.service.js';

export const inventoryRouter = Router();

inventoryRouter.use(requireAuth);
inventoryRouter.use(requireActiveSubscriptionWriteAccess);
inventoryRouter.use((req, res, next) => {
  if (req.method.toUpperCase() === 'GET') {
    requirePermission('inventory:read', 'reports:read')(req, res, next);
  } else {
    requirePermission('inventory:write')(req, res, next);
  }
});

// -------------------------------------------------------------
// 1. NIVEAUX DE STOCKS ACTUELS
// -------------------------------------------------------------
inventoryRouter.get('/levels', async (req, res, next) => {
  try {
    const { search, categoryId, lowStockOnly, limit = '100', offset = '0' } = req.query;

    const levels = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT sl.product_id, p.name as product_name, p.product_type,
                c.id as category_id, c.name as category_name,
                p.unit, p.cost_price as pmp, p.selling_price, p.min_stock_alert,
                sl.current_quantity, sl.updated_at,
                (sl.current_quantity <= p.min_stock_alert) as is_low_stock,
                ROUND(sl.current_quantity * p.cost_price, 2) as stock_valuation
         FROM public.stock_levels sl
         JOIN public.products p ON p.id = sl.product_id
         LEFT JOIN public.categories c ON c.id = p.category_id
         WHERE 1=1
      `;
      const params: any[] = [];

      if (search) {
        params.push(`%${search}%`);
        query += ` AND p.name ILIKE $${params.length}`;
      }

      if (categoryId) {
        params.push(categoryId);
        query += ` AND p.category_id = $${params.length}`;
      }

      if (lowStockOnly === 'true') {
        query += ` AND sl.current_quantity <= p.min_stock_alert`;
      }

      query += ` ORDER BY (sl.current_quantity <= p.min_stock_alert) DESC, p.name ASC`;

      params.push(parseInt(limit as string, 10));
      query += ` LIMIT $${params.length}`;

      params.push(parseInt(offset as string, 10));
      query += ` OFFSET $${params.length}`;

      const result = await client.query(query, params);
      return result.rows;
    });

    res.json({ success: true, data: levels });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 2. ALERTES DE STOCK FAIBLE OU RUPTURE
// -------------------------------------------------------------
inventoryRouter.get('/alerts', async (req, res, next) => {
  try {
    const alerts = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `SELECT sl.product_id, p.name as product_name, p.product_type,
                p.unit, p.min_stock_alert, sl.current_quantity,
                p.cost_price as pmp,
                CASE 
                  WHEN sl.current_quantity <= 0 THEN 'critical_out_of_stock'
                  ELSE 'low_stock'
                END as alert_level
         FROM public.stock_levels sl
         JOIN public.products p ON p.id = sl.product_id
         WHERE sl.current_quantity <= p.min_stock_alert
           AND p.inventory_tracking <> 'none'
         ORDER BY sl.current_quantity ASC, p.name ASC`
      );
      return result.rows;
    });

    res.json({ success: true, count: alerts.length, data: alerts });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 3. SYNTHÈSE GLOBALE & VALORISATION DU STOCK
// -------------------------------------------------------------
inventoryRouter.get('/summary', async (req, res, next) => {
  try {
    const summary = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `SELECT 
          COUNT(DISTINCT sl.product_id)::INT as tracked_products_count,
          COALESCE(SUM(sl.current_quantity * p.cost_price), 0) as total_inventory_valuation,
          COUNT(CASE WHEN sl.current_quantity <= p.min_stock_alert THEN 1 END)::INT as low_stock_count,
          COUNT(CASE WHEN sl.current_quantity <= 0 THEN 1 END)::INT as out_of_stock_count
         FROM public.stock_levels sl
         JOIN public.products p ON p.id = sl.product_id
         WHERE p.inventory_tracking <> 'none'`
      );
      return result.rows[0];
    });

    res.json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 4. HISTORIQUE DES MOUVEMENTS DE STOCKS
// -------------------------------------------------------------
inventoryRouter.get('/movements', async (req, res, next) => {
  try {
    const { productId, movementType, startDate, endDate, limit = '100', offset = '0' } = req.query;

    const movements = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT sm.id, sm.product_id, p.name as product_name, p.unit,
               sm.movement_type, sm.quantity_delta, sm.source_type,
               sm.source_id, sm.source_line_id, sm.notes, sm.created_at,
               u.full_name as author_name
        FROM public.stock_movements sm
        JOIN public.products p ON p.id = sm.product_id
        LEFT JOIN public.users u ON u.id = sm.user_id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (productId) {
        params.push(productId);
        query += ` AND sm.product_id = $${params.length}`;
      }

      if (movementType) {
        params.push(movementType);
        query += ` AND sm.movement_type = $${params.length}`;
      }

      if (startDate) {
        params.push(startDate);
        query += ` AND sm.created_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        query += ` AND sm.created_at <= $${params.length}`;
      }

      params.push(parseInt(limit as string, 10));
      query += ` ORDER BY sm.created_at DESC LIMIT $${params.length}`;

      params.push(parseInt(offset as string, 10));
      query += ` OFFSET $${params.length}`;

      const result = await client.query(query, params);
      return result.rows;
    });

    res.json({ success: true, data: movements });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 5. AJUSTEMENT MANUEL DE STOCK (Procédure SECURITY DEFINER)
// -------------------------------------------------------------
inventoryRouter.post('/adjustments', async (req, res, next) => {
  try {
    const schema = z.object({
      productId: z.string().uuid(),
      movementType: z.enum(['loss', 'adjustment', 'production_in']),
      quantityDelta: z.number().refine((val) => val !== 0, {
        message: 'La quantité delta ne peut pas être égale à 0',
      }),
      notes: z.string().min(2, { message: 'Une justification est requise pour tout ajustement manuel' }),
    });
    const data = schema.parse(req.body);

    const movement = await withTenantContext(req.auth!, async (client) => {
      const result = await client.query(
        `SELECT * FROM public.record_stock_adjustment(
          $1::UUID, $2::VARCHAR, $3::NUMERIC, $4::TEXT
        )`,
        [data.productId, data.movementType, data.quantityDelta, data.notes]
      );
      return result.rows[0];
    });

    res.status(201).json({
      success: true,
      message: 'Mouvement de stock enregistré et niveau mis à jour avec succès',
      data: movement,
    });
  } catch (error) {
    next(error);
  }
});
