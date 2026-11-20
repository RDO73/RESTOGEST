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
import { adminPool } from '../db/pool.js';

declare global {
  namespace Express {
    interface Request {
      auth?: VerifiedSession;
    }
  }
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

    // Vérification persistante dans public.user_sessions (survit aux redémarrages & multi-instances serverless)
    if (session.role !== 'SUPER_ADMIN') {
      try {
        const dbSession = await adminPool.query(
          `SELECT revoked_at, expires_at FROM public.user_sessions WHERE token_hash = $1 LIMIT 1`,
          [session.tokenHash]
        );
        if (dbSession.rows.length > 0) {
          const row = dbSession.rows[0];
          const isExpired = row.expires_at && new Date(row.expires_at).getTime() <= Date.now();
          if (row.revoked_at !== null || isExpired) {
            markTokenRevoked(session.tokenHash);
            res.status(401).json({
              success: false,
              error: 'Session révoquée ou expirée',
            });
            return;
          }
        }
      } catch {
        // Si la table n'est pas encore initialisée (ex. cold-start démo PGlite), le contexte RLS vérifie ensuite
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
