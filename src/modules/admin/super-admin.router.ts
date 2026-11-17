import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { adminPool, ensureDatabaseReady } from '../../db/pool.js';
import { generateSessionToken, markTokenRevoked } from '../../auth/jwt.js';
import { requireAuth } from '../../middlewares/auth-middleware.js';

export const superAdminRouter = Router();

export const SUPER_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';
export const SUPER_ADMIN_PLATFORM_ID = '00000000-0000-0000-0000-000000000000';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function timingSafeTextEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Authentification exclusive du Propriétaire / Super-Admin
superAdminRouter.post('/auth/login', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const parsed = loginSchema.parse(req.body);
    const inputEmail = parsed.email.trim().toLowerCase();

    const emailMatch = timingSafeTextEqual(inputEmail, config.superAdmin.email);
    const passwordMatch = timingSafeTextEqual(parsed.password, config.superAdmin.password);

    if (!emailMatch || !passwordMatch) {
      res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_SUPER_ADMIN_CREDENTIALS',
          message: 'Identifiants Propriétaire / Super-Admin invalides.',
        },
      });
      return;
    }

    const session = generateSessionToken(SUPER_ADMIN_USER_ID, SUPER_ADMIN_PLATFORM_ID, {
      tenantId: SUPER_ADMIN_PLATFORM_ID,
      role: 'SUPER_ADMIN',
      email: config.superAdmin.email,
      fullName: config.superAdmin.fullName,
      companyName: 'RESTOGEST Plateforme SaaS',
      currency: 'XOF',
      isDemo: false,
    });

    res.json({
      success: true,
      data: {
        token: session.token,
        user: {
          id: SUPER_ADMIN_USER_ID,
          email: config.superAdmin.email,
          fullName: config.superAdmin.fullName,
          role: 'SUPER_ADMIN',
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

superAdminRouter.get('/auth/me', requireAuth, (req, res) => {
  if (req.auth?.role !== 'SUPER_ADMIN') {
    res.status(403).json({
      success: false,
      error: {
        code: 'SUPER_ADMIN_REQUIRED',
        message: 'Accès réservé au propriétaire de la plateforme RESTOGEST.',
      },
    });
    return;
  }

  res.json({
    success: true,
    data: {
      user: {
        id: req.auth.userId,
        email: req.auth.email,
        fullName: req.auth.fullName || config.superAdmin.fullName,
        role: 'SUPER_ADMIN',
      },
    },
  });
});

superAdminRouter.post('/auth/logout', requireAuth, (req, res) => {
  if (req.auth?.tokenHash) {
    markTokenRevoked(req.auth.tokenHash);
  }
  res.json({ success: true, message: 'Session Super-Admin fermée.' });
});

// Liste complète des établissements inscrits (Sénégal & Guinée) avec leur statut d'abonnement
superAdminRouter.get('/establishments', requireAuth, async (req, res, next) => {
  try {
    if (req.auth?.role !== 'SUPER_ADMIN') {
      res.status(403).json({
        success: false,
        error: { code: 'SUPER_ADMIN_REQUIRED', message: 'Accès réservé au Super-Admin.' },
      });
      return;
    }

    const countryFilter = req.query.countryCode ? String(req.query.countryCode).toUpperCase() : null;
    const statusFilter = req.query.status ? String(req.query.status).toLowerCase() : null;

    const client = await adminPool.connect();
    try {
      const params: any[] = [];
      const where: string[] = [`c.id <> '00000000-0000-0000-0000-000000000000'::UUID`];

      if (countryFilter) {
        params.push(countryFilter);
        where.push(`COALESCE(c.country_code, 'SN') = $${params.length}`);
      }
      if (statusFilter) {
        params.push(statusFilter);
        where.push(`COALESCE(cs.status, 'trial') = $${params.length}`);
      }

      const result = await client.query(
        `SELECT c.id, c.name, c.business_type, COALESCE(c.country_code, 'SN') AS country_code,
                c.currency, c.is_active, c.created_at,
                cs.id AS subscription_id, COALESCE(cs.plan_code, 'PRO') AS plan_code,
                COALESCE(cs.status, 'trial') AS subscription_status,
                COALESCE(cs.billing_period, 'monthly') AS billing_period,
                cs.current_period_end,
                cs.last_payment_method,
                cs.last_payment_ref,
                cs.last_payment_amount,
                (
                  SELECT u.email
                  FROM public.company_users cu
                  JOIN public.users u ON u.id = cu.user_id
                  WHERE cu.company_id = c.id
                  ORDER BY cu.user_id ASC
                  LIMIT 1
                ) AS owner_email,
                (
                  SELECT u.full_name
                  FROM public.company_users cu
                  JOIN public.users u ON u.id = cu.user_id
                  WHERE cu.company_id = c.id
                  ORDER BY cu.user_id ASC
                  LIMIT 1
                ) AS owner_name,
                (
                  SELECT COUNT(*)::INT
                  FROM public.saas_subscription_transactions tx
                  WHERE tx.company_id = c.id AND tx.status = 'pending'
                ) AS pending_payments_count
         FROM public.companies c
         LEFT JOIN public.company_subscriptions cs ON cs.company_id = c.id
         WHERE ${where.join(' AND ')}
         ORDER BY c.created_at DESC`,
        params
      );

      res.json({ success: true, data: result.rows });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

