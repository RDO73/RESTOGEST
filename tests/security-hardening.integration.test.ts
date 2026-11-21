import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { IDbPool } from '../src/db/pool.js';
import { clearRateLimitStoreForTests } from '../src/middlewares/rate-limit.js';
import { errorHandler } from '../src/middlewares/error-handler.js';

let server: Server;
let baseUrl = '';
let tempDataDir: string | null = null;
let adminPoolRef: IDbPool | null = null;
let appPoolRef: IDbPool | null = null;

async function api(
  endpoint: string,
  opts: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-json response
  }
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie') as string]
        : [];
  return { status: res.status, body: json, text, headers: res.headers, setCookies };
}

beforeAll(async () => {
  if (process.env.RUN_INTEGRATION_ON_POSTGRES !== 'true') {
    process.env.DATABASE_TYPE = 'embedded';
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restogest-sec-'));
    process.env.PGLITE_DATA_DIR = tempDataDir;
  }

  const [{ app }, { adminPool, appPool }, { applyMigrations }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pool.js'),
    import('../src/db/migrate.js'),
  ]);

  adminPoolRef = adminPool;
  appPoolRef = appPool;
  await applyMigrations(adminPool);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

beforeEach(() => {
  clearRateLimitStoreForTests();
});

afterAll(async () => {
  clearRateLimitStoreForTests();
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (appPoolRef && typeof (appPoolRef as any).end === 'function') {
    await (appPoolRef as any).end().catch(() => {});
  }
  if (adminPoolRef && adminPoolRef !== appPoolRef && typeof (adminPoolRef as any).end === 'function') {
    await (adminPoolRef as any).end().catch(() => {});
  }
  if (tempDataDir) {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

describe('Phase 6 — Sécurité HTTP, Rate-Limiting & Contrôle Exclusif Propriétaire', () => {
  it('1. Applique les en-têtes HTTP de sécurité et masque X-Powered-By', async () => {
    const res = await api('/health');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-powered-by')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const csp = res.headers.get('content-security-policy') || '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('2. Bloque les visiteurs non connectés (401) et les restaurateurs (403) sur le Centre de Contrôle Propriétaire', async () => {
    // Niveau 1 : Visiteur anonyme -> 401 sur toutes les routes privées & admin
    for (const url of [
      '/api/admin/auth/me',
      '/api/admin/establishments',
      '/api/admin/users',
      '/api/admin/audit-logs',
      '/api/subscriptions/admin/overview',
      '/api/sales',
    ]) {
      const r = await api(url);
      expect(r.status, `Anonyme sur ${url}`).toBe(401);
    }

    // Niveau 2 : Inscription d'un restaurateur (même s'il tente d'injecter role=SUPER_ADMIN dans le corps)
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Chez Maman Diallo',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: `gerant-sec-${Date.now()}@restogest.test`,
        password: 'RestoUser2026!',
        fullName: 'Maman Diallo',
        role: 'SUPER_ADMIN',
        acceptTerms: true,
      },
    });
    expect(reg.status).toBe(201);
    const restoToken = reg.body.data.token as string;
    const companyId = reg.body.data.companyId as string;
    const userId = reg.body.data.userId as string;

    // Un restaurateur authentifié reçoit STRICTEMENT 403 sur toutes les routes Propriétaire / Super-Admin
    for (const reqSpec of [
      { method: 'GET', url: '/api/admin/auth/me' },
      { method: 'GET', url: '/api/admin/establishments' },
      { method: 'GET', url: '/api/admin/users' },
      { method: 'GET', url: '/api/admin/audit-logs' },
      { method: 'GET', url: '/api/subscriptions/admin/overview' },
      { method: 'POST', url: `/api/admin/establishments/${companyId}/status`, body: { isActive: false } },
      { method: 'POST', url: `/api/admin/users/${userId}/status`, body: { isActive: false } },
    ]) {
      const r = await api(reqSpec.url, {
        method: reqSpec.method,
        token: restoToken,
        body: reqSpec.body,
      });
      expect(r.status, `Restaurateur sur ${reqSpec.method} ${reqSpec.url}`).toBe(403);
    }

    // Même un jeton portant role='SUPER_ADMIN' mais avec un userId étranger est rejeté (403)
    const { generateSessionToken } = await import('../src/auth/jwt.js');
    const spoofed = generateSessionToken(userId, companyId, {
      role: 'SUPER_ADMIN',
      email: 'fake@restogest.test',
    });
    const spoofAdminRes = await api('/api/admin/establishments', { token: spoofed.token });
    expect(spoofAdminRes.status).toBe(403);
    const spoofSubRes = await api('/api/subscriptions/admin/overview', { token: spoofed.token });
    expect(spoofSubRes.status).toBe(403);
  });

  it('3. Autorise exclusivement le Propriétaire (/admin) : gestion établissements, utilisateurs, journaux & suspension immédiate', async () => {
    const { config } = await import('../src/config/env.js');

    // Créer un établissement cible pour tester suspension & réactivation
    const targetEmail = `target-suspend-${Date.now()}@restogest.test`;
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Café Corniche Dakar',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: targetEmail,
        password: 'CafeCorniche2026!',
        fullName: 'Ousmane Ndiaye',
        acceptTerms: true,
      },
    });
    expect(reg.status).toBe(201);
    const targetToken = reg.body.data.token as string;
    const targetCompanyId = reg.body.data.companyId as string;

    // Connexion exclusive du Propriétaire avec ses identifiants actuels (cookie HttpOnly + CSRF)
    const loginRes = await api('/api/admin/auth/login', {
      method: 'POST',
      body: {
        email: config.superAdmin.email,
        password: config.superAdmin.password,
      },
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.data.user.role).toBe('SUPER_ADMIN');

    const adminCookie = loginRes.setCookies.find((c) => c.startsWith('restogest_admin_session='))?.split(';')[0];
    const csrfCookie = loginRes.setCookies.find((c) => c.startsWith('restogest_csrf='))?.split(';')[0];
    expect(adminCookie).toBeTruthy();
    expect(csrfCookie).toBeTruthy();
    const csrfVal = decodeURIComponent(csrfCookie!.split('=')[1]);
    const cookieHeader = `${adminCookie}; ${csrfCookie}`;

    // Accès complet via cookie HttpOnly
    const meRes = await api('/api/admin/auth/me', { headers: { Cookie: cookieHeader } });
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.role).toBe('SUPER_ADMIN');

    const estRes = await api('/api/admin/establishments', { headers: { Cookie: cookieHeader } });
    expect(estRes.status).toBe(200);
    expect(estRes.body.data.some((c: any) => c.id === targetCompanyId)).toBe(true);

    const usersRes = await api('/api/admin/users', { headers: { Cookie: cookieHeader } });
    expect(usersRes.status).toBe(200);
    const listedUser = usersRes.body.data.find((u: any) => u.email === targetEmail);
    expect(listedUser).toBeTruthy();
    expect(listedUser.password_hash).toBeUndefined();

    const overviewRes = await api('/api/subscriptions/admin/overview', { headers: { Cookie: cookieHeader } });
    expect(overviewRes.status).toBe(200);

    // Suspension de l'établissement (doit exiger CSRF avec cookie, puis révoquer immédiatement la session du restaurateur)
    const noCsrfSuspend = await api(`/api/admin/establishments/${targetCompanyId}/status`, {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: { isActive: false },
    });
    expect(noCsrfSuspend.status).toBe(403);

    const suspendRes = await api(`/api/admin/establishments/${targetCompanyId}/status`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfVal },
      body: { isActive: false, reason: 'Test suspension' },
    });
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body.data.isActive).toBe(false);

    // La session du restaurateur suspendu doit être immédiatement rejetée (401)
    const kickedRes = await api('/api/auth/me', { token: targetToken });
    expect(kickedRes.status).toBe(401);

    // Réactivation de l'établissement
    const reactivateRes = await api(`/api/admin/establishments/${targetCompanyId}/status`, {
      method: 'POST',
      headers: { Cookie: cookieHeader, 'X-CSRF-Token': csrfVal },
      body: { isActive: true, reason: 'Test réactivation' },
    });
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body.data.isActive).toBe(true);

    // Vérification des journaux d'activité (aucun secret exposé)
    const logsRes = await api('/api/admin/audit-logs?limit=50', { headers: { Cookie: cookieHeader } });
    expect(logsRes.status).toBe(200);
    expect(Array.isArray(logsRes.body.data)).toBe(true);
    expect(logsRes.body.data.some((l: any) => l.action === 'SUPER_ADMIN_ESTABLISHMENT_SUSPENDED')).toBe(true);
    const serialized = JSON.stringify(logsRes.body.data);
    expect(serialized).not.toContain('password_hash');
    expect(serialized).not.toContain(config.superAdmin.password);
  });

  it('4. Applique le rate-limiting (5 échecs / 15 min -> HTTP 429) sur /api/auth/login et /api/admin/auth/login', async () => {
    // 4a. Login client : 5 tentatives échouées -> 401 générique, 6e -> 429
    const testEmail = 'brute-client@restogest.test';
    for (let i = 0; i < 5; i++) {
      const r = await api('/api/auth/login', {
        method: 'POST',
        body: { email: testEmail, password: 'WrongPassword123!' },
      });
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('Identifiants invalides');
    }
    const blockedClient = await api('/api/auth/login', {
      method: 'POST',
      body: { email: testEmail, password: 'WrongPassword123!' },
    });
    expect(blockedClient.status).toBe(429);
    expect(blockedClient.headers.get('retry-after')).toBeTruthy();

    // 4b. Login Super-Admin : 5 tentatives échouées -> 401 générique, 6e -> 429
    const adminEmail = 'brute-admin@restogest.test';
    for (let i = 0; i < 5; i++) {
      const r = await api('/api/admin/auth/login', {
        method: 'POST',
        body: { email: adminEmail, password: 'BadAdminPassword!' },
      });
      expect(r.status).toBe(401);
    }
    const blockedAdmin = await api('/api/admin/auth/login', {
      method: 'POST',
      body: { email: adminEmail, password: 'BadAdminPassword!' },
    });
    expect(blockedAdmin.status).toBe(429);
    expect(blockedAdmin.headers.get('retry-after')).toBeTruthy();
  });

  it('5. Masque les détails SQL et stack traces dans les erreurs en production', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      let capturedStatus = 0;
      let capturedBody: any = null;
      const mockRes: any = {
        status(code: number) {
          capturedStatus = code;
          return this;
        },
        json(payload: any) {
          capturedBody = payload;
          return this;
        },
      };

      const pgErr: any = new Error('duplicate key value violates unique constraint "uq_users_email_lower"');
      pgErr.code = '23505';
      pgErr.detail = 'Key (lower(email))=(secret@myrestogest.com) already exists.';

      errorHandler(pgErr, {} as any, mockRes, (() => {}) as any);
      expect(capturedStatus).toBe(409);
      expect(JSON.stringify(capturedBody)).not.toContain('uq_users_email_lower');
      expect(JSON.stringify(capturedBody)).not.toContain('secret@myrestogest.com');
      expect(capturedBody.details).toBeUndefined();

      // Test erreur 500 générique
      const internalErr = new Error('FATAL: password authentication failed for user "neondb_owner"');
      errorHandler(internalErr, {} as any, mockRes, (() => {}) as any);
      expect(capturedStatus).toBe(500);
      expect(JSON.stringify(capturedBody)).not.toContain('neondb_owner');
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
  });
});
