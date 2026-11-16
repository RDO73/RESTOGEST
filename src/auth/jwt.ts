import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

export interface TokenPayload {
  userId: string;
  companyId: string;
  jti: string;
}

export interface VerifiedSession {
  userId: string;
  companyId: string;
  jti: string;
  tokenHash: string;
}

/**
 * Calcule le token_hash stocké dans public.user_sessions à partir du JTI
 */
export function hashJti(jti: string): string {
  return crypto.createHash('sha256').update(jti).digest('hex');
}

/**
 * Génère un JWT applicatif et calcule son hash de session
 */
export function generateSessionToken(userId: string, companyId: string): { token: string; jti: string; tokenHash: string } {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { userId, companyId, jti },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn as any }
  );
  const tokenHash = hashJti(jti);
  return { token, jti, tokenHash };
}

/**
 * Vérifie l'authenticité d'un JWT et extrait le contexte de session
 */
export function verifySessionToken(token: string): VerifiedSession {
  const decoded = jwt.verify(token, config.jwt.secret) as TokenPayload;
  const tokenHash = hashJti(decoded.jti);

  return {
    userId: decoded.userId,
    companyId: decoded.companyId,
    jti: decoded.jti,
    tokenHash,
  };
}
