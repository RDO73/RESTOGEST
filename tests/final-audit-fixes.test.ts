import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IDbPool } from '../src/db/pool.js';

let server: Server;
let baseUrl = '';
let tempDataDir: string | null = null;
let adminPoolRef: IDbPool | null = null;
let appPoolRef: IDbPool | null = null;
let superAdminToken = '';
let originalNodeEnv: string | undefined;

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
  if (opts.token !== undefined) headers.Authorization = `Bearer ${opts.token}`;
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
  return { status: res.status, body: json, text, headers: res.headers };
}

beforeAll(async () => {
  originalNodeEnv = process.env.NODE_ENV;
  if (process.env.RUN_INTEGRATION_ON_POSTGRES !== 'true') {
    process.env.DATABASE_TYPE = 'embedded';
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restogest-final-audit-'));
    process.env.PGLITE_DATA_DIR = tempDataDir;
  }

  const [{ app }, { adminPool, appPool }, { applyMigrations, getLatestMigrationFilename }, { config }] =
    await Promise.all([
      import('../src/app.js'),
      import('../src/db/pool.js'),
      import('../src/db/migrate.js'),
      import('../src/config/env.js'),
    ]);

  adminPoolRef = adminPool;
  appPoolRef = appPool;
  const migResult = await applyMigrations(adminPool);
  expect(migResult.applied.concat(migResult.skipped)).toContain(getLatestMigrationFilename());

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as any;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });

  const adminLogin = await api('/api/admin/auth/login', {
    method: 'POST',
    body: {
      email: config.superAdmin.email,
      password: config.superAdmin.password,
    },
  });
  expect(adminLogin.status).toBe(200);
  superAdminToken = adminLogin.body.data.token;
}, 30000);

afterAll(async () => {
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (appPoolRef && typeof (appPoolRef as any).end === 'function') {
    await (appPoolRef as any).end().catch(() => {});
  }
  if (adminPoolRef && adminPoolRef !== appPoolRef && typeof (adminPoolRef as any).end === 'function') {
    await (adminPoolRef as any).end().catch(() => {});
  }
  if (tempDataDir && fs.existsSync(tempDataDir)) {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

describe('Audit Global & Pré-Production — Corrections Complètes MyRestoGest', () => {
  it('1. Migration 013 : backfill des abonnements manquants, plan_code NULL et coordonnées marchand', async () => {
    const pubPlansRes = await api('/api/subscriptions/plans/public');
    expect(pubPlansRes.status).toBe(200);

    const recentCompId = crypto.randomUUID();
    const oldCompId = crypto.randomUUID();
    const nullPlanCompId = crypto.randomUUID();

    await adminPoolRef!.query(
      `INSERT INTO public.companies (id, name, business_type, country_code, currency, created_at)
       VALUES
         ($1, 'Établissement Récent Sans Sub', 'restaurant', 'SN', 'XOF', NOW() - INTERVAL '3 days'),
         ($2, 'Établissement Ancien Sans Sub', 'restaurant', 'GN', 'GNF', NOW() - INTERVAL '25 days'),
         ($3, 'Établissement Plan Null', 'restaurant', 'SN', 'XOF', NOW() - INTERVAL '2 days')`,
      [recentCompId, oldCompId, nullPlanCompId]
    );

    await adminPoolRef!.query(
      `INSERT INTO public.company_subscriptions (
         company_id, plan_id, plan_code, status, billing_period, current_period_start, current_period_end
       )
       VALUES ($1, NULL, NULL, 'active', 'monthly', NOW(), NOW() + INTERVAL '30 days')`,
      [nullPlanCompId]
    );

    await adminPoolRef!.query(
      `UPDATE public.saas_merchant_settings
       SET brand_name = 'RESTOGEST SaaS',
           whatsapp_phone = '+221 77 000 00 00',
           support_phone = '+221 77 000 00 00',
           support_email = 'facturation@myrestogest.com'`
    );

    const sql013 = fs.readFileSync(
      path.resolve(process.cwd(), 'src/schema/migrations/013_production_backfill_and_hardening.sql'),
      'utf8'
    );
    await (adminPoolRef as any).exec(sql013);

    const subsRes = await adminPoolRef!.query(
      `SELECT company_id, plan_code, plan_id, status
       FROM public.company_subscriptions
       WHERE company_id = ANY($1::uuid[])`,
      [[recentCompId, oldCompId, nullPlanCompId]]
    );
    const byComp = new Map(subsRes.rows.map((r: any) => [r.company_id, r]));

    expect(byComp.get(recentCompId)?.status).toBe('trial');
    expect(byComp.get(recentCompId)?.plan_code).toBe('PRO');
    expect(byComp.get(oldCompId)?.status).toBe('expired');
    expect(byComp.get(oldCompId)?.plan_code).toBe('PRO');
    expect(byComp.get(nullPlanCompId)?.plan_code).toBe('PRO');
    expect(byComp.get(nullPlanCompId)?.plan_id).toBeTruthy();

    const merchRes = await adminPoolRef!.query(
      `SELECT brand_name, whatsapp_phone, support_phone, support_email
       FROM public.saas_merchant_settings
       ORDER BY created_at ASC LIMIT 1`
    );
    expect(merchRes.rows[0].brand_name).toBe('MyRestoGest');
    expect(merchRes.rows[0].whatsapp_phone).toBe('+221 78 897 93 42');
    expect(merchRes.rows[0].support_phone).toBe('+221 78 897 93 42');
    expect(merchRes.rows[0].support_email).toBe('hadirydrame@gmail.com');
  });

  it('2. Super-Admin POST /api/admin/establishments/demo : crée un compte démo immédiatement utilisable sans 403 ni oubli CGU', async () => {
    const demoEmail = `demo.sa.${Date.now()}@myrestogest.com`;
    const demoRes = await api('/api/admin/establishments/demo', {
      method: 'POST',
      token: superAdminToken,
      body: {
        companyName: 'Bistro Plateau Test',
        email: demoEmail,
        password: 'DemoPassword2026!',
        countryCode: 'SN',
        status: 'trial',
      },
    });
    expect(demoRes.status).toBe(201);
    const { companyId, userId } = demoRes.body.data;

    const loginRes = await api('/api/auth/login', {
      method: 'POST',
      body: { email: demoEmail, password: 'DemoPassword2026!' },
    });
    expect(loginRes.status).toBe(200);
    const demoToken = loginRes.body.data.token;

    const meRes = await api('/api/auth/me', { token: demoToken });
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.termsStatus.accepted).toBe(true);
    expect(meRes.body.data.termsStatus.requiresReacceptance).toBe(false);
    expect(meRes.body.data.subscriptionStatus.status).toBe('trial');
    expect(meRes.body.data.subscriptionStatus.isReadOnly).toBe(false);

    // L'établissement démo créé par Super-Admin peut immédiatement créer un produit et une vente
    const prodRes = await api('/api/catalog/products', {
      method: 'POST',
      token: demoToken,
      body: { name: 'Thiéboudienne Test Démo SA', sellingPrice: 4500 },
    });
    expect(prodRes.status).toBe(201);

    const termsRow = await adminPoolRef!.query(
      `SELECT acceptance_source FROM public.user_terms_acceptances WHERE company_id = $1 AND user_id = $2`,
      [companyId, userId]
    );
    expect(termsRow.rows[0]?.acceptance_source).toBe('admin_demo');
  });

  it('3. Produits archivés (soft-delete) : absents du catalogue/stock actif et bloqués en nouvelle vente, historique préservé', async () => {
    const ownerEmail = `archive.test.${Date.now()}@myrestogest.com`;
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Chez Awa Archivage',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: ownerEmail,
        password: 'Password2026!',
        fullName: 'Awa Ndiaye',
        acceptTerms: true,
      },
    });
    expect(reg.status).toBe(201);
    const token = reg.body.data.token;

    const prod = await api('/api/catalog/products', {
      method: 'POST',
      token,
      body: {
        name: 'Poulet Braisé Archivable',
        productType: 'finished_good',
        sellingPrice: 5500,
        costPrice: 2000,
        inventoryTracking: 'direct',
        minStockAlert: 2,
      },
    });
    expect(prod.status).toBe(201);
    const prodId = prod.body.data.id;

    // Mouvement de stock + vente existante
    const adj = await api('/api/inventory/adjustments', {
      method: 'POST',
      token,
      body: { productId: prodId, movementType: 'production_in', quantityDelta: 10, notes: 'Stock initial' },
    });
    expect(adj.status).toBe(201);

    const sale1 = await api('/api/sales', { method: 'POST', token, body: {} });
    expect(sale1.status).toBe(201);
    const add1 = await api(`/api/sales/${sale1.body.data.id}/items`, {
      method: 'POST',
      token,
      body: { productId: prodId, quantity: 1 },
    });
    expect(add1.status).toBe(201);

    // Suppression logique (car historique existant)
    const del = await api(`/api/catalog/products/${prodId}`, { method: 'DELETE', token });
    expect(del.status).toBe(200);
    expect(del.body.data.mode).toBe('deactivated');

    // Absent du catalogue actif et des niveaux/alertes de stock actifs
    const catalogActive = await api('/api/catalog/products', { token });
    expect(catalogActive.status).toBe(200);
    expect(catalogActive.body.data.find((p: any) => p.id === prodId)).toBeUndefined();

    const catalogAll = await api('/api/catalog/products?includeInactive=true', { token });
    expect(catalogAll.status).toBe(200);
    expect(catalogAll.body.data.find((p: any) => p.id === prodId)?.is_active).toBe(false);

    const levelsRes = await api('/api/inventory/levels', { token });
    expect(levelsRes.status).toBe(200);
    expect(levelsRes.body.data.find((l: any) => l.product_id === prodId)).toBeUndefined();

    // Historique des mouvements et ancienne vente intacts
    const movementsRes = await api('/api/inventory/movements', { token });
    expect(movementsRes.status).toBe(200);
    expect(movementsRes.body.data.find((m: any) => m.product_id === prodId)).toBeDefined();

    const sale1Detail = await api(`/api/sales/${sale1.body.data.id}`, { token });
    expect(sale1Detail.status).toBe(200);
    expect(sale1Detail.body.data.items).toHaveLength(1);

    // Impossible d'ajouter le produit archivé dans une nouvelle vente (même avec unitPrice explicite)
    const sale2 = await api('/api/sales', { method: 'POST', token, body: {} });
    expect(sale2.status).toBe(201);
    const blockedAdd = await api(`/api/sales/${sale2.body.data.id}/items`, {
      method: 'POST',
      token,
      body: { productId: prodId, quantity: 1, unitPrice: 5500 },
    });
    expect(blockedAdd.status).toBe(409);
    expect(blockedAdd.body.error.code).toBe('PRODUCT_ARCHIVED');
  });

  it('4. Cookies HttpOnly + Authorization Bearer vide, QR Settings PUT, Statuts 404/409 en mode prod et pagination sûre', async () => {
    const email = `qr.http.test.${Date.now()}@myrestogest.com`;
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Le Baobab QR Test',
        businessType: 'restaurant',
        countryCode: 'SN',
        email,
        password: 'Password2026!',
        fullName: 'Ibrahima Fall',
        acceptTerms: true,
      },
    });
    expect(reg.status).toBe(201);

    // Extraire le cookie HttpOnly de session retourné à l'inscription/login
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { email, password: 'Password2026!' },
    });
    expect(login.status).toBe(200);
    const setCookies = (login.headers as any).getSetCookie
      ? (login.headers as any).getSetCookie()
      : [login.headers.get('set-cookie') || ''];
    const cookieHeader = setCookies
      .map((c: string) => c.split(';')[0])
      .filter(Boolean)
      .join('; ');
    const token = login.body.data.token;

    // Créer une table et tester GET qrcode.svg avec cookie + "Authorization: Bearer " vide
    const tbl = await api('/api/qr/tables', {
      method: 'POST',
      token,
      body: { code: 'T88', name: 'Table 88', zone: 'Terrasse', seats: 4 },
    });
    expect(tbl.status).toBe(201);

    const svgWithEmptyBearerAndCookie = await fetch(
      `${baseUrl}/api/qr/tables/${tbl.body.data.id}/qrcode.svg`,
      {
        headers: {
          Authorization: 'Bearer ',
          Cookie: cookieHeader,
        },
      }
    );
    expect(svgWithEmptyBearerAndCookie.status).toBe(200);
    const svgText = await svgWithEmptyBearerAndCookie.text();
    expect(svgText).toContain('<svg');

    // Tester PUT /api/qr/settings (corrigé pour correspondre aux vraies colonnes SQL)
    const updQrSettings = await api('/api/qr/settings', {
      method: 'PUT',
      token,
      body: {
        displayName: 'Le Baobab Express',
        tagline: 'Cuisine sénégalaise authentique',
        phone: '+221771234567',
        whatsappPhone: '+221788979342',
        address: 'Dakar Almadies',
        welcomeMessage: 'Bienvenue chez nous !',
        qrOrderingEnabled: true,
        allowCallWaiter: true,
        allowRequestBill: false,
        autoAcceptOrders: true,
      },
    });
    expect(updQrSettings.status).toBe(200);
    expect(updQrSettings.body.data.display_name).toBe('Le Baobab Express');
    expect(updQrSettings.body.data.whatsapp_phone).toBe('+221788979342');
    expect(updQrSettings.body.data.allow_request_bill).toBe(false);
    expect(updQrSettings.body.data.auto_accept_orders).toBe(true);

    // Simuler NODE_ENV=production : vérifier que les erreurs métier renvoient 404/409 (et jamais 500 générique)
    process.env.NODE_ENV = 'production';

    const saleRes = await api('/api/sales', { method: 'POST', token, body: {} });
    expect(saleRes.status).toBe(201);

    const missingProd = await api(`/api/sales/${saleRes.body.data.id}/items`, {
      method: 'POST',
      token,
      body: { productId: crypto.randomUUID(), quantity: 1 },
    });
    expect(missingProd.status).toBe(404);
    expect(missingProd.body.error.code).toBe('PRODUCT_NOT_FOUND');

    const cash1 = await api('/api/cash/sessions/open', {
      method: 'POST',
      token,
      body: { openingAmount: 10000 },
    });
    expect(cash1.status).toBe(201);

    const cashDup = await api('/api/cash/sessions/open', {
      method: 'POST',
      token,
      body: { openingAmount: 5000 },
    });
    expect(cashDup.status).toBe(409);
    expect(cashDup.body.error.code).toBe('CASH_SESSION_ALREADY_OPEN');

    // Pagination avec valeurs invalides / négatives -> 200 (pas 500)
    const [pSales, pLevels, pMoves, pSess, pExp, pPurch, pOrders] = await Promise.all([
      api('/api/sales?limit=abc&offset=-5', { token }),
      api('/api/inventory/levels?limit=9999&offset=-1', { token }),
      api('/api/inventory/movements?limit=0&offset=foo', { token }),
      api('/api/cash/sessions?limit=bad&offset=-3', { token }),
      api('/api/cash/expenses?limit=500&offset=bad', { token }),
      api('/api/purchases?limit=-10&offset=-10', { token }),
      api('/api/qr/orders?limit=notanumber', { token }),
    ]);
    for (const r of [pSales, pLevels, pMoves, pSess, pExp, pPurch, pOrders]) {
      expect(r.status).toBe(200);
    }
  });

  it('5. Super-Admin GET /establishments & GET /api/qr/tables en mode expiré sans table : propriétaire prioritaire, expiration temps réel et aucune écriture sur GET expiré', async () => {
    const ownerEmail = `owner.priority.${Date.now()}@myrestogest.com`;
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Établissement Test Priorité Proprio',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: ownerEmail,
        password: 'Password2026!',
        fullName: 'Cheikh Diop Propriétaire',
        acceptTerms: true,
      },
    });
    expect(reg.status).toBe(201);
    const { companyId, userId: ownerUserId } = reg.body.data;
    const ownerToken = reg.body.data.token;

    // Créer un rôle Serveur et un employé avec un UUID artificiellement PLUS PETIT ('00000000-...')
    const smallerUuid = '00000000-0000-4000-8000-0000000000aa';
    const roleId = crypto.randomUUID();
    await adminPoolRef!.query(
      `INSERT INTO public.roles (id, company_id, name, permissions)
       VALUES ($1, $2, 'Serveur', '{"pos:read":true}'::jsonb)`,
      [roleId, companyId]
    );
    await adminPoolRef!.query(
      `INSERT INTO public.users (id, email, full_name, is_active)
       VALUES ($1, $2, 'Employé UUID Plus Petit', TRUE)`,
      [smallerUuid, `small.uuid.${Date.now()}@myrestogest.com`]
    );
    await adminPoolRef!.query(
      `INSERT INTO public.company_users (company_id, user_id, role_id, is_active)
       VALUES ($1, $2, $3, TRUE)`,
      [companyId, smallerUuid, roleId]
    );

    // Simuler une date d'expiration dépassée sans mise à jour préalable du champ status
    await adminPoolRef!.query(
      `UPDATE public.company_subscriptions
       SET status = 'trial',
           trial_ends_at = NOW() - INTERVAL '2 days',
           current_period_end = NOW() - INTERVAL '2 days'
       WHERE company_id = $1`,
      [companyId]
    );

    const estList = await api('/api/admin/establishments', { token: superAdminToken });
    expect(estList.status).toBe(200);
    const found = estList.body.data.find((c: any) => c.id === companyId);
    expect(found).toBeDefined();
    expect(found.owner_email).toBe(ownerEmail);
    expect(found.owner_name).toBe('Cheikh Diop Propriétaire');
    expect(found.subscription_status).toBe('expired');

    // Aucune table n'existe encore sur cet établissement expiré : GET /api/qr/tables ne doit PAS insérer de tables !
    const tablesCountBefore = await adminPoolRef!.query(
      `SELECT COUNT(*)::INT AS cnt FROM public.dining_tables WHERE company_id = $1`,
      [companyId]
    );
    expect(tablesCountBefore.rows[0].cnt).toBe(0);

    const qrGetExpired = await api('/api/qr/tables', { token: ownerToken });
    expect(qrGetExpired.status).toBe(200);
    expect(qrGetExpired.body.data).toEqual([]);

    const tablesCountAfter = await adminPoolRef!.query(
      `SELECT COUNT(*)::INT AS cnt FROM public.dining_tables WHERE company_id = $1`,
      [companyId]
    );
    expect(tablesCountAfter.rows[0].cnt).toBe(0);

    expect(ownerUserId).not.toBe(smallerUuid);
  });
});
