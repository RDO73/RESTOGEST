import type { Request, Response, NextFunction } from 'express';
import {
  extractTokenFromCookieHeader,
  isTokenRevoked,
  verifySessionToken,
  type VerifiedSession,
} from '../auth/jwt.js';

declare global {
  namespace Express {
    interface Request {
      auth?: VerifiedSession;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  let token: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else {
    token = extractTokenFromCookieHeader(req.headers.cookie);
  }

  if (!token) {
    res.status(401).json({
      success: false,
      error: 'Authentification requise : Jeton Bearer ou Cookie de session manquant',
    });
    return;
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
    req.auth = session;
    next();
  } catch (error: any) {
    res.status(401).json({
      success: false,
      error: 'Jeton de session invalide ou expiré',
      details: error.message,
    });
  }
}
