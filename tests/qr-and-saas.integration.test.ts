import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IDbPool } from '../src/db/pool.js';

let server: Server;
let baseUrl = '';
let tempDataDir: string | null = null;
let adminPoolRef: IDbPool | null = null;
let appPoolRef: IDbPool | null = null;
let computeSaasWebhookSignature: (payload: string) => string;

async function api(
  endpoint: string,
  opts: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: any;
  } = {}
) {
  const headers: Record<string, string> = {
    ...(opts.headers || {}),
  };
  if (opts.token) {
    headers.Authorization = `Bearer ${opts.token}`;
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
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
    // non-json response (HTML / SVG)
  }
  return { status: res.status, body: json, text };
}

beforeAll(async () => {
  if (process.env.RUN_INTEGRATION_ON_POSTGRES !== 'true') {
    process.env.DATABASE_TYPE = 'embedded';
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restogest-qr-saas-'));
    process.env.PGLITE_DATA_DIR = tempDataDir;
  }

  const [{ app }, { adminPool, appPool }, { applyMigrations }, subMod] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pool.js'),
    import('../src/db/migrate.js'),
    import('../src/modules/subscriptions/subscriptions.router.js'),
  ]);

  adminPoolRef = adminPool;
  appPoolRef = appPool;
  computeSaasWebhookSignature = subMod.computeSaasWebhookSignature;

  await applyMigrations(adminPool);

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address() as any;
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });
}, 30000);

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (appPoolRef) await appPoolRef.end().catch(() => {});
  if (adminPoolRef && adminPoolRef !== appPoolRef) await adminPoolRef.end().catch(() => {});
  if (tempDataDir && fs.existsSync(tempDataDir)) {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

describe('RESTOGEST V1.2 — Extension Menu Digital QR Code, Caisse/Stocks & Finances SaaS', () => {
  let tokenA = '';
  let tokenB = '';

  let createdTableId = '';
  let createdTableQrToken = '';
  let finishedProductId = '';
  let rawMaterialProductId = '';
  let requiredOptionValueId = '';
  let supplementOptionValueId = '';

  let createdQrOrderId = '';
  let createdQrTrackingToken = '';

  it('1. Initialise deux établissements distincts (Tenant A et Tenant B) et ouvre une caisse pour A', async () => {
    const emailA = `owner.qra.${Date.now()}@restogest.sn`;
    const regA = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Teranga Lounge & Pâtisserie A',
        businessType: 'both',
        currency: 'XOF',
        email: emailA,
        password: 'Password123!',
        fullName: 'Chef Moussa Diop',
      },
    });
    expect(regA.status).toBe(201);
    tokenA = regA.body.data.token;

    const emailB = `owner.qrb.${Date.now()}@restogest.gn`;
    const regB = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Boulangerie Kaloum B',
        businessType: 'pastry_shop',
        currency: 'GNF',
        email: emailB,
        password: 'Password123!',
        fullName: 'Mamadou Bah',
      },
    });
    expect(regB.status).toBe(201);
    tokenB = regB.body.data.token;

    // Ouvrir une session de caisse pour l'établissement A
    const openCash = await api('/api/cash/sessions/open', {
      method: 'POST',
      token: tokenA,
      body: { openingAmount: 50000 },
    });
    expect(openCash.status).toBe(201);
  });

  it('2. Crée des produits (produit fini + matière première), alimente le stock initial et vérifie que seule la carte publique est exposée', async () => {
    const catRes = await api('/api/catalog/categories', {
      method: 'POST',
      token: tokenA,
      body: { name: 'Spécialités Grillades & Pâtisseries', description: 'Carte principale' },
    });
    expect(catRes.status).toBe(201);
    const categoryId = catRes.body.data.id;

    // Produit fini suivi directement en stock
    const finRes = await api('/api/catalog/products', {
      method: 'POST',
      token: tokenA,
      body: {
        categoryId,
        name: 'Entrecôte Grillée & Frites Maison',
        productType: 'finished_good',
        inventoryTracking: 'direct',
        sellingPrice: 8500,
        costPrice: 3200,
        unit: 'unit',
        minStockAlert: 2,
      },
    });
    expect(finRes.status).toBe(201);
    finishedProductId = finRes.body.data.id;

    // Approvisionner 10 unités en stock pour le produit fini
    const adjRes = await api('/api/inventory/adjustments', {
      method: 'POST',
      token: tokenA,
      body: {
        productId: finishedProductId,
        movementType: 'production_in',
        quantityDelta: 10,
        notes: 'Mise en place initiale service',
      },
    });
    expect(adjRes.status).toBe(201);

    // Matière première interne (NE DOIT JAMAIS APPARAÎTRE SUR LE MENU QR PUBLIC)
    const rawRes = await api('/api/catalog/products', {
      method: 'POST',
      token: tokenA,
      body: {
        categoryId,
        name: 'Sac de Farine Boulangère 50kg (Interne)',
        productType: 'raw_material',
        inventoryTracking: 'direct',
        sellingPrice: 0,
        costPrice: 22000,
        unit: 'kg',
        minStockAlert: 5,
      },
    });
    expect(rawRes.status).toBe(201);
    rawMaterialProductId = rawRes.body.data.id;
  });

  it('3. Crée une table avec QR Code unique, télécharge le support SVG et configure des options obligatoires/suppléments', async () => {
    const tblRes = await api('/api/qr/tables', {
      method: 'POST',
      token: tokenA,
      body: {
        code: 'VIP9',
        name: 'Table VIP 09',
        zone: 'Espace VIP',
        seats: 6,
        tableType: 'table',
      },
    });
    expect(tblRes.status).toBe(201);
    createdTableId = tblRes.body.data.id;
    createdTableQrToken = tblRes.body.data.qr_token;
    expect(createdTableQrToken.length).toBeGreaterThanOrEqual(32);

    // Vérifier le support SVG imprimable
    const svgRes = await api(`/api/qr/tables/${createdTableId}/qrcode.svg`, { token: tokenA });
    expect(svgRes.status).toBe(200);
    expect(svgRes.text).toContain('<svg');
    expect(svgRes.text).toContain('Scannez pour consulter notre menu et commander');

    // Créer un groupe d'options obligatoires (Cuisson + Supplément) sur le produit fini
    const optRes = await api('/api/qr/options/groups', {
      method: 'POST',
      token: tokenA,
      body: {
        productId: finishedProductId,
        name: 'Cuisson & Garniture',
        isRequired: true,
        selectionType: 'multiple',
        minChoices: 1,
        maxChoices: 2,
        allowCustomText: true,
        values: [
          { label: 'À point', priceDelta: 0, isDefault: true },
          { label: 'Supplément Fromage Emmental', priceDelta: 1000, isDefault: false },
        ],
      },
    });
    expect(optRes.status).toBe(201);
    requiredOptionValueId = optRes.body.data.values[0].id;
    supplementOptionValueId = optRes.body.data.values[1].id;
  });

  it('4. Consulte le menu digital public via le QR Token sans authentification et vérifie l’absence de données internes sensibles', async () => {
    const htmlRes = await api(`/menu/${createdTableQrToken}`);
    expect(htmlRes.status).toBe(200);
    expect(htmlRes.text).toContain('Menu Digital');

    const menuRes = await api(`/api/public/qr/menu/${createdTableQrToken}`);
    expect(menuRes.status).toBe(200);

    const { establishment, table, products } = menuRes.body.data;
    expect(establishment.displayName).toContain('Teranga Lounge');
    expect(table.code).toBe('VIP9');

    const foundFinished = products.find((p: any) => p.id === finishedProductId);
    const foundRaw = products.find((p: any) => p.id === rawMaterialProductId);
    expect(foundFinished).toBeDefined();
    expect(foundRaw).toBeUndefined();

    // Aucune fuite de cost_price ou de stock_quantity
    expect(foundFinished.cost_price).toBeUndefined();
    expect(foundFinished.costPrice).toBeUndefined();
    expect(foundFinished.stock_quantity).toBeUndefined();
  });

  it('5. Valide les options obligatoires, recalcule le prix côté serveur et protège contre la double soumission (idempotence)', async () => {
    // 5a. Omission de l'option obligatoire -> 400 MISSING_REQUIRED_OPTION
    const badOrder = await api(`/api/public/qr/menu/${createdTableQrToken}/orders`, {
      method: 'POST',
      body: {
        customerName: 'Fatou Ndiaye',
        items: [
          {
            productId: finishedProductId,
            quantity: 2,
            selectedOptionValueIds: [],
          },
        ],
      },
    });
    expect(badOrder.status).toBe(400);
    expect(badOrder.body.error.code).toBe('MISSING_REQUIRED_OPTION');

    // 5b. Soumission valide avec option + supplément (+1000 FCFA) -> Prix unitaire = 8500 + 1000 = 9500 FCFA x 2 = 19000 FCFA
    const idemKey = `idem_${Date.now()}_vip9`;
    const goodOrder = await api(`/api/public/qr/menu/${createdTableQrToken}/orders`, {
      method: 'POST',
      body: {
        orderType: 'dine_in',
        customerName: 'Fatou Ndiaye',
        customerPhone: '+221775556677',
        customerNote: 'Table près de la fenêtre',
        idempotencyKey: idemKey,
        items: [
          {
            productId: finishedProductId,
            quantity: 2,
            selectedOptionValueIds: [requiredOptionValueId, supplementOptionValueId],
            customMessage: 'Joyeux Anniversaire Fatou',
            itemNote: 'Sauce poivre à part',
          },
        ],
      },
    });
    expect(goodOrder.status).toBe(201);
    expect(Number(goodOrder.body.data.total_amount)).toBe(19000);
    expect(goodOrder.body.data.status).toBe('received');
    expect(goodOrder.body.data.payment_status).toBe('unpaid');
    createdQrOrderId = goodOrder.body.data.id;
    createdQrTrackingToken = goodOrder.body.data.tracking_token;

    // 5c. Double clic avec la même idempotencyKey -> 200 sans créer de doublon
    const replayOrder = await api(`/api/public/qr/menu/${createdTableQrToken}/orders`, {
      method: 'POST',
      body: {
        orderType: 'dine_in',
        customerName: 'Fatou Ndiaye',
        idempotencyKey: idemKey,
        items: [
          {
            productId: finishedProductId,
            quantity: 2,
            selectedOptionValueIds: [requiredOptionValueId, supplementOptionValueId],
          },
        ],
      },
    });
    expect(replayOrder.status).toBe(200);
    expect(replayOrder.body.idempotentReplay).toBe(true);
    expect(replayOrder.body.data.id).toBe(createdQrOrderId);
  });

  it('6. Permet au client de suivre sa commande en direct et d’appeler un serveur, puis traite le cycle cuisine et l’encaissement avec déstockage unique', async () => {
    const trackRes = await api(`/api/public/qr/orders/${createdQrTrackingToken}`);
    expect(trackRes.status).toBe(200);
    expect(trackRes.body.data.order.status).toBe('received');
    expect(trackRes.body.data.items[0].customMessage).toBe('Joyeux Anniversaire Fatou');

    const callRes = await api(`/api/public/qr/menu/${createdTableQrToken}/service-request`, {
      method: 'POST',
      body: { requestType: 'call_waiter', customerNote: 'Besoin de serviettes' },
    });
    expect(callRes.status).toBe(201);

    // Isolation multi-tenant : l'entreprise B ne peut pas voir les commandes QR de A
    const listB = await api('/api/qr/orders', { token: tokenB });
    expect(listB.status).toBe(200);
    expect(listB.body.data.orders.find((o: any) => o.id === createdQrOrderId)).toBeUndefined();

    // Progression cuisine par l'établissement A : received -> accepted -> preparing -> ready -> served
    for (const nextSt of ['accepted', 'preparing', 'ready', 'served']) {
      const stRes = await api(`/api/qr/orders/${createdQrOrderId}/status`, {
        method: 'POST',
        token: tokenA,
        body: { status: nextSt },
      });
      expect(stRes.status).toBe(200);
      expect(stRes.body.data.status).toBe(nextSt);
    }

    // Tant que la commande n'est pas encaissée, le stock du produit fini est toujours à 10
    const levelsBeforePay = await api('/api/inventory/levels', { token: tokenA });
    const prodBefore = levelsBeforePay.body.data.find((l: any) => l.product_id === finishedProductId);
    expect(Number(prodBefore.current_quantity)).toBe(10);

    // Encaissement de la commande QR (19 000 FCFA par Wave)
    const payRes = await api(`/api/qr/orders/${createdQrOrderId}/pay`, {
      method: 'POST',
      token: tokenA,
      body: { paymentMethod: 'wave', reference: 'WAVE-QR-99001' },
    });
    expect(payRes.status).toBe(200);
    expect(payRes.body.data.payment_status).toBe('paid');

    // Vérifier que le stock a été déduit UNE SEULE FOIS (10 - 2 = 8)
    const levelsAfterPay = await api('/api/inventory/levels', { token: tokenA });
    const prodAfter = levelsAfterPay.body.data.find((l: any) => l.product_id === finishedProductId);
    expect(Number(prodAfter.current_quantity)).toBe(8);

    // Une seconde tentative d'encaissement sur la même commande doit être refusée (409 ALREADY_PAID)
    const doublePay = await api(`/api/qr/orders/${createdQrOrderId}/pay`, {
      method: 'POST',
      token: tokenA,
      body: { paymentMethod: 'cash' },
    });
    expect(doublePay.status).toBe(409);
    expect(doublePay.body.error.code).toBe('ALREADY_PAID');

    // La suppression de la table VIP9 doit être bloquée car elle possède un historique de commandes (409 TABLE_HAS_HISTORY)
    const delTable = await api(`/api/qr/tables/${createdTableId}`, {
      method: 'DELETE',
      token: tokenA,
    });
    expect(delTable.status).toBe(409);
    expect(delTable.body.error.code).toBe('TABLE_HAS_HISTORY');

    // Régénération du QR Code de la table -> révoque l'ancien jeton
    const oldToken = createdTableQrToken;
    const regenRes = await api(`/api/qr/tables/${createdTableId}/regenerate-qr`, {
      method: 'POST',
      token: tokenA,
    });
    expect(regenRes.status).toBe(200);
    expect(regenRes.body.data.qr_token).not.toBe(oldToken);

    const oldTokenCheck = await api(`/api/public/qr/menu/${oldToken}`);
    expect(oldTokenCheck.status).toBe(404);
  });

  it('7. Valide le module SaaS Commercial, les Webhooks HMAC idempotents et le tableau de bord Super-Admin « Finances RESTOGEST »', async () => {
    const pubPlans = await api('/api/subscriptions/plans/public');
    expect(pubPlans.status).toBe(200);
    expect(pubPlans.body.data.plans.length).toBeGreaterThanOrEqual(3);

    const initTx = await api('/api/subscriptions/transactions', {
      method: 'POST',
      token: tokenA,
      body: {
        planCode: 'PRO',
        billingPeriod: 'quarterly',
        paymentMethod: 'paydunya',
        paymentMode: 'pending_webhook',
        payerPhone: '+221771112233',
        promoCode: 'BIENVENUE10',
      },
    });
    expect(initTx.status).toBe(201);
    expect(initTx.body.data.transaction.status).toBe('pending');
    const txRef = initTx.body.data.transaction.transaction_ref;

    // Webhook avec mauvaise signature -> 401 INVALID_WEBHOOK_SIGNATURE
    const badWh = await api('/api/subscriptions/webhooks/paydunya', {
      method: 'POST',
      headers: {
        'x-saas-signature': '0000000000000000000000000000000000000000000000000000000000000000',
      },
      body: { transactionRef: txRef, event: 'confirmed' },
    });
    expect(badWh.status).toBe(401);

    // Webhook authentique signé HMAC-SHA256 -> active l'abonnement et émet la facture officielle FA-RG-...
    const whPayload = {
      transactionRef: txRef,
      event: 'confirmed' as const,
      providerTransactionId: 'PYD-LIVE-889900',
    };
    const validSig = computeSaasWebhookSignature(JSON.stringify(whPayload));

    const goodWh = await api('/api/subscriptions/webhooks/paydunya', {
      method: 'POST',
      headers: { 'x-saas-signature': validSig },
      body: whPayload,
    });
    expect(goodWh.status).toBe(200);
    expect(goodWh.body.data.alreadyConfirmed).toBe(false);
    expect(goodWh.body.data.transaction.status).toBe('confirmed');
    expect(goodWh.body.data.subscription.status).toBe('active');
    expect(goodWh.body.data.invoice.invoice_number).toMatch(/^FA-RG-/);

    // Réception du même webhook une seconde fois (idempotence) -> pas de double facture ni double prolongation
    const dupWh = await api('/api/subscriptions/webhooks/paydunya', {
      method: 'POST',
      headers: { 'x-saas-signature': validSig },
      body: whPayload,
    });
    expect(dupWh.status).toBe(200);
    expect(dupWh.body.data.alreadyConfirmed).toBe(true);
    expect(Number(dupWh.body.data.transaction.webhook_confirmations_count)).toBe(2);

    // Un gérant d'établissement ne doit PAS pouvoir accéder à l'espace Super-Admin
    const forbiddenRes = await api('/api/subscriptions/admin/overview', { token: tokenA });
    expect(forbiddenRes.status).toBe(403);

    // Authentification exclusive Super-Admin (/api/admin/auth/login)
    const adminLoginRes = await api('/api/admin/auth/login', {
      method: 'POST',
      body: {
        email: process.env.SUPER_ADMIN_EMAIL || 'admin@myrestogest.com',
        password: process.env.SUPER_ADMIN_PASSWORD || 'RestoGestAdmin2026!',
      },
    });
    expect(adminLoginRes.status).toBe(200);
    const superAdminToken = adminLoginRes.body.data.token;

    // Espace Super-Admin « Finances RESTOGEST » : KPIs, Payouts & Prolongation auditée
    const payoutRes = await api('/api/subscriptions/admin/payouts', {
      method: 'POST',
      token: superAdminToken,
      body: {
        paymentProvider: 'PayDunya',
        destinationAccount: 'UBA Dakar SN08...',
        currency: 'XOF',
        grossCollectedAmount: 50000,
        providerFeesAmount: 1000,
        status: 'settled',
        notes: 'Reversement test unitaire',
      },
    });
    expect(payoutRes.status).toBe(201);
    expect(Number(payoutRes.body.data.net_settled_amount)).toBe(49000);

    const overviewRes = await api('/api/subscriptions/admin/overview', { token: superAdminToken });
    expect(overviewRes.status).toBe(200);
    expect(Number(overviewRes.body.data.kpis.confirmedGrossRevenue)).toBeGreaterThan(0);
    expect(Number(overviewRes.body.data.kpis.settledPayoutsTotal)).toBeGreaterThanOrEqual(49000);
  });
});
