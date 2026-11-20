import crypto from 'node:crypto';
import type { Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env.js';
import type { PermissionsMap } from './permissions.js';

export interface TokenPayload {
  userId: string;
  companyId: string;
  tenantId: string;
  role: string;
  roleName?: string;
  permissions?: PermissionsMap;
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
export const ADMIN_SESSION_COOKIE_NAME = 'restogest_admin_session';
export const CSRF_COOKIE_NAME = 'restogest_csrf';

const revokedTokenHashes = new Set<string>();

/**
 * Convertit une durée JWT (ex: "24h", "7d", "30m", "3600s") en millisecondes
 */
export function parseExpiresInToMs(expiresIn: string): number {
  const raw = String(expiresIn || '24h').trim().toLowerCase();
  const match = raw.match(/^(\d+)\s*([smhd])?$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1], 10);
  const unit = match[2] || 's';
  const mult: Record<string, number> = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return Math.max(60 * 1000, value * (mult[unit] || 1000));
}

function isSecureCookieEnv(): boolean {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

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

export function clearInMemoryRevocationForTests(tokenHash?: string): void {
  if (tokenHash) revokedTokenHashes.delete(tokenHash);
  else revokedTokenHashes.clear();
}

export function getSessionCookieOptions() {
  return {
    path: '/',
    sameSite: 'strict' as const,
    httpOnly: true,
    secure: isSecureCookieEnv(),
    maxAge: parseExpiresInToMs(config.jwt.expiresIn),
  };
}

export function getCsrfCookieOptions() {
  return {
    path: '/',
    sameSite: 'strict' as const,
    httpOnly: false,
    secure: isSecureCookieEnv(),
    maxAge: parseExpiresInToMs(config.jwt.expiresIn),
  };
}

export function setCsrfCookie(res: Response): string {
  const csrfToken = crypto.randomBytes(32).toString('hex');
  res.cookie(CSRF_COOKIE_NAME, csrfToken, getCsrfCookieOptions());
  return csrfToken;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions());
  setCsrfCookie(res);
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    sameSite: 'strict' as const,
    httpOnly: true,
    secure: isSecureCookieEnv(),
  });
}

export function setAdminSessionCookie(res: Response, token: string): void {
  res.cookie(ADMIN_SESSION_COOKIE_NAME, token, getSessionCookieOptions());
  setCsrfCookie(res);
}

export function clearAdminSessionCookie(res: Response): void {
  res.clearCookie(ADMIN_SESSION_COOKIE_NAME, {
    path: '/',
    sameSite: 'strict' as const,
    httpOnly: true,
    secure: isSecureCookieEnv(),
  });
}

export function extractNamedCookie(cookieHeader: string | undefined, cookieName: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === cookieName && rest.length > 0) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
}

export function extractTokenFromCookieHeader(
  cookieHeader?: string,
  cookieName: string = SESSION_COOKIE_NAME
): string | null {
  return extractNamedCookie(cookieHeader, cookieName);
}

export function verifyCsrfTokenMatch(headerToken: string | undefined, cookieToken: string | null): boolean {
  if (!headerToken || !cookieToken) return false;
  const a = Buffer.from(String(headerToken).trim(), 'utf8');
  const b = Buffer.from(String(cookieToken).trim(), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
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
    ...(meta?.roleName ? { roleName: meta.roleName } : {}),
    ...(meta?.permissions ? { permissions: meta.permissions } : {}),
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
    ...(decoded.roleName ? { roleName: decoded.roleName } : {}),
    ...(decoded.permissions ? { permissions: decoded.permissions } : {}),
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
