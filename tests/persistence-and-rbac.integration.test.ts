import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { IDbPool } from '../src/db/pool.js';
import { clearRateLimitStoreForTests } from '../src/middlewares/rate-limit.js';

let clearInMemoryRevocationFn: (() => void) | null = null;

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
    // non-json
  }
  return { status: res.status, body: json, text, headers: res.headers };
}

beforeAll(async () => {
  if (process.env.RUN_INTEGRATION_ON_POSTGRES !== 'true') {
    process.env.DATABASE_TYPE = 'embedded';
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restogest-rbac-'));
    process.env.PGLITE_DATA_DIR = tempDataDir;
  }

  const [{ app }, { adminPool, appPool }, { applyMigrations }, { clearInMemoryRevocationForTests }] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pool.js'),
    import('../src/db/migrate.js'),
    import('../src/auth/jwt.js'),
  ]);
  clearInMemoryRevocationFn = clearInMemoryRevocationForTests;

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

describe('Recette complète — Persistance, Multi-utilisateurs RBAC, Isolation & Super-Admin', () => {
  let ownerAToken = '';
  let ownerAEmail = '';
  let companyAId = '';
  let prodId = '';
  let waiterUserId = '';
  let waiterEmail = '';
  let waiterToken = '';
  let cashierToken = '';
  let accountantToken = '';
  let stockToken = '';

  it('1. Parcours Propriétaire : inscription, produits, édition produit, stock, caisse, dépense, client, vente & persistance après déconnexion/reconnexion', async () => {
    ownerAEmail = `owner-a-${Date.now()}@restogest.test`;
    const reg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Restaurant Teranga Dakar',
        businessType: 'both',
        countryCode: 'SN',
        email: ownerAEmail,
        password: 'OwnerPassword2026!',
        fullName: 'Ibrahima Fall',
      },
    });
    expect(reg.status).toBe(201);
    ownerAToken = reg.body.data.token;
    companyAId = reg.body.data.companyId;

    const me = await api('/api/auth/me', { token: ownerAToken });
    expect(me.status).toBe(200);
    expect(me.body.data.role.code).toBe('owner');
    expect(me.body.data.role.isOwner).toBe(true);
    expect(me.body.data.role.permissions.all).toBe(true);

    // Créer catégorie + produit + modifier produit (PUT /api/catalog/products/:id)
    const catRes = await api('/api/catalog/categories', {
      method: 'POST',
      token: ownerAToken,
      body: { name: 'Plats Sénégalais' },
    });
    expect(catRes.status).toBe(201);

    const prodRes = await api('/api/catalog/products', {
      method: 'POST',
      token: ownerAToken,
      body: {
        categoryId: catRes.body.data.id,
        name: 'Thiéboudienne Royal',
        productType: 'finished_good',
        unit: 'plat',
        sellingPrice: 3500,
        costPrice: 1400,
        inventoryTracking: 'direct',
        minStockAlert: 5,
      },
    });
    expect(prodRes.status).toBe(201);
    prodId = prodRes.body.data.id;

    const editProd = await api(`/api/catalog/products/${prodId}`, {
      method: 'PUT',
      token: ownerAToken,
      body: { name: 'Thiéboudienne Rouge Royal', sellingPrice: 4000 },
    });
    expect(editProd.status).toBe(200);
    expect(editProd.body.data.name).toBe('Thiéboudienne Rouge Royal');
    expect(Number(editProd.body.data.selling_price)).toBe(4000);

    // Ajustement stock (+20)
    const adj = await api('/api/inventory/adjustments', {
      method: 'POST',
      token: ownerAToken,
      body: {
        productId: prodId,
        movementType: 'production_in',
        quantityDelta: 20,
        notes: 'Préparation service midi',
      },
    });
    expect(adj.status).toBe(201);

    // Ouvrir caisse + enregistrer dépense (3 500 XOF)
    const openCash = await api('/api/cash/sessions/open', {
      method: 'POST',
      token: ownerAToken,
      body: { openingAmount: 50000 },
    });
    expect(openCash.status).toBe(201);
    const cashSessionId = openCash.body.data.id;

    const expRes = await api('/api/cash/expenses', {
      method: 'POST',
      token: ownerAToken,
      body: {
        cashSessionId,
        category: 'Glaçons & Gaz',
        amount: 3500,
        description: 'Recharge gaz cuisine',
      },
    });
    expect(expRes.status).toBe(201);
    const expenseId = expRes.body.data.id;

    // Créer un client
    const custRes = await api('/api/customers', {
      method: 'POST',
      token: ownerAToken,
      body: { fullName: 'Awa Diagne', phone: '+221771112233' },
    });
    expect(custRes.status).toBe(201);
    const customerId = custRes.body.data.id;

    // Créer une commande + article + paiement + finalisation
    const saleRes = await api('/api/sales', {
      method: 'POST',
      token: ownerAToken,
      body: { customerId, cashSessionId },
    });
    expect(saleRes.status).toBe(201);
    const saleId = saleRes.body.data.id;

    const addItem = await api(`/api/sales/${saleId}/items`, {
      method: 'POST',
      token: ownerAToken,
      body: { productId: prodId, quantity: 2 },
    });
    expect(addItem.status).toBe(201);

    const payRes = await api(`/api/sales/${saleId}/payments`, {
      method: 'POST',
      token: ownerAToken,
      body: { amount: 8000, paymentMethod: 'cash', cashSessionId, reference: 'Espèces' },
    });
    expect(payRes.status).toBe(201);

    const compRes = await api(`/api/sales/${saleId}/complete`, {
      method: 'POST',
      token: ownerAToken,
    });
    expect(compRes.status).toBe(200);

    // Déconnexion puis reconnexion complète : TOUTES les données doivent être persistées !
    const logoutRes = await api('/api/auth/logout', { method: 'POST', token: ownerAToken });
    expect(logoutRes.status).toBe(200);
    const rejectedOld = await api('/api/auth/me', { token: ownerAToken });
    expect(rejectedOld.status).toBe(401);

    const relogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: ownerAEmail, password: 'OwnerPassword2026!' },
    });
    expect(relogin.status).toBe(200);
    ownerAToken = relogin.body.data.token;

    // Vérification persistance réelle après reconnexion
    const [expAfter, cashAfter, prodAfter, salesAfter, custAfter] = await Promise.all([
      api('/api/cash/expenses', { token: ownerAToken }),
      api('/api/cash/sessions/current', { token: ownerAToken }),
      api('/api/catalog/products', { token: ownerAToken }),
      api('/api/sales', { token: ownerAToken }),
      api('/api/customers', { token: ownerAToken }),
    ]);

    expect(expAfter.status).toBe(200);
    expect(expAfter.body.data.some((e: any) => e.id === expenseId && Number(e.amount) === 3500)).toBe(true);
    expect(cashAfter.body.data.metrics.totalExpenses).toBe(3500);
    expect(cashAfter.body.data.metrics.theoreticalCashInDrawer).toBe(50000 + 8000 - 3500);

    const savedProd = prodAfter.body.data.find((p: any) => p.id === prodId);
    expect(savedProd?.name).toBe('Thiéboudienne Rouge Royal');
    expect(Number(savedProd?.current_stock)).toBe(18); // 20 - 2 vendus

    expect(salesAfter.body.data.some((s: any) => s.id === saleId && s.status === 'completed')).toBe(true);
    expect(custAfter.body.data.some((c: any) => c.id === customerId && c.full_name === 'Awa Diagne')).toBe(true);
  });

  it('2. Multi-utilisateurs & RBAC serveur : Serveur, Caissier, Comptable, Stock Manager ont des droits stricts et des interfaces adaptées', async () => {
    waiterEmail = `serveur-${Date.now()}@restogest.test`;
    const cashierEmail = `caissier-${Date.now()}@restogest.test`;
    const accountantEmail = `comptable-${Date.now()}@restogest.test`;
    const stockEmail = `stock-${Date.now()}@restogest.test`;

    // Le propriétaire crée 4 comptes employés individuels
    const wCreate = await api('/api/staff', {
      method: 'POST',
      token: ownerAToken,
      body: { fullName: 'Moussa Serveur', email: waiterEmail, password: 'StaffPassword2026!', rolePreset: 'waiter' },
    });
    expect(wCreate.status).toBe(201);
    waiterUserId = wCreate.body.data.id;

    const cCreate = await api('/api/staff', {
      method: 'POST',
      token: ownerAToken,
      body: { fullName: 'Aïssatou Caissière', email: cashierEmail, password: 'StaffPassword2026!', rolePreset: 'cashier' },
    });
    expect(cCreate.status).toBe(201);

    const aCreate = await api('/api/staff', {
      method: 'POST',
      token: ownerAToken,
      body: { fullName: 'Cheikh Comptable', email: accountantEmail, password: 'StaffPassword2026!', rolePreset: 'accountant' },
    });
    expect(aCreate.status).toBe(201);

    const sCreate = await api('/api/staff', {
      method: 'POST',
      token: ownerAToken,
      body: { fullName: 'Binta Stock', email: stockEmail, password: 'StaffPassword2026!', rolePreset: 'stock_manager' },
    });
    expect(sCreate.status).toBe(201);

    // Connexion individuelle de chaque employé
    const wLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: waiterEmail, password: 'StaffPassword2026!' },
    });
    expect(wLogin.status).toBe(200);
    expect(wLogin.body.data.role.code).toBe('waiter');
    expect(wLogin.body.data.role.defaultRoute).toBe('tables');
    waiterToken = wLogin.body.data.token;

    const cLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: cashierEmail, password: 'StaffPassword2026!' },
    });
    expect(cLogin.status).toBe(200);
    expect(cLogin.body.data.role.code).toBe('cashier');
    expect(cLogin.body.data.role.defaultRoute).toBe('pos');
    cashierToken = cLogin.body.data.token;

    const aLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: accountantEmail, password: 'StaffPassword2026!' },
    });
    expect(aLogin.status).toBe(200);
    expect(aLogin.body.data.role.code).toBe('accountant');
    expect(aLogin.body.data.role.defaultRoute).toBe('dashboard');
    accountantToken = aLogin.body.data.token;

    const sLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: stockEmail, password: 'StaffPassword2026!' },
    });
    expect(sLogin.status).toBe(200);
    expect(sLogin.body.data.role.code).toBe('stock_manager');
    expect(sLogin.body.data.role.defaultRoute).toBe('inventory');
    stockToken = sLogin.body.data.token;

    // SERVEUR : peut consulter le catalogue et créer une commande, mais bloqué (403) sur caisse, dépenses, encaissement, stock, équipe, /admin
    expect((await api('/api/catalog/products', { token: waiterToken })).status).toBe(200);
    const waiterSale = await api('/api/sales', { method: 'POST', token: waiterToken, body: {} });
    expect(waiterSale.status).toBe(201);
    expect(
      (await api(`/api/sales/${waiterSale.body.data.id}/payments`, {
        method: 'POST',
        token: waiterToken,
        body: { amount: 1000, paymentMethod: 'cash' },
      })).status
    ).toBe(403);
    expect(
      (await api('/api/cash/expenses', {
        method: 'POST',
        token: waiterToken,
        body: { category: 'Test', amount: 500, description: 'Interdit serveur' },
      })).status
    ).toBe(403);
    expect((await api('/api/staff', { token: waiterToken })).status).toBe(403);
    expect((await api('/api/admin/establishments', { token: waiterToken })).status).toBe(403);

    // CAISSIER : peut enregistrer une dépense, mais bloqué (403) sur gestion équipe, création produit & /admin
    const cashierExp = await api('/api/cash/expenses', {
      method: 'POST',
      token: cashierToken,
      body: { category: 'Monnaie', amount: 1500, description: 'Achat monnaie caisse' },
    });
    expect(cashierExp.status).toBe(201);
    expect((await api('/api/staff', { token: cashierToken })).status).toBe(403);
    expect(
      (await api('/api/catalog/products', {
        method: 'POST',
        token: cashierToken,
        body: { name: 'Interdit caissier', sellingPrice: 1000 },
      })).status
    ).toBe(403);

    // COMPTABLE : lecture financière OK (200), toute écriture bloquée (403)
    expect((await api('/api/cash/expenses', { token: accountantToken })).status).toBe(200);
    expect((await api('/api/sales', { token: accountantToken })).status).toBe(200);
    expect(
      (await api('/api/cash/expenses', {
        method: 'POST',
        token: accountantToken,
        body: { category: 'Test', amount: 100, description: 'Lecture seule' },
      })).status
    ).toBe(403);
    expect((await api('/api/sales', { method: 'POST', token: accountantToken, body: {} })).status).toBe(403);

    // GESTIONNAIRE DE STOCK : ajustement stock OK (201), dépense caisse & équipe bloqués (403)
    expect(
      (await api('/api/inventory/adjustments', {
        method: 'POST',
        token: stockToken,
        body: { productId: prodId, movementType: 'adjustment', quantityDelta: 5, notes: 'Inventaire vérifié' },
      })).status
    ).toBe(201);
    expect(
      (await api('/api/cash/expenses', {
        method: 'POST',
        token: stockToken,
        body: { category: 'Test', amount: 500, description: 'Interdit stock' },
      })).status
    ).toBe(403);
    expect((await api('/api/staff', { token: stockToken })).status).toBe(403);
  });

  it('3. Modification temps réel des permissions, suspension immédiate d’employé et traçabilité équipe', async () => {
    // Avant mise à jour : le serveur ne peut pas consulter les dépenses (403)
    expect((await api('/api/cash/expenses', { token: waiterToken })).status).toBe(403);

    // Le propriétaire accorde cash:read au serveur -> effet immédiat sans reconnexion !
    const upd = await api(`/api/staff/${waiterUserId}`, {
      method: 'PUT',
      token: ownerAToken,
      body: {
        roleName: 'Serveur Principal',
        permissions: { 'tables:read': true, 'pos:read': true, 'pos:write': true, 'cash:read': true },
      },
    });
    expect(upd.status).toBe(200);
    expect((await api('/api/cash/expenses', { token: waiterToken })).status).toBe(200);

    // Suspension du serveur -> sa session active est immédiatement révoquée (401)
    const susp = await api(`/api/staff/${waiterUserId}/status`, {
      method: 'POST',
      token: ownerAToken,
      body: { isActive: false, reason: 'Fin de contrat test' },
    });
    expect(susp.status).toBe(200);
    expect((await api('/api/auth/me', { token: waiterToken })).status).toBe(401);

    // Reconnexion refusée tant qu'il est suspendu
    const blockedLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: waiterEmail, password: 'StaffPassword2026!' },
    });
    expect([401, 403]).toContain(blockedLogin.status);

    // Réactivation -> reconnexion de nouveau possible
    const react = await api(`/api/staff/${waiterUserId}/status`, {
      method: 'POST',
      token: ownerAToken,
      body: { isActive: true },
    });
    expect(react.status).toBe(200);
    const okLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: waiterEmail, password: 'StaffPassword2026!' },
    });
    expect(okLogin.status).toBe(200);

    // Journal d'activité de l'équipe visible par le propriétaire
    const act = await api('/api/staff/activity', { token: ownerAToken });
    expect(act.status).toBe(200);
    expect(act.body.data.some((ev: any) => ev.action === 'STAFF_MEMBER_CREATED')).toBe(true);
    expect(act.body.data.some((ev: any) => ev.action === 'STAFF_MEMBER_SUSPENDED')).toBe(true);
  });

  it('4. Isolation stricte entre établissements (Restaurant B ne voit ni l’équipe ni les dépenses de Restaurant A)', async () => {
    const regB = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Boulangerie Kaloum Conakry',
        businessType: 'pastry_shop',
        countryCode: 'GN',
        email: `owner-b-${Date.now()}@restogest.test`,
        password: 'OwnerBPassword2026!',
        fullName: 'Mamadou Camara',
      },
    });
    expect(regB.status).toBe(201);
    const ownerBToken = regB.body.data.token;

    const staffB = await api('/api/staff', { token: ownerBToken });
    expect(staffB.status).toBe(200);
    expect(staffB.body.data.length).toBe(1);
    expect(staffB.body.data.some((u: any) => u.email === waiterEmail)).toBe(false);

    const expB = await api('/api/cash/expenses', { token: ownerBToken });
    expect(expB.status).toBe(200);
    expect(expB.body.data.length).toBe(0);

    // Tentative de suspendre un employé du Restaurant A depuis Restaurant B -> 404
    const crossSusp = await api(`/api/staff/${waiterUserId}/status`, {
      method: 'POST',
      token: ownerBToken,
      body: { isActive: false },
    });
    expect(crossSusp.status).toBe(404);
  });

  it('5. Super-Admin : fiche détaillée d’établissement, alertes live et révocation persistante après déconnexion', async () => {
    const { config } = await import('../src/config/env.js');
    const saLogin = await api('/api/admin/auth/login', {
      method: 'POST',
      body: { email: config.superAdmin.email, password: config.superAdmin.password },
    });
    expect(saLogin.status).toBe(200);
    const saToken = saLogin.body.data.token as string;

    const alertsRes = await api('/api/admin/alerts', { token: saToken });
    expect(alertsRes.status).toBe(200);
    expect(Array.isArray(alertsRes.body.data.alerts)).toBe(true);
    expect(typeof alertsRes.body.data.counts.pendingPayments).toBe('number');

    const detailRes = await api(`/api/admin/establishments/${companyAId}`, { token: saToken });
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.establishment.id).toBe(companyAId);
    expect(detailRes.body.data.users.length).toBeGreaterThanOrEqual(5); // Propriétaire + 4 employés
    expect(detailRes.body.data.stats.completed_sales_count).toBe(1);
    expect(JSON.stringify(detailRes.body.data)).not.toContain('password_hash');

    // Déconnexion Super-Admin persistante en base (résiste au vidage mémoire / redémarrage)
    const saLogout = await api('/api/admin/auth/logout', { method: 'POST', token: saToken });
    expect(saLogout.status).toBe(200);
    clearInMemoryRevocationFn?.();
    const afterLogout = await api('/api/admin/auth/me', { token: saToken });
    expect(afterLogout.status).toBe(401);
  });

  it('6. Mode Démo : une dépense enregistrée reste persistée même après 10 rafraîchissements parallèles', async () => {
    const demoRes = await api('/api/auth/demo', { method: 'POST' });
    expect(demoRes.status).toBe(200);
    const demoToken = demoRes.body.data.token as string;

    const exp = await api('/api/cash/expenses', {
      method: 'POST',
      token: demoToken,
      body: {
        category: 'Démo Persistance',
        amount: 2750,
        description: 'Achat glaçons test persistance',
      },
    });
    expect(exp.status).toBe(201);
    const expId = exp.body.data.id;

    // 10 rafraîchissements simultanés (simule le polling & rechargements multiples)
    const polls = await Promise.all(
      Array.from({ length: 10 }, () => api('/api/cash/expenses', { token: demoToken }))
    );
    for (const p of polls) {
      expect(p.status).toBe(200);
      expect(p.body.data.some((e: any) => e.id === expId && Number(e.amount) === 2750)).toBe(true);
    }
  });
});
