import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middlewares/auth-middleware.js';
import { withTenantContext } from '../../db/tenant-context.js';
import { requireActiveSubscriptionWriteAccess } from '../subscriptions/subscription-guard.service.js';

export const customersRouter = Router();

customersRouter.use(requireAuth);
customersRouter.use(requireActiveSubscriptionWriteAccess);

customersRouter.get('/', requirePermission('customers:read'), async (req, res, next) => {
  try {
    const search = req.query.search ? String(req.query.search).trim() : '';
    const customers = await withTenantContext(req.auth!, async (client) => {
      const params: any[] = [];
      let where = '1=1';
      if (search) {
        params.push(`%${search}%`);
        where += ` AND (c.full_name ILIKE $${params.length} OR c.phone ILIKE $${params.length} OR c.email ILIKE $${params.length})`;
      }
      const resDb = await client.query(
        `SELECT c.id, c.full_name, c.phone, c.email, c.loyalty_points, c.created_at,
                COUNT(s.id) FILTER (WHERE s.status = 'completed')::INT AS orders_count,
                COALESCE(SUM(s.total_amount) FILTER (WHERE s.status = 'completed'), 0) AS total_spent
         FROM public.customers c
         LEFT JOIN public.sales s ON s.customer_id = c.id
         WHERE ${where}
         GROUP BY c.id
         ORDER BY c.created_at DESC
         LIMIT 200`,
        params
      );
      return resDb.rows;
    });
    res.json({ success: true, data: customers });
  } catch (error) {
    next(error);
  }
});

const customerSchema = z.object({
  fullName: z.string().min(2, 'Le nom du client est requis').max(255),
  phone: z.string().max(50).optional().or(z.literal('')),
  email: z.string().email('Adresse e-mail invalide').optional().or(z.literal('')),
  loyaltyPoints: z.number().int().min(0).optional(),
});

customersRouter.post('/', requirePermission('customers:write'), async (req, res, next) => {
  try {
    const data = customerSchema.parse(req.body);
    const created = await withTenantContext(req.auth!, async (client) => {
      const resDb = await client.query(
        `INSERT INTO public.customers (company_id, full_name, phone, email, loyalty_points)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [
          req.auth!.companyId,
          data.fullName.trim(),
          data.phone?.trim() || null,
          data.email?.trim() || null,
          data.loyaltyPoints ?? 0,
        ]
      );
      return resDb.rows[0];
    });
    res.status(201).json({ success: true, message: 'Client enregistré', data: created });
  } catch (error) {
    next(error);
  }
});

customersRouter.put('/:id', requirePermission('customers:write'), async (req, res, next) => {
  try {
    const customerId = z.string().uuid().parse(req.params.id);
    const data = customerSchema.partial().parse(req.body);
    const updated = await withTenantContext(req.auth!, async (client) => {
      const resDb = await client.query(
        `UPDATE public.customers
         SET full_name = COALESCE($2, full_name),
             phone = COALESCE($3, phone),
             email = COALESCE($4, email),
             loyalty_points = COALESCE($5, loyalty_points)
         WHERE id = $1
         RETURNING *`,
        [
          customerId,
          data.fullName !== undefined ? data.fullName.trim() : null,
          data.phone !== undefined ? (data.phone.trim() || null) : null,
          data.email !== undefined ? (data.email.trim() || null) : null,
          data.loyaltyPoints !== undefined ? data.loyaltyPoints : null,
        ]
      );
      return resDb.rows[0] || null;
    });
    if (!updated) {
      res.status(404).json({ success: false, error: 'Client introuvable' });
      return;
    }
    res.json({ success: true, message: 'Fiche client mise à jour', data: updated });
  } catch (error) {
    next(error);
  }
});
