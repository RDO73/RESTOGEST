import type { Request, Response, NextFunction } from 'express';
import { verifySessionToken, type VerifiedSession } from '../auth/jwt.js';

declare global {
  namespace Express {
    interface Request {
      auth?: VerifiedSession;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      error: 'Authentification requise : Jeton Bearer manquant',
    });
    return;
  }

  const token = authHeader.substring(7);

  try {
    const session = verifySessionToken(token);
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
