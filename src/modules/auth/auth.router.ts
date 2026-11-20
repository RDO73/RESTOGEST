import { Router, type Response } from 'express';
import { z } from 'zod';
import { adminPool, appPool, ensureDatabaseReady } from '../../db/pool.js';
import { withTenantContext } from '../../db/tenant-context.js';
import {
  DEMO_COMPANY_NAME,
  DEMO_EMAIL,
  DEMO_FULL_NAME,
  DEMO_TENANT_ID,
  DEMO_USER_ID,
  ensureDemoEnvironment,
  evictHydratedSession,
} from '../../db/demo-seed.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  getDefaultRouteForRole,
  inferRoleCode,
  sanitizePermissions,
} from '../../auth/permissions.js';
import {
  clearSessionCookie,
  generateSessionToken,
  markTokenRevoked,
  setSessionCookie,
} from '../../auth/jwt.js';
import { requireAuth } from '../../middlewares/auth-middleware.js';
import {
  checkLoginRateLimit,
  recordLoginFailure,
  resetLoginFailures,
} from '../../middlewares/rate-limit.js';

export const authRouter = Router();

const RegisterSchema = z.object({
  companyName: z.string().min(2).max(255),
  businessType: z.enum(['restaurant', 'pastry_shop', 'both']),
  countryCode: z.string().min(2).max(10).default('SN'),
  currency: z.string().min(2).max(10).optional(),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2),
});

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  companyId: z.string().uuid().optional(),
});

async function issueDemoSessionResponse(res: Response, statusCode: number): Promise<void> {
  const session = generateSessionToken(DEMO_USER_ID, DEMO_TENANT_ID, {
    tenantId: DEMO_TENANT_ID,
    role: 'owner',
    roleName: 'Propriétaire',
    permissions: { all: true },
    email: DEMO_EMAIL,
    fullName: DEMO_FULL_NAME,
    companyName: DEMO_COMPANY_NAME,
    businessType: 'both',
    currency: 'XOF',
    isDemo: true,
  });

  await ensureDemoEnvironment(session.tokenHash);
  setSessionCookie(res, session.token);

  res.status(statusCode).json({
    success: true,
    data: {
      token: session.token,
      companyId: DEMO_TENANT_ID,
      tenantId: DEMO_TENANT_ID,
      userId: DEMO_USER_ID,
      role: 'owner',
      email: DEMO_EMAIL,
      isDemo: true,
    },
  });
}

// Lancement immédiat de l'environnement de démonstration (stateless + auto-seed déterministe)
authRouter.post('/demo', async (_req, res, next) => {
  try {
    await ensureDatabaseReady();
    await issueDemoSessionResponse(res, 200);
  } catch (error) {
    next(error);
  }
});

// Inscription Entreprise + Propriétaire
authRouter.post('/register', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    if (req.body?.isDemo === true) {
      await issueDemoSessionResponse(res, 201);
      return;
    }

    const data = RegisterSchema.parse(req.body);
    const passwordHash = await hashPassword(data.password);
    const normalizedEmail = data.email.toLowerCase();
    const countryCode = data.countryCode.trim().toUpperCase();

    // Détermination automatique de la devise officielle depuis le référentiel pays
    const countryRes = await adminPool.query(
      `SELECT code, currency_code FROM public.saas_countries WHERE code = $1 AND is_active = TRUE`,
      [countryCode]
    );
    const resolvedCurrency = data.currency?.trim().toUpperCase() || countryRes.rows[0]?.currency_code || 'XOF';
    const resolvedCountryCode = countryRes.rows[0]?.code || countryCode;

    // Exécution de la fonction PostgreSQL SECURITY DEFINER
    const result = await appPool.query(
      `SELECT company_id, user_id FROM public.register_company_and_owner(
        $1::VARCHAR, $2::VARCHAR, $3::VARCHAR, $4::VARCHAR, $5::TEXT, $6::VARCHAR
      )`,
      [
        data.companyName,
        data.businessType,
        resolvedCurrency,
        normalizedEmail,
        passwordHash,
        data.fullName,
      ]
    );

    const { company_id, user_id } = result.rows[0];

    await adminPool.query(
      `UPDATE public.companies SET country_code = $2, currency = $3 WHERE id = $1`,
      [company_id, resolvedCountryCode, resolvedCurrency]
    );
    await adminPool.query(
      `INSERT INTO public.company_settings (company_id, currency, country, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (company_id) DO UPDATE
       SET currency = EXCLUDED.currency, country = EXCLUDED.country, updated_at = NOW()`,
      [company_id, resolvedCurrency, resolvedCountryCode]
    );

    // Génération de la session auto-porteuse signée HMAC-SHA256
    const session = generateSessionToken(user_id, company_id, {
      tenantId: company_id,
      role: 'owner',
      roleName: 'Propriétaire',
      permissions: { all: true },
      email: normalizedEmail,
      fullName: data.fullName,
      companyName: data.companyName,
      businessType: data.businessType,
      currency: resolvedCurrency,
      isDemo: false,
    });

    // Insertion du token_hash dans user_sessions via adminPool
    await adminPool.query(
      `INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
      [user_id, company_id, session.tokenHash]
    );

    setSessionCookie(res, session.token);

    res.status(201).json({
      success: true,
      data: {
        token: session.token,
        companyId: company_id,
        tenantId: company_id,
        userId: user_id,
        countryCode: resolvedCountryCode,
        currency: resolvedCurrency,
        isDemo: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Connexion (protégée par limitation à 5 échecs / 15 min)
authRouter.post('/login', checkLoginRateLimit('client_login'), async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const data = LoginSchema.parse(req.body);

    // Recherche de l'utilisateur et de son mot de passe haché (via adminPool)
    const userResult = await adminPool.query(
      `SELECT u.id, u.email, u.full_name, u.is_active, uc.password_hash
       FROM public.users u
       JOIN public.user_credentials uc ON uc.user_id = u.id
       WHERE LOWER(u.email) = LOWER($1)`,
      [data.email]
    );

    if (userResult.rows.length === 0) {
      recordLoginFailure(req, 'client_login');
      res.status(401).json({ success: false, error: 'Identifiants invalides' });
      return;
    }

    const user = userResult.rows[0];
    if (!user.is_active) {
      recordLoginFailure(req, 'client_login');
      res.status(401).json({ success: false, error: 'Identifiants invalides' });
      return;
    }

    const validPassword = await verifyPassword(user.password_hash, data.password);
    if (!validPassword) {
      recordLoginFailure(req, 'client_login');
      // Journaliser l'échec dans audit_logs sur l'entreprise principale (sans aucun mot de passe)
      try {
        const compLookup = await adminPool.query(
          `SELECT company_id FROM public.company_users WHERE user_id = $1 LIMIT 1`,
          [user.id]
        );
        if (compLookup.rows.length > 0) {
          await adminPool.query(
            `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, new_values)
             VALUES ($1, $2, 'AUTH_LOGIN_FAILED', 'user_sessions', $3::jsonb)`,
            [compLookup.rows[0].company_id, user.id, JSON.stringify({ reason: 'invalid_credentials' })]
          );
        }
      } catch {
        // non-blocking
      }
      res.status(401).json({ success: false, error: 'Identifiants invalides' });
      return;
    }

    // Sélection de l'entreprise et résolution du rôle / permissions réels
    let companyQuery = `
      SELECT cu.company_id, c.name AS company_name, c.business_type, c.currency,
             r.name AS role_name, r.permissions AS role_permissions
      FROM public.company_users cu
      JOIN public.companies c ON c.id = cu.company_id
      LEFT JOIN public.roles r ON r.company_id = cu.company_id AND r.id = cu.role_id
      WHERE cu.user_id = $1 AND cu.is_active = TRUE AND c.is_active = TRUE
    `;
    const queryParams: any[] = [user.id];

    if (data.companyId) {
      companyQuery += ` AND cu.company_id = $2`;
      queryParams.push(data.companyId);
    }

    const companyResult = await adminPool.query(companyQuery, queryParams);
    if (companyResult.rows.length === 0) {
      recordLoginFailure(req, 'client_login');
      res.status(403).json({ success: false, error: 'Aucune entreprise active accessible pour ce compte' });
      return;
    }

    resetLoginFailures(req, 'client_login');

    const targetCompany = companyResult.rows[0];
    const targetCompanyId = targetCompany.company_id;
    const isDemo = targetCompanyId === DEMO_TENANT_ID;
    const livePermissions = sanitizePermissions(targetCompany.role_permissions);
    const resolvedRoleName = targetCompany.role_name || (livePermissions.all ? 'Propriétaire' : 'Employé');
    const resolvedRoleCode = inferRoleCode(resolvedRoleName, livePermissions);
    const defaultRoute = getDefaultRouteForRole(resolvedRoleCode, livePermissions);

    // Création session & token auto-porteur avec le rôle réel de l'utilisateur
    const session = generateSessionToken(user.id, targetCompanyId, {
      tenantId: targetCompanyId,
      role: resolvedRoleCode,
      roleName: resolvedRoleName,
      permissions: livePermissions,
      email: user.email,
      fullName: user.full_name,
      companyName: targetCompany.company_name,
      businessType: targetCompany.business_type,
      currency: targetCompany.currency,
      isDemo,
    });

    await adminPool.query(
      `INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')`,
      [user.id, targetCompanyId, session.tokenHash]
    );

    try {
      await adminPool.query(
        `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, new_values)
         VALUES ($1, $2, 'AUTH_LOGIN_SUCCESS', 'user_sessions', $3::jsonb)`,
        [targetCompanyId, user.id, JSON.stringify({ isDemo, role: resolvedRoleCode })]
      );
    } catch {
      // non-blocking
    }

    setSessionCookie(res, session.token);

    res.json({
      success: true,
      data: {
        token: session.token,
        isDemo,
        user: {
          id: user.id,
          email: user.email,
          fullName: user.full_name,
        },
        company: {
          id: targetCompanyId,
          name: targetCompany.company_name,
        },
        role: {
          code: resolvedRoleCode,
          name: resolvedRoleName,
          isOwner: livePermissions.all === true,
          defaultRoute,
          permissions: livePermissions,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// Informations sur la session active (avec rôle et permissions temps réel)
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const profile = await withTenantContext(auth, async (client) => {
      const userRes = await client.query(
        `SELECT id, email, full_name, created_at FROM public.users WHERE id = $1`,
        [auth.userId]
      );
      const companyRes = await client.query(
        `SELECT id, name, business_type, country_code, currency, default_tax_rate, allow_negative_stock FROM public.companies WHERE id = $1`,
        [auth.companyId]
      );
      const roleRes = await client.query(
        `SELECT r.name AS role_name, r.permissions AS role_permissions
         FROM public.company_users cu
         JOIN public.roles r ON r.company_id = cu.company_id AND r.id = cu.role_id
         WHERE cu.company_id = $1 AND cu.user_id = $2 AND cu.is_active = TRUE
         LIMIT 1`,
        [auth.companyId, auth.userId]
      );
      const perms = sanitizePermissions(roleRes.rows[0]?.role_permissions || auth.permissions);
      const roleName = roleRes.rows[0]?.role_name || auth.roleName || (perms.all ? 'Propriétaire' : 'Employé');
      const roleCode = inferRoleCode(roleName, perms);
      const defaultRoute = getDefaultRouteForRole(roleCode, perms);

      return {
        user: userRes.rows[0],
        company: companyRes.rows[0],
        role: {
          code: roleCode,
          name: roleName,
          isOwner: perms.all === true,
          defaultRoute,
          permissions: perms,
        },
        isDemo: Boolean(auth.isDemo || auth.companyId === DEMO_TENANT_ID),
      };
    });

    res.json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
});

// Déconnexion et révocation immédiate de la session en base
authRouter.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    markTokenRevoked(req.auth!.tokenHash);
    evictHydratedSession(req.auth!.tokenHash);
    clearSessionCookie(res);

    await adminPool.query(
      `UPDATE public.user_sessions
       SET revoked_at = NOW()
       WHERE token_hash = $1 AND user_id = $2 AND company_id = $3 AND revoked_at IS NULL`,
      [req.auth!.tokenHash, req.auth!.userId, req.auth!.companyId]
    );
    res.json({ success: true, message: 'Session révoquée avec succès' });
  } catch (error) {
    next(error);
  }
});

// Demande de réinitialisation de mot de passe (sans fuite d'existence de compte)
authRouter.post('/forgot-password', async (req, res, next) => {
  try {
    const schema = z.object({
      email: z.string().email(),
    });
    schema.parse(req.body);

    res.json({
      success: true,
      message:
        'Si un compte est associé à cette adresse e-mail, les instructions de réinitialisation ont été envoyées.',
    });
  } catch (error) {
    next(error);
  }
});
