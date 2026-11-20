import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../../config/env.js';
import { adminPool, appPool, ensureDatabaseReady } from '../../db/pool.js';
import { hashPassword } from '../../auth/password.js';
import {
  clearAdminSessionCookie,
  generateSessionToken,
  setAdminSessionCookie,
} from '../../auth/jwt.js';
import {
  persistAdminTokenRevocation,
  requireAuth,
  requireSuperAdmin,
} from '../../middlewares/auth-middleware.js';
import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailures,
} from '../../middlewares/rate-limit.js';

export const superAdminRouter = Router();

export const SUPER_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';
export const SUPER_ADMIN_PLATFORM_ID = '00000000-0000-0000-0000-000000000000';

interface AdminAuthEvent {
  created_at: string;
  action: string;
  table_name: string;
  company_name: string;
  user_email: string;
  new_values: Record<string, any>;
}
const adminSecurityEvents: AdminAuthEvent[] = [];
let adminEventsTableReady = false;

async function ensureAdminSecurityEventsTable(): Promise<void> {
  if (adminEventsTableReady) return;
  await adminPool.query(
    `CREATE TABLE IF NOT EXISTS public.admin_security_events (
       id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       action VARCHAR(100) NOT NULL,
       table_name VARCHAR(100) NOT NULL DEFAULT 'super_admin_security',
       company_name VARCHAR(255) NOT NULL DEFAULT 'RESTOGEST Plateforme',
       user_email VARCHAR(255) NOT NULL,
       new_values JSONB NOT NULL DEFAULT '{}'::jsonb
     )`
  );
  adminEventsTableReady = true;
}

function recordAdminSecurityEvent(action: string, details: Record<string, any>): void {
  const evt: AdminAuthEvent = {
    created_at: new Date().toISOString(),
    action,
    table_name: 'super_admin_security',
    company_name: 'RESTOGEST Plateforme',
    user_email: config.superAdmin.email,
    new_values: details,
  };
  adminSecurityEvents.unshift(evt);
  if (adminSecurityEvents.length > 100) adminSecurityEvents.pop();
  void (async () => {
    try {
      await ensureAdminSecurityEventsTable();
      await adminPool.query(
        `INSERT INTO public.admin_security_events (action, table_name, company_name, user_email, new_values)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [evt.action, evt.table_name, evt.company_name, evt.user_email, JSON.stringify(details)]
      );
    } catch {
      // non-blocking
    }
  })();
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function timingSafeTextEqual(a: string, b: string): boolean {
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Authentification exclusive du Propriétaire / Super-Admin (limitée à 5 échecs / 15 min)
superAdminRouter.post('/auth/login', checkLoginRateLimit('admin_login'), async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const parsed = loginSchema.parse(req.body);
    const inputEmail = parsed.email.trim().toLowerCase();

    const emailMatch = timingSafeTextEqual(inputEmail, config.superAdmin.email);
    const passwordMatch = timingSafeTextEqual(parsed.password, config.superAdmin.password);

    if (!emailMatch || !passwordMatch) {
      recordLoginFailure(req, 'admin_login');
      recordAdminSecurityEvent('SUPER_ADMIN_LOGIN_FAILED', { status: 'rejected' });
      res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_SUPER_ADMIN_CREDENTIALS',
          message: 'Identifiants invalides.',
        },
      });
      return;
    }

    resetLoginFailures(req, 'admin_login');
    recordAdminSecurityEvent('SUPER_ADMIN_LOGIN_SUCCESS', { status: 'authenticated' });

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

superAdminRouter.get('/auth/me', requireAuth, requireSuperAdmin, (req, res) => {
  res.json({
    success: true,
    data: {
      user: {
        id: req.auth!.userId,
        email: req.auth!.email,
        fullName: req.auth!.fullName || config.superAdmin.fullName,
        role: 'SUPER_ADMIN',
      },
    },
  });
});

superAdminRouter.post('/auth/logout', requireAuth, requireSuperAdmin, async (req, res) => {
  if (req.auth?.tokenHash) {
    await persistAdminTokenRevocation(req.auth.tokenHash);
  }
  clearAdminSessionCookie(res);
  recordAdminSecurityEvent('SUPER_ADMIN_LOGOUT', { status: 'revoked' });
  res.json({ success: true, message: 'Session Super-Admin fermée et révoquée.' });
});

// Liste complète des établissements inscrits (Sénégal & Guinée) avec leur statut d'abonnement
superAdminRouter.get('/establishments', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {

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
superAdminRouter.post('/establishments/demo', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
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

    try {
      await adminPool.query(
        `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
         VALUES ($1, NULL, 'SUPER_ADMIN_DEMO_CREATED', 'companies', $1, $2::jsonb)`,
        [
          companyId,
          JSON.stringify({
            actor: 'SUPER_ADMIN',
            companyName: finalCompanyName,
            countryCode,
            status: parsed.status,
          }),
        ]
      );
    } catch {
      // non-blocking
    }
    recordAdminSecurityEvent('SUPER_ADMIN_DEMO_CREATED', {
      companyId,
      companyName: finalCompanyName,
      countryCode,
    });

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

const toggleStatusSchema = z.object({
  isActive: z.boolean(),
  reason: z.string().max(300).optional(),
});

// Suspension ou réactivation directe d'un établissement par le Propriétaire
superAdminRouter.post(
  '/establishments/:companyId/status',
  requireAuth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      await ensureDatabaseReady();
      const companyId = z.string().uuid().parse(req.params.companyId);
      if (companyId === SUPER_ADMIN_PLATFORM_ID) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_TARGET', message: 'Impossible de modifier l’entité plateforme.' },
        });
        return;
      }

      const parsed = toggleStatusSchema.parse(req.body);
      const client = await adminPool.connect();
      try {
        const existing = await client.query(
          `SELECT id, name, is_active FROM public.companies WHERE id = $1 LIMIT 1`,
          [companyId]
        );
        if (existing.rows.length === 0) {
          res.status(404).json({
            success: false,
            error: { code: 'ESTABLISHMENT_NOT_FOUND', message: 'Établissement introuvable.' },
          });
          return;
        }

        const previousActive = Boolean(existing.rows[0].is_active);
        const companyName = String(existing.rows[0].name);

        await client.query(
          `UPDATE public.companies SET is_active = $2, updated_at = NOW() WHERE id = $1`,
          [companyId, parsed.isActive]
        );

        // Si suspendu, révoquer immédiatement les sessions actives de cet établissement
        if (!parsed.isActive) {
          await client.query(
            `UPDATE public.user_sessions
             SET revoked_at = NOW()
             WHERE company_id = $1 AND revoked_at IS NULL`,
            [companyId]
          );
        }

        const actionName = parsed.isActive
          ? 'SUPER_ADMIN_ESTABLISHMENT_ACTIVATED'
          : 'SUPER_ADMIN_ESTABLISHMENT_SUSPENDED';

        await client.query(
          `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, old_values, new_values)
           VALUES ($1, NULL, $2, 'companies', $1, $3::jsonb, $4::jsonb)`,
          [
            companyId,
            actionName,
            JSON.stringify({ is_active: previousActive }),
            JSON.stringify({
              actor: 'SUPER_ADMIN',
              is_active: parsed.isActive,
              reason: parsed.reason || null,
            }),
          ]
        );

        recordAdminSecurityEvent(actionName, {
          companyId,
          companyName,
          isActive: parsed.isActive,
        });

        res.json({
          success: true,
          data: {
            companyId,
            companyName,
            isActive: parsed.isActive,
          },
        });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

// Liste globale des utilisateurs et leurs rôles / permissions (lecture Propriétaire exclusivement)
superAdminRouter.get('/users', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const countryFilter = req.query.countryCode ? String(req.query.countryCode).toUpperCase() : null;

    const client = await adminPool.connect();
    try {
      const params: any[] = [];
      const where: string[] = [`c.id <> '00000000-0000-0000-0000-000000000000'::UUID`];

      if (countryFilter) {
        params.push(countryFilter);
        where.push(`COALESCE(c.country_code, 'SN') = $${params.length}`);
      }

      const result = await client.query(
        `SELECT u.id, u.email, u.full_name, u.is_active, u.created_at,
                cu.company_id, cu.is_active AS membership_active, cu.joined_at,
                c.name AS company_name, COALESCE(c.country_code, 'SN') AS country_code,
                c.is_active AS company_is_active,
                r.name AS role_name, r.permissions AS role_permissions
         FROM public.users u
         JOIN public.company_users cu ON cu.user_id = u.id
         JOIN public.companies c ON c.id = cu.company_id
         LEFT JOIN public.roles r ON r.company_id = cu.company_id AND r.id = cu.role_id
         WHERE ${where.join(' AND ')}
         ORDER BY u.created_at DESC
         LIMIT 200`,
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

// Activation ou suspension d'un utilisateur d'établissement par le Propriétaire
superAdminRouter.post(
  '/users/:userId/status',
  requireAuth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      await ensureDatabaseReady();
      const userId = z.string().uuid().parse(req.params.userId);
      if (userId === SUPER_ADMIN_USER_ID) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_TARGET', message: 'Le compte Propriétaire ne peut pas être modifié ici.' },
        });
        return;
      }

      const parsed = toggleStatusSchema.parse(req.body);
      const client = await adminPool.connect();
      try {
        const userRes = await client.query(
          `SELECT u.id, u.email, u.full_name, u.is_active, cu.company_id
           FROM public.users u
           LEFT JOIN public.company_users cu ON cu.user_id = u.id
           WHERE u.id = $1
           LIMIT 1`,
          [userId]
        );
        if (userRes.rows.length === 0) {
          res.status(404).json({
            success: false,
            error: { code: 'USER_NOT_FOUND', message: 'Utilisateur introuvable.' },
          });
          return;
        }

        const targetUser = userRes.rows[0];
        await client.query(
          `UPDATE public.users SET is_active = $2, updated_at = NOW() WHERE id = $1`,
          [userId, parsed.isActive]
        );

        if (!parsed.isActive) {
          await client.query(
            `UPDATE public.user_sessions
             SET revoked_at = NOW()
             WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId]
          );
        }

        const actionName = parsed.isActive
          ? 'SUPER_ADMIN_USER_ACTIVATED'
          : 'SUPER_ADMIN_USER_SUSPENDED';

        if (targetUser.company_id) {
          await client.query(
            `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, old_values, new_values)
             VALUES ($1, NULL, $2, 'users', $3, $4::jsonb, $5::jsonb)`,
            [
              targetUser.company_id,
              actionName,
              userId,
              JSON.stringify({ is_active: Boolean(targetUser.is_active) }),
              JSON.stringify({
                actor: 'SUPER_ADMIN',
                is_active: parsed.isActive,
                reason: parsed.reason || null,
              }),
            ]
          );
        }

        recordAdminSecurityEvent(actionName, {
          userId,
          userEmail: targetUser.email,
          isActive: parsed.isActive,
        });

        res.json({
          success: true,
          data: {
            userId,
            email: targetUser.email,
            isActive: parsed.isActive,
          },
        });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

const SENSITIVE_AUDIT_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'token_hash',
  'hmac_secret',
  'secret',
  'authorization',
]);

function sanitizeAuditValue(value: any): any {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeAuditValue);
  const clean: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_AUDIT_KEYS.has(k.toLowerCase())) continue;
    clean[k] = sanitizeAuditValue(v);
  }
  return clean;
}

// Journaux d'activité et événements de sécurité (lecture Propriétaire exclusivement)
superAdminRouter.get('/audit-logs', requireAuth, requireSuperAdmin, async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const limitRaw = Number(req.query.limit || 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(200, Math.floor(limitRaw))) : 80;

    const client = await adminPool.connect();
    try {
      const result = await client.query(
        `SELECT al.id, al.created_at, al.action, al.table_name, al.record_id,
                al.new_values,
                c.name AS company_name,
                u.email AS user_email
         FROM public.audit_logs al
         LEFT JOIN public.companies c ON c.id = al.company_id
         LEFT JOIN public.users u ON u.id = al.user_id
         ORDER BY al.created_at DESC
         LIMIT $1`,
        [limit]
      );

      const dbEvents = result.rows.map((row) => ({
        id: row.id,
        created_at: row.created_at,
        action: row.action,
        table_name: row.table_name,
        company_name: row.company_name || 'Plateforme',
        user_email: row.user_email || 'Système / Propriétaire',
        new_values: sanitizeAuditValue(row.new_values),
      }));

      let persistedAdminEvents: AdminAuthEvent[] = [];
      try {
        await ensureAdminSecurityEventsTable();
        const secRes = await client.query(
          `SELECT id, created_at, action, table_name, company_name, user_email, new_values
           FROM public.admin_security_events
           ORDER BY created_at DESC
           LIMIT $1`,
          [limit]
        );
        persistedAdminEvents = secRes.rows.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          action: r.action,
          table_name: r.table_name,
          company_name: r.company_name,
          user_email: r.user_email,
          new_values: sanitizeAuditValue(r.new_values),
        }));
      } catch {
        persistedAdminEvents = [...adminSecurityEvents];
      }

      const merged = [...persistedAdminEvents, ...dbEvents]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit);

      res.json({ success: true, data: merged });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Fiche détaillée d'un établissement (sans aucun secret ni mot de passe)
superAdminRouter.get(
  '/establishments/:companyId',
  requireAuth,
  requireSuperAdmin,
  async (req, res, next) => {
    try {
      await ensureDatabaseReady();
      const companyId = z.string().uuid().parse(req.params.companyId);

      const client = await adminPool.connect();
      try {
        const compRes = await client.query(
          `SELECT c.id, c.name, c.business_type, COALESCE(c.country_code, 'SN') AS country_code,
                  c.currency, c.default_tax_rate, c.allow_negative_stock, c.is_active, c.created_at,
                  cs.id AS subscription_id, COALESCE(cs.plan_code, 'PRO') AS plan_code,
                  COALESCE(cs.status, 'trial') AS subscription_status,
                  COALESCE(cs.billing_period, 'monthly') AS billing_period,
                  cs.trial_ends_at, cs.current_period_start, cs.current_period_end,
                  cs.last_payment_method, cs.last_payment_ref, cs.last_payment_amount
           FROM public.companies c
           LEFT JOIN public.company_subscriptions cs ON cs.company_id = c.id
           WHERE c.id = $1
           LIMIT 1`,
          [companyId]
        );
        if (compRes.rows.length === 0) {
          res.status(404).json({
            success: false,
            error: { code: 'ESTABLISHMENT_NOT_FOUND', message: 'Établissement introuvable.' },
          });
          return;
        }

        const [usersRes, statsRes, txRes, auditRes] = await Promise.all([
          client.query(
            `SELECT u.id, u.email, u.full_name, u.is_active, cu.is_active AS membership_active,
                    cu.joined_at, r.name AS role_name, r.permissions AS role_permissions
             FROM public.company_users cu
             JOIN public.users u ON u.id = cu.user_id
             LEFT JOIN public.roles r ON r.company_id = cu.company_id AND r.id = cu.role_id
             WHERE cu.company_id = $1
             ORDER BY cu.joined_at ASC`,
            [companyId]
          ),
          client.query(
            `SELECT
               (SELECT COUNT(*)::INT FROM public.products WHERE company_id = $1) AS products_count,
               (SELECT COUNT(*)::INT FROM public.sales WHERE company_id = $1 AND status = 'completed') AS completed_sales_count,
               (SELECT COUNT(*)::INT FROM public.cash_sessions WHERE company_id = $1 AND status = 'open') AS open_cash_sessions_count,
               (SELECT COUNT(*)::INT FROM public.dining_tables WHERE company_id = $1) AS tables_count`,
            [companyId]
          ),
          client.query(
            `SELECT id, transaction_ref, plan_code, billing_period, gross_amount, currency,
                    payment_method, manual_reference, status, created_at, confirmed_at
             FROM public.saas_subscription_transactions
             WHERE company_id = $1
             ORDER BY created_at DESC
             LIMIT 20`,
            [companyId]
          ),
          client.query(
            `SELECT al.id, al.created_at, al.action, al.table_name, u.email AS user_email
             FROM public.audit_logs al
             LEFT JOIN public.users u ON u.id = al.user_id
             WHERE al.company_id = $1
             ORDER BY al.created_at DESC
             LIMIT 25`,
            [companyId]
          ),
        ]);

        res.json({
          success: true,
          data: {
            establishment: compRes.rows[0],
            users: usersRes.rows,
            stats: statsRes.rows[0] || {
              products_count: 0,
              completed_sales_count: 0,
              open_cash_sessions_count: 0,
              tables_count: 0,
            },
            transactions: txRes.rows,
            recentAudit: auditRes.rows,
          },
        });
      } finally {
        client.release();
      }
    } catch (err) {
      next(err);
    }
  }
);

// Notifications & alertes opérationnelles de la plateforme pour le Propriétaire
superAdminRouter.get('/alerts', requireAuth, requireSuperAdmin, async (_req, res, next) => {
  try {
    await ensureDatabaseReady();
    const client = await adminPool.connect();
    try {
      const [pendingPayRes, expiringRes, suspendedRes, failedLoginsRes] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::INT AS cnt
           FROM public.saas_subscription_transactions
           WHERE status = 'pending'`
        ),
        client.query(
          `SELECT c.id, c.name, cs.status, cs.current_period_end
           FROM public.companies c
           JOIN public.company_subscriptions cs ON cs.company_id = c.id
           WHERE c.id <> '00000000-0000-0000-0000-000000000000'::UUID
             AND c.is_active = TRUE
             AND (
               cs.status IN ('expired', 'past_due')
               OR (cs.current_period_end IS NOT NULL AND cs.current_period_end <= NOW() + INTERVAL '7 days')
             )
           ORDER BY cs.current_period_end ASC NULLS FIRST
           LIMIT 20`
        ),
        client.query(
          `SELECT id, name, updated_at
           FROM public.companies
           WHERE id <> '00000000-0000-0000-0000-000000000000'::UUID
             AND is_active = FALSE
           ORDER BY updated_at DESC
           LIMIT 20`
        ),
        client.query(
          `SELECT COUNT(*)::INT AS cnt
           FROM public.audit_logs
           WHERE action = 'AUTH_LOGIN_FAILED'
             AND created_at >= NOW() - INTERVAL '24 hours'`
        ),
      ]);

      const alerts: Array<{
        level: 'warning' | 'danger' | 'info';
        code: string;
        title: string;
        detail: string;
        targetTab: string;
      }> = [];

      const pendingCount = Number(pendingPayRes.rows[0]?.cnt || 0);
      if (pendingCount > 0) {
        alerts.push({
          level: 'warning',
          code: 'PENDING_PAYMENTS',
          title: `${pendingCount} paiement(s) d’abonnement en attente de validation`,
          detail: 'Vérifiez la réception Wave / Orange Money / UBA avant d’activer la licence.',
          targetTab: 'pending',
        });
      }

      if (expiringRes.rows.length > 0) {
        alerts.push({
          level: 'warning',
          code: 'EXPIRING_SUBSCRIPTIONS',
          title: `${expiringRes.rows.length} établissement(s) expiré(s) ou à échéance proche (≤ 7 jours)`,
          detail: expiringRes.rows
            .slice(0, 3)
            .map((r) => r.name)
            .join(', '),
          targetTab: 'establishments',
        });
      }

      if (suspendedRes.rows.length > 0) {
        alerts.push({
          level: 'info',
          code: 'SUSPENDED_ESTABLISHMENTS',
          title: `${suspendedRes.rows.length} établissement(s) actuellement suspendu(s)`,
          detail: suspendedRes.rows
            .slice(0, 3)
            .map((r) => r.name)
            .join(', '),
          targetTab: 'establishments',
        });
      }

      const failed24h = Number(failedLoginsRes.rows[0]?.cnt || 0);
      if (failed24h >= 5) {
        alerts.push({
          level: 'danger',
          code: 'LOGIN_FAILURES_24H',
          title: `${failed24h} échecs de connexion détectés sur les dernières 24h`,
          detail: 'Consultez les journaux d’activité pour surveiller d’éventuelles tentatives abusives.',
          targetTab: 'audit',
        });
      }

      res.json({
        success: true,
        data: {
          alerts,
          counts: {
            pendingPayments: pendingCount,
            expiringSubscriptions: expiringRes.rows.length,
            suspendedEstablishments: suspendedRes.rows.length,
            failedLogins24h: failed24h,
          },
        },
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});



