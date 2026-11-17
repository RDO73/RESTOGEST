import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IDbPool } from '../src/db/pool.js';

let server: Server;
let baseUrl: string;
let authToken: string;
let companyId: string;
let productId: string;
let openSessionId: string;
let completedSaleId: string;
let tempDataDir: string | null = null;
let adminPoolRef: IDbPool | null = null;
let appPoolRef: IDbPool | null = null;

beforeAll(async () => {
  if (process.env.RUN_INTEGRATION_ON_POSTGRES !== 'true') {
    process.env.DATABASE_TYPE = 'embedded';
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restogest-int-'));
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
      baseUrl = `http://localhost:${addr.port}`;
      resolve();
    });
  });

  // Inscription d'une entreprise pour le test
  const regRes = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      companyName: 'Bistro & Saveurs Métier',
      businessType: 'both',
      currency: 'XOF',
      email: `test_integration_${Date.now()}@resto.sn`,
      password: 'StrongPassword2026!',
      fullName: 'Mamadou Kane',
    }),
  });
  const regData = await regRes.json();
  expect(regRes.status).toBe(201);
  authToken = regData.data.token;
  companyId = regData.data.companyId;

  // Création d'un produit test
  const prodRes = await fetch(`${baseUrl}/api/catalog/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      name: 'Café Espresso Grand Cru',
      productType: 'finished_good',
      unit: 'tasse',
      sellingPrice: 1500,
      costPrice: 400,
      inventoryTracking: 'direct',
      minStockAlert: 5,
    }),
  });
  const prodData = await prodRes.json();
  expect(prodRes.status).toBe(201);
  productId = prodData.data.id;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => {
    if (server) {
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
  if (appPoolRef && appPoolRef !== adminPoolRef) {
    await appPoolRef.end();
  }
  if (adminPoolRef) {
    await adminPoolRef.end();
  }
  if (tempDataDir && fs.existsSync(tempDataDir)) {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

describe('Modules Métiers Backend RESTOGEST V1', () => {
  it('0. ENDPOINTS PUBLICS : / (HTML), /api (JSON) et /health (JSON) répondent 200', async () => {
    const rootRes = await fetch(`${baseUrl}/`);
    const rootHtml = await rootRes.text();
    expect(rootRes.status).toBe(200);
    expect(rootRes.headers.get('content-type') || '').toMatch(/text\/html/i);
    expect(rootHtml).toContain('RestoGest');

    const apiRes = await fetch(`${baseUrl}/api`);
    const apiData = await apiRes.json();
    expect(apiRes.status).toBe(200);
    expect(apiData.status).toBe('ok');

    const healthRes = await fetch(`${baseUrl}/health`);
    const healthData = await healthRes.json();
    expect(healthRes.status).toBe(200);
    expect(healthData.status).toBe('ok');

    // Vérifier aussi la sérialisation de requêtes parallèles en mode PGlite/Postgres
    const [rCat, rSales, rCash, rInv] = await Promise.all([
      fetch(`${baseUrl}/api/catalog/products`, { headers: { Authorization: `Bearer ${authToken}` } }),
      fetch(`${baseUrl}/api/sales`, { headers: { Authorization: `Bearer ${authToken}` } }),
      fetch(`${baseUrl}/api/cash/sessions/current`, { headers: { Authorization: `Bearer ${authToken}` } }),
      fetch(`${baseUrl}/api/inventory/levels`, { headers: { Authorization: `Bearer ${authToken}` } }),
    ]);
    expect(rCat.status).toBe(200);
    expect(rSales.status).toBe(200);
    expect(rCash.status).toBe(200);
    expect(rInv.status).toBe(200);
  });

  it('1. SESSIONS DE CAISSE : Ouverture, Dépense, Suivi théorique et Clôture', async () => {
    // A. Ouverture de caisse avec 50 000 XOF
    const openRes = await fetch(`${baseUrl}/api/cash/sessions/open`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ openingAmount: 50000 }),
    });
    const openData = await openRes.json();
    expect(openRes.status).toBe(201);
    expect(openData.success).toBe(true);
    openSessionId = openData.data.id;

    // B. Dépense sortie de caisse (Achat glace / fournitures) : 5 000 XOF
    const expRes = await fetch(`${baseUrl}/api/cash/expenses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        cashSessionId: openSessionId,
        category: 'Fournitures Caisse',
        amount: 5000,
        description: 'Achat rouleaux papier thermique et glaçons',
      }),
    });
    const expData = await expRes.json();
    expect(expRes.status).toBe(201);
    expect(expData.success).toBe(true);

    // C. Vérification de la session active
    const curRes = await fetch(`${baseUrl}/api/cash/sessions/current`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const curData = await curRes.json();
    expect(curRes.status).toBe(200);
    expect(curData.data.metrics.openingAmount || curData.data.openingAmount).toBe(50000);
    expect(curData.data.metrics.totalExpenses).toBe(5000);
    expect(curData.data.metrics.theoreticalCashInDrawer).toBe(45000);
  });

  it('2. STOCKS & INVENTAIRE : Ajustements manuels, alertes et valorisation', async () => {
    // A. Ajustement initial : entrée en stock de 20 unités
    const adjInRes = await fetch(`${baseUrl}/api/inventory/adjustments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        productId,
        movementType: 'production_in',
        quantityDelta: 20,
        notes: 'Stock initial pour démarrage de service',
      }),
    });
    expect(adjInRes.status).toBe(201);

    // B. Ajustement perte / casse : perte de 2 unités
    const adjLossRes = await fetch(`${baseUrl}/api/inventory/adjustments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        productId,
        movementType: 'loss',
        quantityDelta: 2,
        notes: '2 tasses renversées lors du service',
      }),
    });
    expect(adjLossRes.status).toBe(201);

    // C. Consultation des niveaux de stock
    const levelsRes = await fetch(`${baseUrl}/api/inventory/levels?search=Espresso`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const levelsData = await levelsRes.json();
    expect(levelsRes.status).toBe(200);
    expect(levelsData.data).toHaveLength(1);
    expect(parseFloat(levelsData.data[0].current_quantity)).toBe(18); // 20 - 2 = 18

    // D. Synthèse globale
    const sumRes = await fetch(`${baseUrl}/api/inventory/summary`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const sumData = await sumRes.json();
    expect(sumRes.status).toBe(200);
    expect(sumData.data.tracked_products_count).toBeGreaterThanOrEqual(1);

    // E. Historique des mouvements
    const movRes = await fetch(`${baseUrl}/api/inventory/movements?productId=${productId}`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const movData = await movRes.json();
    expect(movRes.status).toBe(200);
    expect(movData.data.length).toBeGreaterThanOrEqual(2);
  });

  it('3. FOURNISSEURS & ACHATS : Création, Ajout d\'articles, Réception et Annulation', async () => {
    // A. Création Fournisseur
    const supRes = await fetch(`${baseUrl}/api/purchases/suppliers`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        name: 'Distributeur Café & Boissons Dakar',
        email: 'ventes@cafedakar.sn',
        phone: '+221338202020',
        address: 'Point E, Dakar',
      }),
    });
    const supData = await supRes.json();
    expect(supRes.status).toBe(201);
    const supplierId = supData.data.id;

    // B. Création Commande d'achat
    const purchRes = await fetch(`${baseUrl}/api/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        supplierId,
        reference: 'CMD-CAFE-2026-001',
        notes: 'Livraison urgente matinée',
      }),
    });
    const purchData = await purchRes.json();
    expect(purchRes.status).toBe(201);
    const purchaseId = purchData.data.id;

    // C. Ajout d'une ligne d'achat : 50 unités à 420 XOF
    const itemRes = await fetch(`${baseUrl}/api/purchases/${purchaseId}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        productId,
        quantity: 50,
        unitCost: 420,
      }),
    });
    expect(itemRes.status).toBe(201);

    // D. Réception officielle de la commande
    const receiveRes = await fetch(`${baseUrl}/api/purchases/${purchaseId}/receive`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const receiveData = await receiveRes.json();
    expect(receiveRes.status).toBe(200);
    expect(receiveData.data.status).toBe('received');

    // E. Vérification de l'augmentation du stock : 18 + 50 = 68
    const checkStockRes = await fetch(`${baseUrl}/api/inventory/levels?search=Espresso`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const checkStock = await checkStockRes.json();
    expect(parseFloat(checkStock.data[0].current_quantity)).toBe(68);

    // F. Création d'une 2e commande et annulation
    const purch2Res = await fetch(`${baseUrl}/api/purchases`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        supplierId,
        reference: 'CMD-ANNUL-002',
      }),
    });
    const purch2 = await purch2Res.json();
    const cancelRes = await fetch(`${baseUrl}/api/purchases/${purch2.data.id}/cancel`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ reason: 'Erreur de saisie' }),
    });
    const cancelData = await cancelRes.json();
    expect(cancelRes.status).toBe(200);
    expect(cancelData.data.status).toBe('cancelled');
  });

  it('4. VENTES & COMMANDES : Création, Paiement, Finalisation atomique et Reçu', async () => {
    // A. Création vente comptoir rattachée à la caisse
    const saleRes = await fetch(`${baseUrl}/api/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        cashSessionId: openSessionId,
        notes: 'Table 4 - Terrasse',
        discountAmount: 0,
      }),
    });
    const saleData = await saleRes.json();
    expect(saleRes.status).toBe(201);
    const saleId = saleData.data.id;
    completedSaleId = saleId;

    // B. Ajout de 3 cafés espresso (3 * 1500 = 4500 XOF)
    const itemRes = await fetch(`${baseUrl}/api/sales/${saleId}/items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        productId,
        quantity: 3,
        unitPrice: 1500,
      }),
    });
    expect(itemRes.status).toBe(201);

    // C. Paiement en espèces de 4500 XOF
    const payRes = await fetch(`${baseUrl}/api/sales/${saleId}/payments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({
        amount: 4500,
        paymentMethod: 'cash',
        reference: 'PAIEMENT-ESPECES-01',
      }),
    });
    expect(payRes.status).toBe(201);

    // D. Finalisation de la vente (déstocke 3 unités et fige la facture)
    const compRes = await fetch(`${baseUrl}/api/sales/${saleId}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const compData = await compRes.json();
    expect(compRes.status).toBe(200);
    expect(compData.data.status).toBe('completed');
    expect(parseFloat(compData.data.total_amount)).toBe(4500);

    // E. Vérification du déstockage : 68 - 3 = 65
    const stockAfterSale = await fetch(`${baseUrl}/api/inventory/levels?search=Espresso`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const stockRes = await stockAfterSale.json();
    expect(parseFloat(stockRes.data[0].current_quantity)).toBe(65);

    // F. Génération du ticket de caisse
    const receiptRes = await fetch(`${baseUrl}/api/sales/${saleId}/receipt`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const receiptData = await receiptRes.json();
    expect(receiptRes.status).toBe(200);
    expect(receiptData.data.totals.totalAmount).toBe(4500);
    expect(receiptData.data.items).toHaveLength(1);
    expect(receiptData.data.payments[0].method).toBe('cash');
  });

  it('5. CLÔTURE DE CAISSE : Détection de l\'écart de caisse', async () => {
    // Solde théorique : 50 000 (fond) - 5 000 (dépense) + 4 500 (vente espèces) = 49 500 XOF
    // Comptage réel : 49 500 XOF (écart 0)
    const closeRes = await fetch(`${baseUrl}/api/cash/sessions/${openSessionId}/close`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify({ actualAmount: 49500 }),
    });
    const closeData = await closeRes.json();
    expect(closeRes.status).toBe(200);
    expect(closeData.data.status).toBe('closed');
    expect(parseFloat(closeData.data.expected_closing_amount)).toBe(49500);
    expect(parseFloat(closeData.data.actual_closing_amount)).toBe(49500);
    expect(parseFloat(closeData.data.difference_amount)).toBe(0);
  });

  it('6. ISOLATION MULTI-TENANT HTTP : Entreprise B ne voit ni produits ni ventes d\'Entreprise A', async () => {
    const emailB = `tenant_b_${Date.now()}@resto.sn`;
    const regBRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Pâtisserie Étoile B',
        businessType: 'pastry_shop',
        currency: 'XOF',
        email: emailB,
        password: 'TenantBPassword2026!',
        fullName: 'Fatou Diop',
      }),
    });
    const regB = await regBRes.json();
    expect(regBRes.status).toBe(201);
    const tokenB = regB.data.token;
    expect(regB.data.companyId).not.toBe(companyId);

    const prodsBRes = await fetch(`${baseUrl}/api/catalog/products`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    const prodsB = await prodsBRes.json();
    expect(prodsBRes.status).toBe(200);
    expect(prodsB.data).toHaveLength(0);

    const crossSaleRes = await fetch(`${baseUrl}/api/sales/${completedSaleId}`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(crossSaleRes.status).toBe(404);

    const crossReceiptRes = await fetch(`${baseUrl}/api/sales/${completedSaleId}/receipt`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(crossReceiptRes.status).toBe(404);
  });

  it('7. AUTHENTIFICATION (/login, /me, /logout) & RÉVOCATION IMMÉDIATE DU JETON', async () => {
    const email = `auth_flow_${Date.now()}@resto.sn`;
    const password = 'AuthFlowPassword2026!';
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Atelier Auth Test',
        businessType: 'restaurant',
        currency: 'EUR',
        email,
        password,
        fullName: 'Amadou Ba',
      }),
    });
    expect(regRes.status).toBe(201);

    // Mauvais mot de passe rejeté (401)
    const badLoginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'WrongPassword!' }),
    });
    expect(badLoginRes.status).toBe(401);

    // Connexion valide
    const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const loginData = await loginRes.json();
    expect(loginRes.status).toBe(200);
    const loginToken = loginData.data.token;
    expect(loginData.data.company.name).toBe('Atelier Auth Test');

    // /me valide
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginToken}` },
    });
    const meData = await meRes.json();
    expect(meRes.status).toBe(200);
    expect(meData.data.user.email).toBe(email);
    expect(meData.data.company.currency).toBe('EUR');

    // Déconnexion / révocation
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginToken}` },
    });
    expect(logoutRes.status).toBe(200);

    // Le jeton révoqué est immédiatement rejeté en base (401)
    const revokedMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginToken}` },
    });
    expect(revokedMeRes.status).toBe(401);
  });

  it('8. MODE DÉMO STATELESS & RÉSILIENCE COLD-START (pglite-ephemeral reset entre POST et GET)', async () => {
    const demoRes = await fetch(`${baseUrl}/api/auth/demo`, {
      method: 'POST',
    });
    const demoJson = await demoRes.json();
    expect(demoRes.status).toBe(200);
    expect(demoJson.data.isDemo).toBe(true);
    expect(demoJson.data.token).toBeTruthy();

    const setCookieHeader = demoRes.headers.get('set-cookie') || '';
    expect(setCookieHeader).toContain('restogest_session=');
    expect(setCookieHeader).toContain('Path=/');
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toMatch(/SameSite=Lax/i);

    const cookiePair = setCookieHeader.split(';')[0];

    // Simulation d'un cold start Serverless : suppression totale de l'instance PGlite entre le POST et les GET
    if (process.env.DATABASE_TYPE !== 'postgres') {
      const [{ resetEmbeddedDatabaseForColdStartSimulation }, { resetTenantRoleCache }] =
        await Promise.all([
          import('../src/db/pool.js'),
          import('../src/db/tenant-context.js'),
        ]);
      await resetEmbeddedDatabaseForColdStartSimulation();
      resetTenantRoleCache();
    }

    // Reprise immédiate du tableau de bord via Cookie HTTPOnly seul, sans aucun 401
    const cookieHeaders = { Cookie: cookiePair };
    const [meRes, catRes, prodRes, recRes, lvlRes, purRes, cashRes] = await Promise.all([
      fetch(`${baseUrl}/api/auth/me`, { headers: cookieHeaders }),
      fetch(`${baseUrl}/api/catalog/categories`, { headers: cookieHeaders }),
      fetch(`${baseUrl}/api/catalog/products`, { headers: cookieHeaders }),
      fetch(`${baseUrl}/api/catalog/recipes`, { headers: cookieHeaders }),
      fetch(`${baseUrl}/api/inventory/levels`, { headers: cookieHeaders }),
      fetch(`${baseUrl}/api/purchases`, { headers: cookieHeaders }),
      fetch(`${baseUrl}/api/cash/sessions/current`, { headers: cookieHeaders }),
    ]);

    expect(meRes.status).toBe(200);
    expect(catRes.status).toBe(200);
    expect(prodRes.status).toBe(200);
    expect(recRes.status).toBe(200);
    expect(lvlRes.status).toBe(200);
    expect(purRes.status).toBe(200);
    expect(cashRes.status).toBe(200);

    const [meData, catData, prodData, recData, lvlData, purData, cashData] = await Promise.all([
      meRes.json(),
      catRes.json(),
      prodRes.json(),
      recRes.json(),
      lvlRes.json(),
      purRes.json(),
      cashRes.json(),
    ]);

    expect(meData.data.company.name).toBe('Le Palais Gourmand (Démo)');
    expect(catData.data.length).toBeGreaterThanOrEqual(3);
    expect(prodData.data.map((p: any) => p.name)).toContain('Café Espresso');
    expect(prodData.data.map((p: any) => p.name)).toContain('Croissant Pur Beurre');
    expect(recData.data.map((r: any) => r.recipe_name)).toContain('Extraction Espresso 20g');
    expect(purData.data.some((p: any) => p.reference === 'ACH-DEMO-INIT-001' && p.status === 'received')).toBe(true);

    const croissantLvl = lvlData.data.find((l: any) => l.product_name === 'Croissant Pur Beurre');
    expect(Number(croissantLvl?.current_quantity)).toBe(30);

    const grainLvl = lvlData.data.find((l: any) => l.product_name === 'Grains Café Arabica');
    expect(Number(grainLvl?.current_quantity)).toBe(10);
    expect(Number(grainLvl?.pmp)).toBe(8500);

    expect(cashData.data.status).toBe('open');
    expect(Number(cashData.data.opening_amount)).toBe(50000);

    // Vérification complémentaire avec Bearer header
    const bearerMeRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${demoJson.data.token}` },
    });
    expect(bearerMeRes.status).toBe(200);
  });

  it('9. FONCTIONNALITÉS V1.1 : ABONNEMENTS SaaS (XOF/GNF), RAPPORT Z DÉTAILLÉ (WAVE/OM) & MOT DE PASSE OUBLIÉ', async () => {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyName: 'Conakry Saveurs V1.1',
        businessType: 'restaurant',
        currency: 'XOF',
        email: `v11_${Date.now()}@myrestogest.com`,
        password: 'PasswordV11!',
        fullName: 'Ibrahima Diallo',
      }),
    });
    const regJson = await regRes.json();
    expect(regRes.status).toBe(201);
    const v11Headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${regJson.data.token}`,
    };

    // A. Abonnement courant -> essai gratuit + 3 plans
    const subRes = await fetch(`${baseUrl}/api/subscriptions/current`, { headers: v11Headers });
    const subJson = await subRes.json();
    expect(subRes.status).toBe(200);
    expect(subJson.data.subscription.status).toBe('trial');
    expect(subJson.data.plans).toHaveLength(3);
    const proPlan = subJson.data.plans.find((p: any) => p.name === 'Pro Cloud Restaurant');
    expect(proPlan).toBeDefined();

    // B. Multi-devises XOF -> GNF -> XOF
    const gnfRes = await fetch(`${baseUrl}/api/subscriptions/company-settings`, {
      method: 'PUT',
      headers: v11Headers,
      body: JSON.stringify({ currency: 'GNF' }),
    });
    const gnfJson = await gnfRes.json();
    expect(gnfRes.status).toBe(200);
    expect(gnfJson.data.currency).toBe('GNF');

    const xofRes = await fetch(`${baseUrl}/api/subscriptions/company-settings`, {
      method: 'PUT',
      headers: v11Headers,
      body: JSON.stringify({ currency: 'XOF' }),
    });
    expect(xofRes.status).toBe(200);

    // C. Checkout Wave -> activation licence
    const checkoutRes = await fetch(`${baseUrl}/api/subscriptions/checkout`, {
      method: 'POST',
      headers: v11Headers,
      body: JSON.stringify({
        planId: proPlan.id,
        billingPeriod: 'yearly',
        paymentMethod: 'wave',
        payerReference: '+221770000001',
      }),
    });
    const checkoutJson = await checkoutRes.json();
    expect(checkoutRes.status).toBe(201);
    expect(checkoutJson.data.subscription.status).toBe('active');
    expect(checkoutJson.data.licenseReference).toMatch(/^LIC-RG-/);

    // D. Rapport Z détaillé (Wave + Orange Money)
    await fetch(`${baseUrl}/api/cash/sessions/open`, {
      method: 'POST',
      headers: v11Headers,
      body: JSON.stringify({ openingAmount: 25000 }),
    });

    const pRes = await fetch(`${baseUrl}/api/catalog/products`, {
      method: 'POST',
      headers: v11Headers,
      body: JSON.stringify({
        name: 'Thiéboudienne Royal',
        productType: 'service',
        inventoryTracking: 'none',
        unit: 'plat',
        sellingPrice: 5000,
      }),
    });
    const pJson = await pRes.json();

    const saleRes = await fetch(`${baseUrl}/api/sales`, {
      method: 'POST',
      headers: v11Headers,
      body: JSON.stringify({ notes: 'RG_META:{"serviceMode":"dine_in","tableCode":"T1","tableName":"Table 1"}' }),
    });
    const saleJson = await saleRes.json();

    await fetch(`${baseUrl}/api/sales/${saleJson.data.id}/items`, {
      method: 'POST',
      headers: v11Headers,
      body: JSON.stringify({ productId: pJson.data.id, quantity: 2 }),
    });

    await fetch(`${baseUrl}/api/sales/${saleJson.data.id}/payments`, {
      method: 'POST',
      headers: v11Headers,
      body: JSON.stringify({ amount: 6000, paymentMethod: 'mobile_money', reference: 'Wave' }),
    });
    await fetch(`${baseUrl}/api/sales/${saleJson.data.id}/payments`, {
      method: 'POST',
      headers: v11Headers,
      body: JSON.stringify({ amount: 4000, paymentMethod: 'mobile_money', reference: 'Orange Money' }),
    });
    await fetch(`${baseUrl}/api/sales/${saleJson.data.id}/complete`, {
      method: 'POST',
      headers: v11Headers,
    });

    const curCashRes = await fetch(`${baseUrl}/api/cash/sessions/current`, { headers: v11Headers });
    const curCashJson = await curCashRes.json();
    expect(curCashRes.status).toBe(200);
    expect(curCashJson.data.zReport).toBeDefined();
    expect(curCashJson.data.zReport.ticketsCount).toBe(1);
    expect(curCashJson.data.zReport.paymentBreakdown.wave).toBe(6000);
    expect(curCashJson.data.zReport.paymentBreakdown.orangeMoney).toBe(4000);
    expect(curCashJson.data.zReport.paymentBreakdown.especes).toBe(0);
    expect(curCashJson.data.zReport.paymentBreakdown.carteBancaire).toBe(0);

    // E. Mot de passe oublié
    const forgotRes = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'patron@myrestogest.com' }),
    });
    expect(forgotRes.status).toBe(200);
  });
});
