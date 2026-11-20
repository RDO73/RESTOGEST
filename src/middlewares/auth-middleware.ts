import type { Request, Response, NextFunction } from 'express';
import {
  ADMIN_SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  extractNamedCookie,
  extractTokenFromCookieHeader,
  isTokenRevoked,
  markTokenRevoked,
  verifyCsrfTokenMatch,
  verifySessionToken,
  type VerifiedSession,
} from '../auth/jwt.js';
import {
  hasPermission,
  inferRoleCode,
  sanitizePermissions,
  type PermissionKey,
  type PermissionsMap,
} from '../auth/permissions.js';
import { adminPool } from '../db/pool.js';
import { evictHydratedSession } from '../db/demo-seed.js';

declare global {
  namespace Express {
    interface Request {
      auth?: VerifiedSession;
    }
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

let adminRevokedTableReady = false;

export async function persistAdminTokenRevocation(tokenHash: string): Promise<void> {
  markTokenRevoked(tokenHash);
  try {
    if (!adminRevokedTableReady) {
      await adminPool.query(
        `CREATE TABLE IF NOT EXISTS public.admin_revoked_tokens (
           token_hash VARCHAR(64) PRIMARY KEY,
           revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
         )`
      );
      adminRevokedTableReady = true;
    }
    await adminPool.query(
      `INSERT INTO public.admin_revoked_tokens (token_hash, revoked_at)
       VALUES ($1, NOW())
       ON CONFLICT (token_hash) DO NOTHING`,
      [tokenHash]
    );
  } catch {
    // fallback to in-memory set if DB unavailable
  }
}

function isAdminEndpoint(req: Request): boolean {
  const url = req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`;
  return url.startsWith('/api/admin') || url.startsWith('/api/subscriptions/admin');
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  let token: string | null = null;
  let authenticatedViaCookie = false;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else {
    const cookieName = isAdminEndpoint(req) ? ADMIN_SESSION_COOKIE_NAME : SESSION_COOKIE_NAME;
    token = extractTokenFromCookieHeader(req.headers.cookie, cookieName);
    if (token) authenticatedViaCookie = true;
  }

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Authentification requise : session manquante',
    });
    return;
  }

  // Protection CSRF sur les requêtes mutantes authentifiées par cookie (double-submit cookie)
  if (authenticatedViaCookie && MUTATING_METHODS.has(req.method.toUpperCase())) {
    const headerCsrf =
      typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined;
    const cookieCsrf = extractNamedCookie(req.headers.cookie, CSRF_COOKIE_NAME);
    if (!verifyCsrfTokenMatch(headerCsrf, cookieCsrf)) {
      res.status(403).json({
        success: false,
        error: 'Jeton CSRF manquant ou invalide. Rechargez la page et réessayez.',
      });
      return;
    }
  }

  try {
    const session = verifySessionToken(token);
    if (isTokenRevoked(session.tokenHash)) {
      res.status(401).json({
        success: false,
        error: 'Session révoquée',
      });
      return;
    }

    if (session.role === 'SUPER_ADMIN') {
      // Vérification persistante de la révocation Super-Admin (survit aux redémarrages serverless)
      try {
        const regRes = await adminPool.query(
          `SELECT to_regclass('public.admin_revoked_tokens') AS tbl`
        );
        if (regRes.rows[0]?.tbl) {
          adminRevokedTableReady = true;
          const revRes = await adminPool.query(
            `SELECT 1 FROM public.admin_revoked_tokens WHERE token_hash = $1 LIMIT 1`,
            [session.tokenHash]
          );
          if (revRes.rows.length > 0) {
            markTokenRevoked(session.tokenHash);
            res.status(401).json({
              success: false,
              error: 'Session Super-Admin révoquée. Veuillez vous reconnecter.',
            });
            return;
          }
        }
      } catch {
        // non-blocking if DB not yet initialized
      }
      session.roleName = 'Super-Administrateur';
      session.permissions = { all: true };
    } else {
      // Vérification persistante dans public.user_sessions + chargement temps réel du rôle & permissions
      let resolvedPermissions: PermissionsMap | null = null;
      try {
        const dbSession = await adminPool.query(
          `SELECT s.revoked_at, s.expires_at,
                  u.is_active AS user_active,
                  c.is_active AS company_active,
                  cu.is_active AS membership_active,
                  r.name AS role_name,
                  r.permissions AS role_permissions
           FROM public.user_sessions s
           JOIN public.users u ON u.id = s.user_id
           JOIN public.companies c ON c.id = s.company_id
           LEFT JOIN public.company_users cu ON cu.company_id = s.company_id AND cu.user_id = s.user_id
           LEFT JOIN public.roles r ON r.company_id = cu.company_id AND r.id = cu.role_id
           WHERE s.token_hash = $1
           LIMIT 1`,
          [session.tokenHash]
        );
        if (dbSession.rows.length > 0) {
          const row = dbSession.rows[0];
          const isExpired = row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
          if (
            row.revoked_at !== null ||
            isExpired ||
            row.user_active === false ||
            row.company_active === false ||
            row.membership_active === false
          ) {
            markTokenRevoked(session.tokenHash);
            evictHydratedSession(session.tokenHash);
            res.status(401).json({
              success: false,
              error: 'Session révoquée, expirée ou compte désactivé',
            });
            return;
          }
          const livePerms = sanitizePermissions(row.role_permissions);
          resolvedPermissions = livePerms;
          session.roleName = row.role_name || session.roleName || 'Utilisateur';
          session.role = inferRoleCode(row.role_name, livePerms);
          session.permissions = livePerms;
        }
      } catch {
        // Si la table n'est pas encore initialisée (ex. cold-start démo PGlite), repli contrôlé ci-dessous
      }

      if (!resolvedPermissions) {
        if (session.permissions && typeof session.permissions === 'object') {
          session.permissions = sanitizePermissions(session.permissions);
        } else if (session.role === 'owner') {
          session.permissions = { all: true };
          session.roleName = session.roleName || 'Propriétaire';
        } else {
          session.permissions = {};
        }
      }
    }

    req.auth = session;
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: 'Session invalide ou expirée',
    });
  }
}

export const OWNER_SUPER_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000001';

/**
 * Middleware strict réservant l'accès exclusivement au compte Propriétaire / Super-Admin.
 * Tout restaurateur ou employé authentifié reçoit HTTP 403.
 */
export function requireSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  if (
    !req.auth ||
    String(req.auth.role || '').toUpperCase() !== 'SUPER_ADMIN' ||
    req.auth.userId !== OWNER_SUPER_ADMIN_USER_ID
  ) {
    res.status(403).json({
      success: false,
      error: {
        code: 'SUPER_ADMIN_REQUIRED',
        message: 'Accès réservé exclusivement au propriétaire de RESTOGEST.',
      },
    });
    return;
  }
  next();
}

/**
 * Middleware de contrôle d'autorisations côté serveur par permission métier.
 * Rejette tout utilisateur non autorisé avec HTTP 403.
 */
export function requirePermission(...required: PermissionKey[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({
        success: false,
        error: 'Authentification requise',
      });
      return;
    }
    if (!hasPermission(req.auth.permissions, required, req.auth.role)) {
      res.status(403).json({
        success: false,
        error: {
          code: 'FORBIDDEN_PERMISSION',
          message: 'Accès refusé : votre rôle ne dispose pas des autorisations nécessaires pour cette action.',
          requiredPermissions: required,
        },
      });
      return;
    }
    next();
  };
}
