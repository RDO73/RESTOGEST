import { describe, it, expect } from 'vitest';
import {
  hashJti,
  generateSessionToken,
  verifySessionToken,
  getSessionCookieOptions,
} from '../src/auth/jwt.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('Authentification et Sécurité des Sessions RESTOGEST', () => {
  it('hashJti doit générer un condensat SHA-256 hexadécimal de 64 caractères', () => {
    const jti = 'b27a3c70-13b7-4b71-9b16-9b57ce69837a';
    const hash = hashJti(jti);

    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    // Déterminisme
    expect(hashJti(jti)).toBe(hash);
  });

  it('generateSessionToken doit produire un token JWT valide et son tokenHash associé', () => {
    const userId = '11111111-1111-1111-1111-111111111111';
    const companyId = '22222222-2222-2222-2222-222222222222';

    const { token, jti, tokenHash } = generateSessionToken(userId, companyId);

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(jti).toBeDefined();
    expect(tokenHash).toBe(hashJti(jti));

    const verified = verifySessionToken(token);
    expect(verified.userId).toBe(userId);
    expect(verified.companyId).toBe(companyId);
    expect(verified.tenantId).toBe(companyId);
    expect(verified.role).toBe('owner');
    expect(verified.isDemo).toBe(false);
    expect(verified.jti).toBe(jti);
    expect(verified.tokenHash).toBe(tokenHash);
  });

  it('generateSessionToken démo et options de cookie Vercel (stateless HMAC-SHA256)', () => {
    const userId = '00000000-0000-4000-8000-000000000002';
    const tenantId = '00000000-0000-4000-8000-000000000001';
    const { token } = generateSessionToken(userId, tenantId, {
      tenantId,
      role: 'owner',
      email: 'demo@restogest.sn',
      isDemo: true,
    });

    const verified = verifySessionToken(token);
    expect(verified.userId).toBe(userId);
    expect(verified.tenantId).toBe(tenantId);
    expect(verified.companyId).toBe(tenantId);
    expect(verified.role).toBe('owner');
    expect(verified.email).toBe('demo@restogest.sn');
    expect(verified.isDemo).toBe(true);

    const cookieOpts = getSessionCookieOptions();
    expect(cookieOpts.path).toBe('/');
    expect(cookieOpts.sameSite).toBe('strict');
    expect(cookieOpts.httpOnly).toBe(true);
    expect(cookieOpts.secure).toBe(process.env.NODE_ENV === 'production');
  });

  it('hashPassword et verifyPassword doivent hacher et valider correctement les mots de passe', async () => {
    const rawPassword = 'SecurePasswordResto2026!';
    const hash = await hashPassword(rawPassword);

    expect(hash).toBeDefined();
    expect(hash).not.toBe(rawPassword);

    const isValid = await verifyPassword(hash, rawPassword);
    expect(isValid).toBe(true);

    const isInvalid = await verifyPassword(hash, 'MauvaisMotDePasse');
    expect(isInvalid).toBe(false);
  });
});
