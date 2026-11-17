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
    // ignore non-json
  }
  return { status: res.status, body: json, text };
}

beforeAll(async () => {
  if (process.env.RUN_INTEGRATION_ON_POSTGRES !== 'true') {
    process.env.DATABASE_TYPE = 'embedded';
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restogest-africa-'));
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
}, 30000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (appPoolRef) await appPoolRef.end().catch(() => { });
  if (adminPoolRef && adminPoolRef !== appPoolRef) await adminPoolRef.end().catch(() => { });
  if (tempDataDir && fs.existsSync(tempDataDir)) {
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});

describe('RESTOGEST V1.3 — Marché Africain, Multi-Devises & Wave SN (+221788979342)', () => {
  let tokenSn = '';
  let tokenGn = '';
  let waveSnTxId = '';

  it('1. Détecte automatiquement la devise officielle par pays à l’inscription (SN -> XOF, GN -> GNF)', async () => {
    const regSn = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Restaurant Dakar Plateau',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: `dakar.${Date.now()}@restogest.sn`,
        password: 'Password123!',
        fullName: 'Cheikh Diop',
      },
    });
    expect(regSn.status).toBe(201);
    expect(regSn.body.data.countryCode).toBe('SN');
    expect(regSn.body.data.currency).toBe('XOF');
    tokenSn = regSn.body.data.token;

    const regGn = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Pâtisserie Kaloum Conakry',
        businessType: 'pastry_shop',
        countryCode: 'GN',
        email: `conakry.${Date.now()}@restogest.gn`,
        password: 'Password123!',
        fullName: 'Aissatou Barry',
      },
    });
    expect(regGn.status).toBe(201);
    expect(regGn.body.data.countryCode).toBe('GN');
    expect(regGn.body.data.currency).toBe('GNF');
    tokenGn = regGn.body.data.token;
  });

  it('2. Limite le marché actif au Sénégal (XOF) et à la Guinée (GNF) avec leurs moyens de paiement locaux', async () => {
    const pubSn = await api('/api/subscriptions/plans/public?countryCode=SN');
    expect(pubSn.status).toBe(200);
    expect(pubSn.body.data.countries.map((c: any) => c.code).sort()).toEqual(['GN', 'SN']);
    expect(
      pubSn.body.data.receptionAccounts.some((a: any) => a.merchant_number_or_iban === '+221788979342')
    ).toBe(true);
    const snMethods = pubSn.body.data.paymentMethods.map((m: any) => m.method_code);
    expect(snMethods).toContain('wave');
    expect(snMethods).toContain('orange_money');
    expect(snMethods).toContain('card_visa_uba');
    expect(pubSn.body.data.pricingMatrix.PRO.monthly.officialLocalPrice).toBe(29000);
    expect(pubSn.body.data.pricingMatrix.PRO.monthly.currencyCode).toBe('XOF');

    const pubGn = await api('/api/subscriptions/plans/public?countryCode=GN');
    expect(pubGn.status).toBe(200);
    expect(
      pubGn.body.data.receptionAccounts.some((a: any) => a.merchant_number_or_iban === '+221788979342')
    ).toBe(false);
    const gnMethods = pubGn.body.data.paymentMethods.map((m: any) => m.method_code);
    expect(gnMethods).toContain('orange_money');
    expect(gnMethods).toContain('bank_transfer');
    expect(gnMethods).toContain('card_visa_uba');
    expect(pubGn.body.data.pricingMatrix.PRO.monthly.officialLocalPrice).toBe(435000);
    expect(pubGn.body.data.pricingMatrix.PRO.monthly.currencyCode).toBe('GNF');

    // Pays sans tarif local officiel (ex: Kenya KES) -> estimation indicative uniquement
    const pubKe = await api('/api/subscriptions/plans/public?countryCode=KE');
    expect(pubKe.status).toBe(200);
    expect(pubKe.body.data.pricingMatrix.PRO.monthly.hasOfficialLocalPrice).toBe(false);
    expect(pubKe.body.data.pricingMatrix.PRO.monthly.isEstimate).toBe(true);
    expect(pubKe.body.data.pricingMatrix.PRO.monthly.currencyCode).toBe('KES');
    expect(
      pubKe.body.data.receptionAccounts.some((a: any) => a.merchant_number_or_iban === '+221788979342')
    ).toBe(false);
  });

  let superAdminToken = '';

  it('3. Refuse Wave SN hors Sénégal, bloque les gérants sur /admin et maintient les paiements en attente de validation Super-Admin', async () => {
    // Tentative d'utiliser manual_wave_sn depuis la Guinée -> 400 INVALID_COUNTRY_PAYMENT_METHOD
    const badWaveGn = await api('/api/subscriptions/transactions', {
      method: 'POST',
      token: tokenGn,
      body: {
        countryCode: 'GN',
        planCode: 'PRO',
        billingPeriod: 'monthly',
        paymentMethod: 'wave',
        providerCode: 'manual_wave_sn',
        manualReference: 'FAKE-WAVE-GN',
      },
    });
    expect(badWaveGn.status).toBe(400);
    expect(badWaveGn.body.error.code).toBe('INVALID_COUNTRY_PAYMENT_METHOD');

    // Paiement Wave Sénégal avec référence -> DOIT rester "pending", JAMAIS auto-activé
    const waveSnTx = await api('/api/subscriptions/transactions', {
      method: 'POST',
      token: tokenSn,
      body: {
        countryCode: 'SN',
        planCode: 'PRO',
        billingPeriod: 'monthly',
        paymentMethod: 'wave',
        providerCode: 'manual_wave_sn',
        payerPhone: '+221771234567',
        manualReference: 'WAVE-SN-REF-78897',
      },
    });
    expect(waveSnTx.status).toBe(201);
    expect(waveSnTx.body.data.mode).toBe('manual_proof');
    expect(waveSnTx.body.data.transaction.status).toBe('pending');
    expect(waveSnTx.body.data.transaction.currency).toBe('XOF');
    expect(Number(waveSnTx.body.data.transaction.gross_amount)).toBe(29000);
    expect(waveSnTx.body.data.invoice).toBeNull();
    waveSnTxId = waveSnTx.body.data.transaction.id;

    // L'abonnement du client SN est toujours "pending_payment", pas "active"
    const curSn = await api('/api/subscriptions/current', { token: tokenSn });
    expect(curSn.body.data.subscription.status).toBe('pending_payment');

    // Un gérant d'établissement est bloqué (403) sur les routes Super-Admin
    const forbiddenConfirm = await api(`/api/subscriptions/admin/transactions/${waveSnTxId}/confirm`, {
      method: 'POST',
      token: tokenSn,
      body: { note: 'Auto-validation interdite' },
    });
    expect(forbiddenConfirm.status).toBe(403);

    const forbiddenEst = await api('/api/admin/establishments', { token: tokenSn });
    expect(forbiddenEst.status).toBe(403);

    // Authentification exclusive Super-Admin
    const adminLoginRes = await api('/api/admin/auth/login', {
      method: 'POST',
      body: {
        email: process.env.SUPER_ADMIN_EMAIL || 'admin@myrestogest.com',
        password: process.env.SUPER_ADMIN_PASSWORD || 'RestoGestAdmin2026!',
      },
    });
    expect(adminLoginRes.status).toBe(200);
    superAdminToken = adminLoginRes.body.data.token;

    // Liste des établissements SN & GN dans l'espace Super-Admin
    const estRes = await api('/api/admin/establishments', { token: superAdminToken });
    expect(estRes.status).toBe(200);
    expect(estRes.body.data.establishments.length).toBeGreaterThanOrEqual(2);

    // Validation réelle par le Super-Administrateur -> active l'abonnement & émet la facture
    const confirmRes = await api(`/api/subscriptions/admin/transactions/${waveSnTxId}/confirm`, {
      method: 'POST',
      token: superAdminToken,
      body: { note: 'Réception vérifiée sur compte Wave +221788979342' },
    });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.data.transaction.status).toBe('confirmed');
    expect(confirmRes.body.data.subscription.status).toBe('active');
    expect(confirmRes.body.data.invoice.invoice_number).toMatch(/^FA-RG-/);
  });

  it('4. Sépare strictement les revenus XOF et GNF dans Finances RESTOGEST et gère les remboursements & taux de change', async () => {
    // Paiement Guinée en GNF (435 000 FG)
    const gnTx = await api('/api/subscriptions/transactions', {
      method: 'POST',
      token: tokenGn,
      body: {
        countryCode: 'GN',
        planCode: 'PRO',
        billingPeriod: 'monthly',
        paymentMethod: 'bank_transfer',
        payerPhone: '+224620112233',
        manualReference: 'VIR-GN-435000',
      },
    });
    expect(gnTx.status).toBe(201);
    expect(gnTx.body.data.transaction.currency).toBe('GNF');
    expect(Number(gnTx.body.data.transaction.gross_amount)).toBe(435000);

    await api(`/api/subscriptions/admin/transactions/${gnTx.body.data.transaction.id}/confirm`, {
      method: 'POST',
      token: superAdminToken,
      body: { note: 'Virement GNF vérifié' },
    });

    // Mise à jour taux de change & ajout tarif local Côte d'Ivoire
    const rateRes = await api('/api/subscriptions/admin/exchange-rates', {
      method: 'PUT',
      token: superAdminToken,
      body: { baseCurrency: 'XOF', targetCurrency: 'GNF', rate: 15.2, source: 'Test BCEAO' },
    });
    expect(rateRes.status).toBe(200);

    const cpRes = await api('/api/subscriptions/admin/country-prices', {
      method: 'PUT',
      token: superAdminToken,
      body: {
        countryCode: 'CI',
        planCode: 'ESSENTIEL',
        billingPeriod: 'monthly',
        referencePrice: 15000,
        localPrice: 15000,
        currencyCode: 'XOF',
        setupFee: 0,
      },
    });
    expect(cpRes.status).toBe(200);

    // Vérifier Finances RESTOGEST : XOF et GNF séparés + estimation consolidée
    const ovRes = await api('/api/subscriptions/admin/overview', { token: superAdminToken });
    expect(ovRes.status).toBe(200);
    const byCur = ovRes.body.data.multiCurrency.totalsByCurrency;
    const xofRow = byCur.find((r: any) => r.currency === 'XOF');
    const gnfRow = byCur.find((r: any) => r.currency === 'GNF');
    expect(xofRow.grossConfirmed).toBe(29000);
    expect(gnfRow.grossConfirmed).toBe(435000);
    expect(ovRes.body.data.multiCurrency.reportingEstimate.isIndicativeEstimate).toBe(true);

    // Remboursement de la transaction GNF
    const refRes = await api(`/api/subscriptions/admin/transactions/${gnTx.body.data.transaction.id}/refund`, {
      method: 'POST',
      token: superAdminToken,
      body: { reason: 'Erreur double virement client Conakry' },
    });
    expect(refRes.status).toBe(200);
    expect(refRes.body.data.status).toBe('refunded');
  });
});
