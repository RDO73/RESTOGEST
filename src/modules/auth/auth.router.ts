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
} from '../../db/demo-seed.js';
import { hashPassword, verifyPassword } from '../../auth/password.js';
import {
  clearSessionCookie,
  generateSessionToken,
  markTokenRevoked,
  setSessionCookie,
} from '../../auth/jwt.js';
import { requireAuth } from '../../middlewares/auth-middleware.js';

export const authRouter = Router();

const RegisterSchema = z.object({
  companyName: z.string().min(2).max(255),
  businessType: z.enum(['restaurant', 'pastry_shop', 'both']),
  currency: z.string().default('XOF'),
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

    // Exécution de la fonction PostgreSQL SECURITY DEFINER
    const result = await appPool.query(
      `SELECT company_id, user_id FROM public.register_company_and_owner(
        $1::VARCHAR, $2::VARCHAR, $3::VARCHAR, $4::VARCHAR, $5::TEXT, $6::VARCHAR
      )`,
      [
        data.companyName,
        data.businessType,
        data.currency,
        normalizedEmail,
        passwordHash,
        data.fullName,
      ]
    );

    const { company_id, user_id } = result.rows[0];

    // Génération de la session auto-porteuse signée HMAC-SHA256
    const session = generateSessionToken(user_id, company_id, {
      tenantId: company_id,
      role: 'owner',
      email: normalizedEmail,
      fullName: data.fullName,
      companyName: data.companyName,
      businessType: data.businessType,
      currency: data.currency,
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
        isDemo: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

// Connexion
authRouter.post('/login', async (req, res, next) => {
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
      res.status(401).json({ success: false, error: 'Identifiants invalides' });
      return;
    }

    const user = userResult.rows[0];
    if (!user.is_active) {
      res.status(403).json({ success: false, error: 'Compte utilisateur désactivé' });
      return;
    }

    const validPassword = await verifyPassword(user.password_hash, data.password);
    if (!validPassword) {
      res.status(401).json({ success: false, error: 'Identifiants invalides' });
      return;
    }

    // Sélection de l'entreprise
    let companyQuery = `
      SELECT cu.company_id, c.name AS company_name, c.business_type, c.currency
      FROM public.company_users cu
      JOIN public.companies c ON c.id = cu.company_id
      WHERE cu.user_id = $1 AND cu.is_active = TRUE AND c.is_active = TRUE
    `;
    const queryParams: any[] = [user.id];

    if (data.companyId) {
      companyQuery += ` AND cu.company_id = $2`;
      queryParams.push(data.companyId);
    }

    const companyResult = await adminPool.query(companyQuery, queryParams);
    if (companyResult.rows.length === 0) {
      res.status(403).json({ success: false, error: 'Aucune entreprise active accessible pour ce compte' });
      return;
    }

    const targetCompany = companyResult.rows[0];
    const targetCompanyId = targetCompany.company_id;
    const isDemo = targetCompanyId === DEMO_TENANT_ID;

    // Création session & token auto-porteur
    const session = generateSessionToken(user.id, targetCompanyId, {
      tenantId: targetCompanyId,
      role: 'owner',
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
      },
    });
  } catch (error) {
    next(error);
  }
});

// Informations sur la session active
authRouter.get('/me', requireAuth, async (req, res, next) => {
  try {
    const auth = req.auth!;
    const profile = await withTenantContext(auth, async (client) => {
      const userRes = await client.query(
        `SELECT id, email, full_name, created_at FROM public.users WHERE id = $1`,
        [auth.userId]
      );
      const companyRes = await client.query(
        `SELECT id, name, business_type, currency, default_tax_rate, allow_negative_stock FROM public.companies WHERE id = $1`,
        [auth.companyId]
      );
      return {
        user: userRes.rows[0],
        company: companyRes.rows[0],
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
