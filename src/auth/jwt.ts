import crypto from 'node:crypto';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';

export interface TokenPayload {
  userId: string;
  companyId: string;
  tenantId: string;
  role: string;
  email: string;
  fullName?: string;
  companyName?: string;
  businessType?: 'restaurant' | 'pastry_shop' | 'both';
  currency?: string;
  isDemo: boolean;
  jti: string;
}

export interface VerifiedSession extends TokenPayload {
  tokenHash: string;
}

export const SESSION_COOKIE_NAME = 'restogest_session';

const revokedTokenHashes = new Set<string>();

/**
 * Calcule le token_hash stocké dans public.user_sessions à partir du JTI
 */
export function hashJti(jti: string): string {
  return crypto.createHash('sha256').update(jti).digest('hex');
}

export function markTokenRevoked(tokenHash: string): void {
  revokedTokenHashes.add(tokenHash);
}

export function isTokenRevoked(tokenHash: string): boolean {
  return revokedTokenHashes.has(tokenHash);
}

export function getSessionCookieOptions() {
  return {
    path: '/',
    sameSite: 'lax' as const,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 24 * 60 * 60 * 1000,
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    sameSite: 'lax' as const,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  });
}

export function extractTokenFromCookieHeader(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === SESSION_COOKIE_NAME && rest.length > 0) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
}

/**
 * Génère un JWT applicatif auto-porteur signé HMAC SHA-256 et calcule son hash de session
 */
export function generateSessionToken(
  userId: string,
  companyId: string,
  meta?: Partial<Omit<TokenPayload, 'userId' | 'companyId' | 'jti'>>
): { token: string; jti: string; tokenHash: string } {
  const jti = crypto.randomUUID();
  const payload: TokenPayload = {
    userId,
    companyId,
    tenantId: meta?.tenantId || companyId,
    role: meta?.role || 'owner',
    email: meta?.email || 'owner@restogest.sn',
    ...(meta?.fullName ? { fullName: meta.fullName } : {}),
    ...(meta?.companyName ? { companyName: meta.companyName } : {}),
    ...(meta?.businessType ? { businessType: meta.businessType } : {}),
    ...(meta?.currency ? { currency: meta.currency } : {}),
    isDemo: Boolean(meta?.isDemo),
    jti,
  };

  const token = jwt.sign(payload, config.jwt.secret, {
    algorithm: 'HS256',
    expiresIn: config.jwt.expiresIn as any,
  });
  const tokenHash = hashJti(jti);
  return { token, jti, tokenHash };
}

/**
 * Vérifie l'authenticité HMAC SHA-256 d'un JWT et extrait le contexte de session stateless
 */
export function verifySessionToken(token: string): VerifiedSession {
  const decoded = jwt.verify(token, config.jwt.secret, {
    algorithms: ['HS256'],
  }) as Partial<TokenPayload>;

  if (!decoded.jti || !decoded.userId || (!decoded.companyId && !decoded.tenantId)) {
    throw new Error('Payload de session incomplet');
  }

  const companyId = decoded.companyId || decoded.tenantId!;
  const tenantId = decoded.tenantId || decoded.companyId!;
  const tokenHash = hashJti(decoded.jti);

  return {
    userId: decoded.userId,
    companyId,
    tenantId,
    role: decoded.role || 'owner',
    email: decoded.email || 'owner@restogest.sn',
    ...(decoded.fullName ? { fullName: decoded.fullName } : {}),
    ...(decoded.companyName ? { companyName: decoded.companyName } : {}),
    ...(decoded.businessType ? { businessType: decoded.businessType } : {}),
    ...(decoded.currency ? { currency: decoded.currency } : {}),
    isDemo: Boolean(decoded.isDemo),
    jti: decoded.jti,
    tokenHash,
  };
}
