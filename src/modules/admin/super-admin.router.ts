import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { adminPool, appPool, ensureDatabaseReady } from '../../db/pool.js';
import { hashPassword } from '../../auth/password.js';
import {
  clearAdminSessionCookie,
  generateSessionToken,
  markTokenRevoked,
  setAdminSessionCookie,
} from '../../auth/jwt.js';
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

    setAdminSessionCookie(res, session.token);

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
  clearAdminSessionCookie(res);
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

const createDemoEstablishmentSchema = z.object({
  companyName: z.string().min(2).max(160),
  email: z.string().email().max(180),
  password: z.string().min(8).max(128),
  countryCode: z.enum(['SN', 'GN']).default('SN'),
  status: z.enum(['active', 'trial']).default('trial'),
  fullName: z.string().min(2).max(120).optional(),
  businessType: z
    .enum(['restaurant', 'patisserie', 'cafe', 'boulangerie', 'traiteur'])
    .default('restaurant'),
  durationDays: z.number().int().min(1).max(365).optional(),
});

// Création directe d'un compte / établissement de démonstration par le Super-Admin
superAdminRouter.post('/establishments/demo', requireAuth, async (req, res, next) => {
  try {
    if (req.auth?.role !== 'SUPER_ADMIN') {
      res.status(403).json({
        success: false,
        error: { code: 'SUPER_ADMIN_REQUIRED', message: 'Accès réservé au Super-Admin.' },
      });
      return;
    }

    await ensureDatabaseReady();
    const parsed = createDemoEstablishmentSchema.parse(req.body);
    const normalizedEmail = parsed.email.trim().toLowerCase();
    const rawName = parsed.companyName.trim();
    const finalCompanyName = /d[ée]mo/i.test(rawName) ? rawName : `${rawName} (Démo)`;
    const countryCode = parsed.countryCode;
    const currency = countryCode === 'GN' ? 'GNF' : 'XOF';
    const fullName = parsed.fullName?.trim() || 'Gérant Démo';
    const durationDays = parsed.durationDays ?? (parsed.status === 'active' ? 30 : 14);

    const existingUser = await adminPool.query(
      `SELECT id FROM public.users WHERE lower(email) = $1 LIMIT 1`,
      [normalizedEmail]
    );
    if (existingUser.rows.length > 0) {
      res.status(409).json({
        success: false,
        error: {
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'Un compte utilisateur existe déjà avec cet e-mail.',
        },
      });
      return;
    }

    const passwordHash = await hashPassword(parsed.password);

    const regResult = await appPool.query(
      `SELECT company_id, user_id FROM public.register_company_and_owner(
        $1::VARCHAR, $2::VARCHAR, $3::VARCHAR, $4::VARCHAR, $5::TEXT, $6::VARCHAR
      )`,
      [
        finalCompanyName,
        parsed.businessType,
        currency,
        normalizedEmail,
        passwordHash,
        fullName,
      ]
    );

    const { company_id: companyId, user_id: userId } = regResult.rows[0];

    await adminPool.query(
      `UPDATE public.companies SET country_code = $2, currency = $3, is_active = TRUE WHERE id = $1`,
      [companyId, countryCode, currency]
    );
    await adminPool.query(
      `INSERT INTO public.company_settings (company_id, currency, country, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_id) DO UPDATE
       SET currency = EXCLUDED.currency, country = EXCLUDED.country, updated_at = NOW()`,
      [companyId, currency, countryCode]
    );

    await adminPool.query(
      `UPDATE public.company_subscriptions
       SET status = $2,
           plan_code = 'PRO',
           billing_period = 'monthly',
           trial_ends_at = NOW() + make_interval(days => $3),
           current_period_start = NOW(),
           current_period_end = NOW() + make_interval(days => $3),
           last_payment_method = 'admin_demo',
           last_payment_ref = 'DEMO-SUPERADMIN',
           updated_at = NOW()
       WHERE company_id = $1`,
      [companyId, parsed.status, durationDays]
    );

    res.status(201).json({
      success: true,
      data: {
        companyId,
        userId,
        companyName: finalCompanyName,
        email: normalizedEmail,
        countryCode,
        currency,
        status: parsed.status,
        durationDays,
      },
    });
  } catch (err) {
    next(err);
  }
});

