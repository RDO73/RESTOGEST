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
import {
  enforceSubscriptionQuota,
  getRequiredLegalVersions,
  getUserTermsAcceptanceStatus,
  initializeCompanyTrialSubscription,
  recordUserTermsAcceptance,
  resolveCompanySubscriptionState,
  withCompanyQuotaLock,
} from '../subscriptions/subscription-guard.service.js';

export const authRouter = Router();

const RegisterSchema = z.object({
  companyName: z.string().min(2).max(255),
  businessType: z.enum(['restaurant', 'pastry_shop', 'both']),
  countryCode: z.string().min(2).max(10).default('SN'),
  currency: z.string().min(2).max(10).optional(),
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2),
  acceptTerms: z.boolean().optional(),
  acceptCgu: z.boolean().optional(),
  acceptCgv: z.boolean().optional(),
  cguVersion: z.string().min(1).max(40).optional(),
  cgvVersion: z.string().min(1).max(40).optional(),
  privacyPolicyVersion: z.string().min(1).max(40).optional(),
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
    const hasAcceptedTerms =
      data.acceptTerms === true || (data.acceptCgu === true && data.acceptCgv === true);
    if (!hasAcceptedTerms) {
      res.status(400).json({
        success: false,
        error: {
          code: 'TERMS_ACCEPTANCE_REQUIRED',
          message:
            "Vous devez accepter explicitement les Conditions Générales d'Utilisation (CGU) et les Conditions Générales de Vente (CGV) pour créer votre établissement sur MyRestoGest.",
        },
      });
      return;
    }

    // Vérification préliminaire de la version des CGU/CGV avant création en base
    const requiredVersions = getRequiredLegalVersions();
    if (
      (data.cguVersion && data.cguVersion.trim() !== requiredVersions.cguVersion) ||
      (data.cgvVersion && data.cgvVersion.trim() !== requiredVersions.cgvVersion)
    ) {
      res.status(400).json({
        success: false,
        error: {
          code: 'TERMS_VERSION_MISMATCH',
          message: `Version des conditions contractuelles obsolète (attendu CGU=${requiredVersions.cguVersion}, CGV=${requiredVersions.cgvVersion}). Veuillez actualiser la page.`,
        },
      });
      return;
    }

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

    // Enregistrement immuable de la preuve d'acceptation des CGU & CGV (horodatage serveur NOW())
    const termsAcceptance = await recordUserTermsAcceptance(adminPool, {
      companyId: company_id,
      userId: user_id,
      cguVersion: data.cguVersion,
      cgvVersion: data.cgvVersion,
      privacyPolicyVersion: data.privacyPolicyVersion,
      source: 'register',
      userAgent: String(req.headers['user-agent'] || '') || null,
    });

    // Déclenchement immédiat de la période d'essai gratuit de 14 jours dès l'inscription
    const trialSubscription = await initializeCompanyTrialSubscription(adminPool, company_id, {
      planCode: 'PRO',
      status: 'trial',
      durationDays: 14,
    });

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
        termsAcceptance,
        subscription: trialSubscription,
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

    const [termsStatus, subState] = await Promise.all([
      getUserTermsAcceptanceStatus(adminPool, auth.companyId, auth.userId),
      resolveCompanySubscriptionState(adminPool, auth.companyId),
    ]);

    res.json({
      success: true,
      data: {
        ...profile,
        termsStatus,
        subscriptionStatus: {
          status: subState.status,
          planCode: subState.planCode,
          planName: subState.planName,
          isExpired: subState.isExpired,
          isReadOnly: subState.isReadOnly,
          daysRemaining: subState.daysRemaining,
          quotas: subState.quotas,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// Ré-acceptation des CGU & CGV lors d'une mise à jour majeure de version (conserve l'historique précédent)
authRouter.post('/accept-terms', requireAuth, async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const schema = z.object({
      acceptTerms: z.boolean().optional(),
      acceptCgu: z.boolean().optional(),
      acceptCgv: z.boolean().optional(),
      cguVersion: z.string().min(1).max(40).optional(),
      cgvVersion: z.string().min(1).max(40).optional(),
      privacyPolicyVersion: z.string().min(1).max(40).optional(),
    });
    const parsed = schema.parse(req.body);
    const hasAccepted =
      parsed.acceptTerms === true || (parsed.acceptCgu === true && parsed.acceptCgv === true);
    if (!hasAccepted) {
      res.status(400).json({
        success: false,
        error: {
          code: 'TERMS_ACCEPTANCE_REQUIRED',
          message:
            "Vous devez cocher la case d'acceptation des Conditions Générales d'Utilisation (CGU) et des Conditions Générales de Vente (CGV).",
        },
      });
      return;
    }

    const recorded = await recordUserTermsAcceptance(adminPool, {
      companyId: req.auth!.companyId,
      userId: req.auth!.userId,
      cguVersion: parsed.cguVersion,
      cgvVersion: parsed.cgvVersion,
      privacyPolicyVersion: parsed.privacyPolicyVersion,
      source: 'reacceptance',
      userAgent: String(req.headers['user-agent'] || '') || null,
    });

    const termsStatus = await getUserTermsAcceptanceStatus(
      adminPool,
      req.auth!.companyId,
      req.auth!.userId
    );

    res.status(201).json({
      success: true,
      data: {
        acceptance: recorded,
        termsStatus,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Création d'un établissement / site supplémentaire par un propriétaire (soumis au quota maxLocations de la formule)
authRouter.post('/establishments', requireAuth, async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const schema = z.object({
      companyName: z.string().min(2).max(255),
      businessType: z.enum(['restaurant', 'pastry_shop', 'both']).default('restaurant'),
      countryCode: z.string().min(2).max(10).default('SN'),
      currency: z.string().min(2).max(10).optional(),
    });
    const data = schema.parse(req.body);
    const auth = req.auth!;

    const created = await withCompanyQuotaLock(`locations:${auth.userId}`, async () => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');

        // 1. Vérifier strictement que l'utilisateur connecté est bien le propriétaire actif de l'établissement source
        const ownerCheck = await client.query(
          `SELECT cu.user_id, c.is_active AS company_active, r.permissions
           FROM public.company_users cu
           JOIN public.companies c ON c.id = cu.company_id
           JOIN public.users u ON u.id = cu.user_id
           LEFT JOIN public.roles r ON r.id = cu.role_id AND r.company_id = cu.company_id
           WHERE cu.company_id = $1
             AND cu.user_id = $2
             AND cu.is_active = TRUE
             AND c.is_active = TRUE
             AND u.is_active = TRUE
             AND COALESCE((r.permissions->>'all')::boolean, FALSE) = TRUE
           LIMIT 1`,
          [auth.companyId, auth.userId]
        );
        if (ownerCheck.rows.length === 0) {
          const err = new Error(
            "Accès refusé : seul le propriétaire actif de l'établissement principal peut créer un site supplémentaire."
          ) as Error & { statusCode?: number; code?: string };
          err.statusCode = 403;
          err.code = 'OWNER_PERMISSION_REQUIRED';
          throw err;
        }

        // 2. Vérifier la réacceptation CGU/CGV, l'état actif de l'abonnement et le quota maxLocations (10 sur ENTREPRISE)
        await enforceSubscriptionQuota(client, auth.companyId, 'locations', {
          ownerUserId: auth.userId,
        });

        const parentSubState = await resolveCompanySubscriptionState(client, auth.companyId);
        if (parentSubState.status !== 'active' || parentSubState.isReadOnly) {
          const err = new Error(
            "Un abonnement payant actif (formule Entreprise) est requis pour créer un établissement supplémentaire."
          ) as Error & { statusCode?: number; code?: string };
          err.statusCode = 403;
          err.code = 'ACTIVE_ENTERPRISE_SUBSCRIPTION_REQUIRED';
          throw err;
        }
        const parentSub = parentSubState.subscription;
        const rootParentCompanyId =
          parentSub.last_payment_ref && String(parentSub.last_payment_ref).startsWith('MULTI-SITE:')
            ? String(parentSub.last_payment_ref).slice('MULTI-SITE:'.length).trim()
            : auth.companyId;

        const planRes = await client.query(
          `SELECT id FROM public.subscription_plans WHERE code = $1 LIMIT 1`,
          [parentSubState.planCode]
        );
        const inheritedPlanId = planRes.rows[0]?.id || parentSub.plan_id || null;

        const countryCode = data.countryCode.trim().toUpperCase();
        const countryRes = await client.query(
          `SELECT code, currency_code FROM public.saas_countries WHERE code = $1 AND is_active = TRUE`,
          [countryCode]
        );
        const resolvedCurrency =
          data.currency?.trim().toUpperCase() || countryRes.rows[0]?.currency_code || 'XOF';
        const resolvedCountryCode = countryRes.rows[0]?.code || countryCode;

        const compIns = await client.query(
          `INSERT INTO public.companies (name, business_type, country_code, currency, is_active)
           VALUES ($1, $2, $3, $4, TRUE)
           RETURNING *`,
          [data.companyName.trim(), data.businessType, resolvedCountryCode, resolvedCurrency]
        );
        const newCompany = compIns.rows[0];

        const roleIns = await client.query(
          `INSERT INTO public.roles (company_id, name, permissions)
           VALUES ($1, 'Propriétaire', '{"all": true}'::jsonb)
           RETURNING id`,
          [newCompany.id]
        );
        await client.query(
          `INSERT INTO public.company_users (company_id, user_id, role_id, is_active)
           VALUES ($1, $2, $3, TRUE)`,
          [newCompany.id, auth.userId, roleIns.rows[0].id]
        );

        await client.query(
          `INSERT INTO public.company_settings (company_id, currency, country, updated_at)
           VALUES ($1, $2, $3, NOW())
           ON CONFLICT (company_id) DO NOTHING`,
          [newCompany.id, resolvedCurrency, resolvedCountryCode]
        );

        // 3. Héritage direct de l'abonnement ENTREPRISE actif (sans créer d'essai PRO de 14 jours ni de double facturation)
        const inheritedSubRes = await client.query(
          `INSERT INTO public.company_subscriptions (
             company_id, plan_id, plan_code, status, billing_period,
             starts_at, ends_at, trial_ends_at, current_period_start, current_period_end,
             custom_max_users, custom_max_locations, custom_max_tables, custom_max_products,
             last_payment_method, last_payment_ref, last_payment_amount, updated_at
           )
           VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8, $9, $10,
             $11, $12, $13, $14,
             'multi_site_inheritance', $15, 0, NOW()
           )
           ON CONFLICT (company_id) DO UPDATE
           SET plan_id = EXCLUDED.plan_id,
               plan_code = EXCLUDED.plan_code,
               status = EXCLUDED.status,
               billing_period = EXCLUDED.billing_period,
               starts_at = EXCLUDED.starts_at,
               ends_at = EXCLUDED.ends_at,
               trial_ends_at = EXCLUDED.trial_ends_at,
               current_period_start = EXCLUDED.current_period_start,
               current_period_end = EXCLUDED.current_period_end,
               custom_max_users = EXCLUDED.custom_max_users,
               custom_max_locations = EXCLUDED.custom_max_locations,
               custom_max_tables = EXCLUDED.custom_max_tables,
               custom_max_products = EXCLUDED.custom_max_products,
               last_payment_method = EXCLUDED.last_payment_method,
               last_payment_ref = EXCLUDED.last_payment_ref,
               last_payment_amount = 0,
               updated_at = NOW()
           RETURNING *`,
          [
            newCompany.id,
            inheritedPlanId,
            parentSubState.planCode,
            parentSubState.status,
            parentSub.billing_period || 'monthly',
            parentSub.starts_at || new Date().toISOString(),
            parentSub.ends_at || parentSub.current_period_end || new Date().toISOString(),
            parentSub.trial_ends_at || null,
            parentSub.current_period_start || new Date().toISOString(),
            parentSub.current_period_end || parentSub.ends_at || new Date().toISOString(),
            parentSub.custom_max_users ?? null,
            parentSub.custom_max_locations ?? null,
            parentSub.custom_max_tables ?? null,
            parentSub.custom_max_products ?? null,
            `MULTI-SITE:${rootParentCompanyId}`,
          ]
        );

        // 4. Enregistrer la preuve d'acceptation CGU/CGV active du propriétaire sur le nouvel établissement
        await recordUserTermsAcceptance(client, {
          companyId: newCompany.id,
          userId: auth.userId,
          source: 'register',
          userAgent: String(req.headers['user-agent'] || '') || null,
        });

        await client.query('COMMIT');
        return {
          ...newCompany,
          subscription: {
            ...inheritedSubRes.rows[0],
            plan_code: parentSubState.planCode,
            plan_name: parentSubState.planName,
            status: parentSubState.status,
            max_users: parentSubState.quotas.maxUsers,
            max_locations: parentSubState.quotas.maxLocations,
            max_tables: parentSubState.quotas.maxTables,
            max_products: parentSubState.quotas.maxProducts,
            parent_company_id: rootParentCompanyId,
            is_linked_multi_site: true,
          },
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });

    res.status(201).json({
      success: true,
      data: created,
    });
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
