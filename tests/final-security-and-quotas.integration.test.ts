import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { IDbPool } from '../src/db/pool.js';

let getRequiredLegalVersions: () => { cguVersion: string; cgvVersion: string; privacyPolicyVersion: string };
let resetRequiredLegalVersions: () => any;
let setRequiredLegalVersions: (partial: any) => any;

let server: Server;
let baseUrl = '';
let tempDataDir: string | null = null;
let adminPoolRef: IDbPool | null = null;
let appPoolRef: IDbPool | null = null;
let superAdminToken = '';
let superAdminEmail = '';

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
    tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restogest-final-sec-'));
    process.env.PGLITE_DATA_DIR = tempDataDir;
  }

  const [{ app }, { adminPool, appPool }, { applyMigrations }, { config }, guardMod] = await Promise.all([
    import('../src/app.js'),
    import('../src/db/pool.js'),
    import('../src/db/migrate.js'),
    import('../src/config/env.js'),
    import('../src/modules/subscriptions/subscription-guard.service.js'),
  ]);

  getRequiredLegalVersions = guardMod.getRequiredLegalVersions;
  resetRequiredLegalVersions = guardMod.resetRequiredLegalVersions;
  setRequiredLegalVersions = guardMod.setRequiredLegalVersions;

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

  const adminLogin = await api('/api/admin/auth/login', {
    method: 'POST',
    body: {
      email: config.superAdmin.email,
      password: config.superAdmin.password,
    },
  });
  expect(adminLogin.status).toBe(200);
  superAdminToken = adminLogin.body.data.token;
  superAdminEmail = config.superAdmin.email;
}, 30000);

afterAll(async () => {
  resetRequiredLegalVersions();
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

describe('Mission Prioritaire — Sécurisation Finale MyRestoGest (CGU/CGV, Quotas, Essai 14j Lecture Seule & Checkout)', () => {
  let registeredToken = '';
  let registeredCompanyId = '';
  let registeredUserId = '';
  let registeredSubId = '';

  it('1. ACCEPTATION OBLIGATOIRE DES CGU & CGV : refuse sans acceptation, ignore toute date falsifiée côté client, enregistre la preuve immuable et gère la ré-acceptation avec historique', async () => {
    resetRequiredLegalVersions();
    const baseEmail = `terms.test.${Date.now()}@myrestogest.com`;

    // 1a. Inscription SANS acceptation -> refusée (HTTP 400 TERMS_ACCEPTANCE_REQUIRED)
    const noAccept = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Restaurant Sans CGU',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: baseEmail,
        password: 'Password2026!',
        fullName: 'Ousmane Sow',
      },
    });
    expect(noAccept.status).toBe(400);
    expect(noAccept.body.error.code).toBe('TERMS_ACCEPTANCE_REQUIRED');

    // 1b. Inscription avec acceptTerms: false -> refusée (HTTP 400)
    const falseAccept = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Restaurant Refus CGU',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: baseEmail,
        password: 'Password2026!',
        fullName: 'Ousmane Sow',
        acceptTerms: false,
      },
    });
    expect(falseAccept.status).toBe(400);
    expect(falseAccept.body.error.code).toBe('TERMS_ACCEPTANCE_REQUIRED');

    // 1c. Inscription avec version falsifiée / obsolète -> refusée (HTTP 400 TERMS_VERSION_MISMATCH)
    const badVersion = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Restaurant Version Obsolète',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: baseEmail,
        password: 'Password2026!',
        fullName: 'Ousmane Sow',
        acceptTerms: true,
        cguVersion: '1999-01-01',
        cgvVersion: '1999-01-01',
      },
    });
    expect(badVersion.status).toBe(400);
    expect(badVersion.body.error.code).toBe('TERMS_VERSION_MISMATCH');

    // 1d. Inscription valide avec acceptTerms: true + tentative de falsification de acceptedAt côté client ("2001-01-01T00:00:00Z")
    const spoofedClientDate = '2001-01-01T00:00:00.000Z';
    const validReg = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Le Teranga Sécurisé',
        businessType: 'both',
        countryCode: 'SN',
        email: baseEmail,
        password: 'Password2026!',
        fullName: 'Ousmane Sow',
        acceptTerms: true,
        acceptedAt: spoofedClientDate,
      },
    });
    expect(validReg.status).toBe(201);
    registeredToken = validReg.body.data.token;
    registeredCompanyId = validReg.body.data.companyId;
    registeredUserId = validReg.body.data.userId;

    // Vérifier que la date falsifiée a été ignorée et que la date serveur réelle + version sont enregistrées en base
    const acceptance = validReg.body.data.termsAcceptance;
    expect(acceptance).toBeDefined();
    expect(acceptance.cguVersion).toBe('2026-11-21');
    expect(acceptance.cgvVersion).toBe('2026-11-21');
    expect(acceptance.acceptedAt).not.toBe(spoofedClientDate);
    expect(new Date(acceptance.acceptedAt).getFullYear()).toBeGreaterThanOrEqual(2026);
    expect(acceptance.proofHash).toMatch(/^[a-f0-9]{64}$/);

    // Vérifier en base que l'enregistrement est immuable (le trigger interdit tout UPDATE direct)
    await expect(
      adminPoolRef!.query(
        `UPDATE public.user_terms_acceptances SET cgu_version = 'HACKED' WHERE id = $1`,
        [acceptance.id]
      )
    ).rejects.toThrow(/strictement immuables/i);

    // 1e. Mise à jour majeure de la version des CGU/CGV -> déclenche requiresReacceptance: true sans supprimer l'ancienne preuve
    setRequiredLegalVersions({ cguVersion: '2026-12-01', cgvVersion: '2026-12-01' });

    const meAfterBump = await api('/api/auth/me', { token: registeredToken });
    expect(meAfterBump.status).toBe(200);
    expect(meAfterBump.body.data.termsStatus.accepted).toBe(false);
    expect(meAfterBump.body.data.termsStatus.requiresReacceptance).toBe(true);
    expect(meAfterBump.body.data.termsStatus.currentRequiredCguVersion).toBe('2026-12-01');
    expect(meAfterBump.body.data.termsStatus.historyCount).toBe(1);

    // 1f. BLOCAGE SERVEUR STRICT tant que la nouvelle version obligatoire des CGU/CGV n'est pas réacceptée :
    // Une requête API directe d'écriture métier (produit, vente, employé, paramètres opérationnels) ne peut PAS contourner l'obligation !
    const blockedProdDuringReaccept = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: { name: 'Produit Bloqué Sans Réacceptation CGU', sellingPrice: 1500 },
    });
    expect(blockedProdDuringReaccept.status).toBe(403);
    expect(blockedProdDuringReaccept.body.error.code).toBe('TERMS_REACCEPTANCE_REQUIRED');

    const blockedSaleDuringReaccept = await api('/api/sales', {
      method: 'POST',
      token: registeredToken,
      body: {},
    });
    expect(blockedSaleDuringReaccept.status).toBe(403);
    expect(blockedSaleDuringReaccept.body.error.code).toBe('TERMS_REACCEPTANCE_REQUIRED');

    const blockedStaffDuringReaccept = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Employé Bloqué Sans CGU',
        email: `blocked.cgu.staff.${Date.now()}@myrestogest.com`,
        password: 'StaffPassword2026!',
        rolePreset: 'waiter',
      },
    });
    expect(blockedStaffDuringReaccept.status).toBe(403);
    expect(blockedStaffDuringReaccept.body.error.code).toBe('TERMS_REACCEPTANCE_REQUIRED');

    const blockedExpenseDuringReaccept = await api('/api/cash/expenses', {
      method: 'POST',
      token: registeredToken,
      body: {
        category: 'Divers',
        amount: 1000,
        description: 'Dépense bloquée sans réacceptation CGU',
      },
    });
    expect(blockedExpenseDuringReaccept.status).toBe(403);
    expect(blockedExpenseDuringReaccept.body.error.code).toBe('TERMS_REACCEPTANCE_REQUIRED');

    const blockedEstablishmentsDuringReaccept = await api('/api/auth/establishments', {
      method: 'POST',
      token: registeredToken,
      body: {
        companyName: 'Site Bloqué Sans Réacceptation',
        businessType: 'restaurant',
        countryCode: 'SN',
      },
    });
    expect(blockedEstablishmentsDuringReaccept.status).toBe(403);
    expect(blockedEstablishmentsDuringReaccept.body.error.code).toBe('TERMS_REACCEPTANCE_REQUIRED');

    const blockedOpSettingsDuringReaccept = await api('/api/subscriptions/company-settings', {
      method: 'PUT',
      token: registeredToken,
      body: {
        currency: 'XOF',
        name: 'Tentative Renommage Sans Réacceptation',
        allowNegativeStock: true,
      },
    });
    expect(blockedOpSettingsDuringReaccept.status).toBe(403);
    expect(blockedOpSettingsDuringReaccept.body.error.code).toBe('TERMS_REACCEPTANCE_REQUIRED');

    // En revanche, les consultations GET et les paramètres de facturation pure (devise) restent autorisés
    const allowedGetDuringReaccept = await api('/api/catalog/products', { token: registeredToken });
    expect(allowedGetDuringReaccept.status).toBe(200);

    const allowedBillingCurrencyDuringReaccept = await api('/api/subscriptions/company-settings', {
      method: 'PUT',
      token: registeredToken,
      body: { currency: 'XOF' },
    });
    expect(allowedBillingCurrencyDuringReaccept.status).toBe(200);

    // Ré-acceptation par l'utilisateur -> ajoute une 2e ligne dans l'historique sans écraser la 1re et débloque immédiatement les écritures
    const reacceptRes = await api('/api/auth/accept-terms', {
      method: 'POST',
      token: registeredToken,
      body: {
        acceptTerms: true,
        cguVersion: '2026-12-01',
        cgvVersion: '2026-12-01',
      },
    });
    expect(reacceptRes.status).toBe(201);
    expect(reacceptRes.body.data.termsStatus.accepted).toBe(true);
    expect(reacceptRes.body.data.termsStatus.requiresReacceptance).toBe(false);
    expect(reacceptRes.body.data.termsStatus.historyCount).toBe(2);

    // Vérifier que les écritures sont immédiatement débloquées après réacceptation
    const unblockedExpenseAfterReaccept = await api('/api/cash/expenses', {
      method: 'POST',
      token: registeredToken,
      body: {
        category: 'Fournitures',
        amount: 500,
        description: 'Dépense débloquée après réacceptation CGU/CGV',
      },
    });
    expect(unblockedExpenseAfterReaccept.status).toBe(201);

    const historyDb = await adminPoolRef!.query(
      `SELECT cgu_version, cgv_version, acceptance_source
       FROM public.user_terms_acceptances
       WHERE company_id = $1 AND user_id = $2
       ORDER BY accepted_at ASC`,
      [registeredCompanyId, registeredUserId]
    );
    expect(historyDb.rows).toHaveLength(2);
    expect(historyDb.rows[0].cgu_version).toBe('2026-11-21');
    expect(historyDb.rows[0].acceptance_source).toBe('register');
    expect(historyDb.rows[1].cgu_version).toBe('2026-12-01');
    expect(historyDb.rows[1].acceptance_source).toBe('reacceptance');

    resetRequiredLegalVersions();
    expect(getRequiredLegalVersions().cguVersion).toBe('2026-11-21');
  });

  it('2. ESSAI GRATUIT DE 14 JOURS : démarre immédiatement à l’inscription (sans dépendre de GET /api/subscriptions/current), bascule en Mode Lecture Seule à expiration et se réactive après validation Super-Admin', async () => {
    // 2a. Vérifier directement en base que l'abonnement d'essai de 14 jours a été créé dès POST /api/auth/register
    // AVANT tout appel à GET /api/subscriptions/current !
    const subDbRes = await adminPoolRef!.query(
      `SELECT * FROM public.company_subscriptions WHERE company_id = $1`,
      [registeredCompanyId]
    );
    expect(subDbRes.rows).toHaveLength(1);
    const subRow = subDbRes.rows[0];
    registeredSubId = subRow.id;
    expect(subRow.status).toBe('trial');
    expect(subRow.plan_code).toBe('PRO');

    const startMs = new Date(subRow.current_period_start).getTime();
    const endMs = new Date(subRow.trial_ends_at).getTime();
    const diffDays = Math.round((endMs - startMs) / (1000 * 3600 * 24));
    expect(diffDays).toBe(14);

    // 2b. Essai actif -> les opérations métier (création produit, ouverture caisse, vente) sont autorisées
    const prodActiveTrial = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Jus de Bissap Frais',
        productType: 'finished_good',
        sellingPrice: 1000,
        costPrice: 300,
        inventoryTracking: 'direct',
      },
    });
    expect(prodActiveTrial.status).toBe(201);
    const bissapId = prodActiveTrial.body.data.id;

    // 2c. Simuler l'expiration des 14 jours d'essai en reculant trial_ends_at et current_period_end dans le passé
    await adminPoolRef!.query(
      `UPDATE public.company_subscriptions
       SET trial_ends_at = NOW() - INTERVAL '1 day',
           current_period_end = NOW() - INTERVAL '1 day',
           ends_at = NOW() - INTERVAL '1 day'
       WHERE id = $1`,
      [registeredSubId]
    );

    // 2d. Essai expiré -> toute écriture métier (vente, produit, employé, stock, caisse) est bloquée côté serveur (403 SUBSCRIPTION_EXPIRED_READ_ONLY)
    const blockedSale = await api('/api/sales', {
      method: 'POST',
      token: registeredToken,
      body: {},
    });
    expect(blockedSale.status).toBe(403);
    expect(blockedSale.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    const blockedProduct = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: { name: 'Produit Bloqué Lecture Seule', sellingPrice: 2000 },
    });
    expect(blockedProduct.status).toBe(403);
    expect(blockedProduct.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    const blockedStaff = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Serveur Bloqué',
        email: `blocked.staff.${Date.now()}@myrestogest.com`,
        password: 'StaffPassword2026!',
        rolePreset: 'waiter',
      },
    });
    expect(blockedStaff.status).toBe(403);
    expect(blockedStaff.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    const blockedStock = await api('/api/inventory/adjustments', {
      method: 'POST',
      token: registeredToken,
      body: {
        productId: bissapId,
        movementType: 'production_in',
        quantityDelta: 10,
        notes: 'Test blocage stock en lecture seule',
      },
    });
    expect(blockedStock.status).toBe(403);
    expect(blockedStock.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    // 2e. Essai expiré -> les consultations GET (produits, ventes, stocks, abonnement) restent 100 % autorisées !
    const [getProds, getSales, getStock, getSub] = await Promise.all([
      api('/api/catalog/products', { token: registeredToken }),
      api('/api/sales', { token: registeredToken }),
      api('/api/inventory/levels', { token: registeredToken }),
      api('/api/subscriptions/current', { token: registeredToken }),
    ]);
    expect(getProds.status).toBe(200);
    expect(getProds.body.data.some((p: any) => p.id === bissapId)).toBe(true);
    expect(getSales.status).toBe(200);
    expect(getStock.status).toBe(200);
    expect(getSub.status).toBe(200);
    expect(getSub.body.data.subscription.status).toBe('expired');
    expect(getSub.body.data.subscription.isExpired).toBe(true);
    expect(getSub.body.data.subscription.isReadOnly).toBe(true);

    // 2f. Prolongation exceptionnelle par le Super-Admin -> réactive immédiatement l'essai et est journalisée dans audit_logs
    const extendRes = await api(`/api/subscriptions/admin/subscriptions/${registeredSubId}/status`, {
      method: 'POST',
      token: superAdminToken,
      body: {
        status: 'trial',
        extendDays: 7,
        reason: 'Prolongation commerciale test 7 jours',
      },
    });
    expect(extendRes.status).toBe(200);
    expect(extendRes.body.data.status).toBe('trial');

    const prodAfterExtend = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: { name: 'Jus de Gingembre (Après Prolongation)', sellingPrice: 1200 },
    });
    expect(prodAfterExtend.status).toBe(201);
  });

  it('3. SÉCURISATION DE POST /api/subscriptions/checkout : aucune activation immédiate sans validation Super-Admin et idempotence contre la double validation', async () => {
    // Faire expirer à nouveau l'essai pour vérifier que checkout ne réactive PAS tout seul l'abonnement
    await adminPoolRef!.query(
      `UPDATE public.company_subscriptions
       SET status = 'expired',
           trial_ends_at = NOW() - INTERVAL '2 days',
           current_period_end = NOW() - INTERVAL '2 days',
           ends_at = NOW() - INTERVAL '2 days'
       WHERE id = $1`,
      [registeredSubId]
    );

    // 3a. Appel à l'ancienne route POST /api/subscriptions/checkout -> crée une transaction 'pending', jamais 'active'
    const checkoutRes = await api('/api/subscriptions/checkout', {
      method: 'POST',
      token: registeredToken,
      body: {
        planCode: 'ESSENTIEL',
        billingPeriod: 'monthly',
        paymentMethod: 'wave',
        payerReference: 'WAVE-CHECKOUT-TEST-001',
      },
    });
    expect(checkoutRes.status).toBe(201);
    expect(checkoutRes.body.data.transaction.status).toBe('pending');
    expect(checkoutRes.body.data.subscription.status).toBe('pending_payment');
    expect(checkoutRes.body.data.invoice_number).toBeNull();
    const pendingTxId = checkoutRes.body.data.transaction_id;

    // Tant que le Super-Admin n'a pas validé, l'établissement expiré reste en Mode Lecture Seule (403)
    const stillReadOnly = await api('/api/sales', {
      method: 'POST',
      token: registeredToken,
      body: {},
    });
    expect(stillReadOnly.status).toBe(403);
    expect(stillReadOnly.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    // 3b. Tentative de validation par le restaurateur lui-même (non Super-Admin) -> refusée (HTTP 403)
    const selfConfirm = await api(`/api/subscriptions/admin/transactions/${pendingTxId}/confirm`, {
      method: 'POST',
      token: registeredToken,
      body: { note: 'Tentative auto-validation illégale' },
    });
    expect(selfConfirm.status).toBe(403);

    // 3c. Validation par le Super-Admin -> active l'abonnement ESSENTIEL et rétablit immédiatement les droits d'écriture
    const adminConfirm1 = await api(`/api/subscriptions/admin/transactions/${pendingTxId}/confirm`, {
      method: 'POST',
      token: superAdminToken,
      body: { note: 'Paiement Wave vérifié par Super-Admin' },
    });
    expect(adminConfirm1.status).toBe(200);
    expect(adminConfirm1.body.data.alreadyConfirmed).toBe(false);
    expect(adminConfirm1.body.data.transaction.status).toBe('confirmed');
    expect(adminConfirm1.body.data.subscription.status).toBe('active');
    expect(adminConfirm1.body.data.subscription.plan_code).toBe('ESSENTIEL');
    const periodEndAfterFirstConfirm = adminConfirm1.body.data.subscription.current_period_end;

    // 3d. Double validation sur la même transaction -> idempotente (alreadyConfirmed: true, pas de double prolongation)
    const adminConfirm2 = await api(`/api/subscriptions/admin/transactions/${pendingTxId}/confirm`, {
      method: 'POST',
      token: superAdminToken,
      body: { note: 'Double clic Super-Admin' },
    });
    expect(adminConfirm2.status).toBe(200);
    expect(adminConfirm2.body.data.alreadyConfirmed).toBe(true);
    expect(adminConfirm2.body.data.subscription.current_period_end).toBe(periodEndAfterFirstConfirm);

    // Les opérations d'écriture fonctionnent à nouveau normalement
    const openCashAfterActivation = await api('/api/cash/sessions/open', {
      method: 'POST',
      token: registeredToken,
      body: { openingAmount: 20000 },
    });
    expect(openCashAfterActivation.status).toBe(201);
  });

  it('4. APPLICATION DES QUOTAS PAR FORMULE (ESSENTIEL, PRO, ENTREPRISE) : limites strictes, anti-concurrence Promise.all, libération par suppression et passage à une formule supérieure', async () => {
    // L'établissement est actuellement actif sur la formule ESSENTIEL :
    // maxLocations = 1, maxUsers = 3 (1 propriétaire + 2 employés), maxTables = 15, maxProducts = 100

    // --- A. QUOTA ÉTABLISSEMENTS / SITES (maxLocations = 1 sur ESSENTIEL) ---
    const secondSiteEssentiel = await api('/api/auth/establishments', {
      method: 'POST',
      token: registeredToken,
      body: {
        companyName: 'Deuxième Site Non Autorisé Essentiel',
        businessType: 'restaurant',
        countryCode: 'SN',
      },
    });
    expect(secondSiteEssentiel.status).toBe(403);
    expect(secondSiteEssentiel.body.error.code).toBe('SUBSCRIPTION_QUOTA_EXCEEDED');
    expect(secondSiteEssentiel.body.error.resourceType).toBe('locations');
    expect(secondSiteEssentiel.body.error.maxAllowed).toBe(1);

    // --- B. QUOTA UTILISATEURS (maxUsers = 3 sur ESSENTIEL) & ANTI-CONCURRENCE ---
    // Il y a déjà 1 utilisateur actif (le propriétaire). On lance 4 créations d'employés en parallèle via Promise.all :
    // exactement 2 doivent réussir (total = 3) et les 2 autres doivent être refusées (403 SUBSCRIPTION_QUOTA_EXCEEDED) !
    const concurrentStaffResults = await Promise.all(
      [1, 2, 3, 4].map((idx) =>
        api('/api/staff', {
          method: 'POST',
          token: registeredToken,
          body: {
            fullName: `Employé Concurrent ${idx}`,
            email: `concurrent.staff.${idx}.${Date.now()}@myrestogest.com`,
            password: 'StaffPassword2026!',
            rolePreset: 'waiter',
          },
        })
      )
    );
    const createdStaff = concurrentStaffResults.filter((r) => r.status === 201);
    const rejectedStaff = concurrentStaffResults.filter((r) => r.status === 403);
    expect(createdStaff).toHaveLength(2);
    expect(rejectedStaff).toHaveLength(2);
    expect(rejectedStaff[0].body.error.code).toBe('SUBSCRIPTION_QUOTA_EXCEEDED');
    expect(rejectedStaff[0].body.error.maxAllowed).toBe(3);

    // Suppression d'un employé (DELETE /api/staff/:userId) -> libère 1 place (2/3) et permet de créer un nouvel employé
    const staffToRemoveId = createdStaff[0].body.data.id;
    const delStaffRes = await api(`/api/staff/${staffToRemoveId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delStaffRes.status).toBe(200);

    const replacementStaff = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Employé Remplaçant Après Libération',
        email: `replacement.staff.${Date.now()}@myrestogest.com`,
        password: 'StaffPassword2026!',
        rolePreset: 'cashier',
      },
    });
    expect(replacementStaff.status).toBe(201);

    // --- C. QUOTA TABLES QR (maxTables = 15 sur ESSENTIEL) ---
    // Initialiser les tables par défaut via GET /api/qr/tables (plafonné automatiquement à 15 sur ESSENTIEL)
    const getTablesEssentiel = await api('/api/qr/tables', { token: registeredToken });
    expect(getTablesEssentiel.status).toBe(200);
    expect(getTablesEssentiel.body.data).toHaveLength(15);

    // Tentative de créer une 16e table sur ESSENTIEL -> refusée (403 SUBSCRIPTION_QUOTA_EXCEEDED)
    const table16Res = await api('/api/qr/tables', {
      method: 'POST',
      token: registeredToken,
      body: {
        code: 'T16',
        name: 'Table 16 Dépassement',
        zone: 'Salle intérieure',
        seats: 4,
      },
    });
    expect(table16Res.status).toBe(403);
    expect(table16Res.body.error.code).toBe('SUBSCRIPTION_QUOTA_EXCEEDED');
    expect(table16Res.body.error.resourceType).toBe('tables');
    expect(table16Res.body.error.maxAllowed).toBe(15);

    // Suppression d'une table inutilisée -> libère une place (14/15) et autorise la création d'une nouvelle table (15/15)
    const tableToDeleteId = getTablesEssentiel.body.data[14].id;
    const delTableRes = await api(`/api/qr/tables/${tableToDeleteId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delTableRes.status).toBe(200);

    const table15NewRes = await api('/api/qr/tables', {
      method: 'POST',
      token: registeredToken,
      body: {
        code: 'T15NEW',
        name: 'Table 15 Remplacée',
        zone: 'Terrasse',
        seats: 4,
      },
    });
    expect(table15NewRes.status).toBe(201);

    // --- D. QUOTA PRODUITS (maxProducts = 100 sur ESSENTIEL) ---
    // Il y a déjà 2 produits actifs créés à l'étape 2. Insérons 97 produits supplémentaires en base pour atteindre 99 produits actifs,
    // puis testons la création du 100e produit via l'API (autorisée) et du 101e produit (refusée 403) !
    await adminPoolRef!.query(
      `INSERT INTO public.products (company_id, name, product_type, unit, selling_price, cost_price, inventory_tracking, is_active)
       SELECT $1, 'Produit Quota Essentiel #' || g, 'finished_good', 'unit', 1000, 300, 'none', TRUE
       FROM generate_series(1, 97) AS g`,
      [registeredCompanyId]
    );

    // 100e produit -> autorisé (201)
    const prod100 = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Produit 100 (Limite Exacte Essentiel)',
        productType: 'finished_good',
        sellingPrice: 2500,
        inventoryTracking: 'none',
      },
    });
    expect(prod100.status).toBe(201);

    // 101e produit -> refusé (403 SUBSCRIPTION_QUOTA_EXCEEDED)
    const prod101 = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Produit 101 (Au-delà du quota Essentiel)',
        productType: 'finished_good',
        sellingPrice: 2500,
        inventoryTracking: 'none',
      },
    });
    expect(prod101.status).toBe(403);
    expect(prod101.body.error.code).toBe('SUBSCRIPTION_QUOTA_EXCEEDED');
    expect(prod101.body.error.resourceType).toBe('products');
    expect(prod101.body.error.maxAllowed).toBe(100);

    // Suppression du 100e produit (DELETE /api/catalog/products/:id) -> libère 1 place (99/100)
    const delProd100 = await api(`/api/catalog/products/${prod100.body.data.id}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delProd100.status).toBe(200);

    // Création d'un nouveau 100e produit -> à nouveau autorisée (201)
    const prod100Replaced = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Produit 100 Remplacé',
        productType: 'finished_good',
        sellingPrice: 2600,
        inventoryTracking: 'none',
      },
    });
    expect(prod100Replaced.status).toBe(201);

    // --- E. PASSAGE À LA FORMULE PRO (maxUsers = 10, maxTables = 50, maxProducts = 500, maxLocations = 1) ---
    await api(`/api/subscriptions/admin/subscriptions/${registeredSubId}/status`, {
      method: 'POST',
      token: superAdminToken,
      body: {
        status: 'active',
        planCode: 'PRO',
        reason: 'Upgrade test vers formule PRO',
      },
    });

    // Sur PRO : le 4e utilisateur, la 16e table et le 101e produit sont désormais autorisés !
    const staff4Pro = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Quatrième Utilisateur Pro',
        email: `staff4.pro.${Date.now()}@myrestogest.com`,
        password: 'StaffPassword2026!',
        rolePreset: 'waiter',
      },
    });
    expect(staff4Pro.status).toBe(201);

    const table16Pro = await api('/api/qr/tables', {
      method: 'POST',
      token: registeredToken,
      body: {
        code: 'T16PRO',
        name: 'Table 16 Autorisée sur Pro',
        zone: 'Salle intérieure',
        seats: 4,
      },
    });
    expect(table16Pro.status).toBe(201);

    const prod101Pro = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Produit 101 Autorisé sur Pro',
        productType: 'finished_good',
        sellingPrice: 3000,
        inventoryTracking: 'none',
      },
    });
    expect(prod101Pro.status).toBe(201);

    // Mais sur PRO, maxLocations = 1 : la création d'un 2e établissement reste bloquée (403)
    const secondSitePro = await api('/api/auth/establishments', {
      method: 'POST',
      token: registeredToken,
      body: {
        companyName: 'Deuxième Site Bloqué sur Pro',
        businessType: 'restaurant',
        countryCode: 'SN',
      },
    });
    expect(secondSitePro.status).toBe(403);
    expect(secondSitePro.body.error.resourceType).toBe('locations');

    // --- F. PASSAGE À LA FORMULE ENTREPRISE (maxLocations = 10, maxUsers = 999, maxTables = 999, maxProducts = 9999) ---
    await api(`/api/subscriptions/admin/subscriptions/${registeredSubId}/status`, {
      method: 'POST',
      token: superAdminToken,
      body: {
        status: 'active',
        planCode: 'ENTREPRISE',
        reason: 'Upgrade test vers formule ENTREPRISE Multi-Sites',
      },
    });

    // Sur ENTREPRISE : la création d'un 2e établissement est autorisée (jusqu'à 10 sites) et hérite du plan ENTREPRISE actif !
    const secondSiteEntreprise = await api('/api/auth/establishments', {
      method: 'POST',
      token: registeredToken,
      body: {
        companyName: 'Le Teranga Annexe Almadies (Site #2)',
        businessType: 'restaurant',
        countryCode: 'SN',
      },
    });
    expect(secondSiteEntreprise.status).toBe(201);
    expect(secondSiteEntreprise.body.data.name).toBe('Le Teranga Annexe Almadies (Site #2)');
    expect(secondSiteEntreprise.body.data.subscription).toBeDefined();
    expect(secondSiteEntreprise.body.data.subscription.plan_code).toBe('ENTREPRISE');
    expect(secondSiteEntreprise.body.data.subscription.status).toBe('active');
    expect(secondSiteEntreprise.body.data.subscription.is_linked_multi_site).toBe(true);
    expect(secondSiteEntreprise.body.data.subscription.max_locations).toBe(10);
    expect(secondSiteEntreprise.body.data.subscription.max_users).toBe(999);
    expect(secondSiteEntreprise.body.data.subscription.max_tables).toBe(999);
    expect(secondSiteEntreprise.body.data.subscription.max_products).toBe(9999);
  });

  it('5. SUPPRESSION DE PRODUITS LIÉS AUX RECETTES, STOCKS ET MULTI-HISTORIQUES : désactivation logique sans perte de recettes/stocks vs suppression physique sans dépendance', async () => {
    // Créer 4 produits dédiés :
    // - pFinishedRecipe : produit fini lié uniquement à une fiche recette (public.recipes)
    // - pIngredientRecipe : ingrédient lié uniquement à une fiche recette (public.recipe_ingredients)
    // - pStockLevelOnly : produit lié uniquement à une ligne de stock_levels (0 stock_movements)
    // - pMultiHistory : produit lié simultanément à stock_levels, stock_movements, recipe_ingredients et sale_items
    const pFinishedRes = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Gâteau Fondant Recette Seule',
        productType: 'finished_good',
        sellingPrice: 4500,
        costPrice: 1500,
        inventoryTracking: 'recipe_on_sale',
      },
    });
    expect(pFinishedRes.status).toBe(201);
    const pFinishedId = pFinishedRes.body.data.id;

    const pIngRes = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Chocolat Noir 70% Ingrédient Seul',
        productType: 'raw_material',
        unit: 'kg',
        sellingPrice: 0,
        costPrice: 6000,
        inventoryTracking: 'none',
      },
    });
    expect(pIngRes.status).toBe(201);
    const pIngId = pIngRes.body.data.id;

    const pStockOnlyRes = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Farine T55 Niveau Stock Seul',
        productType: 'raw_material',
        unit: 'kg',
        sellingPrice: 0,
        costPrice: 800,
        inventoryTracking: 'none',
      },
    });
    expect(pStockOnlyRes.status).toBe(201);
    const pStockOnlyId = pStockOnlyRes.body.data.id;

    const pMultiRes = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: {
        name: 'Croissant Pur Beurre Multi-Historique',
        productType: 'finished_good',
        unit: 'pièce',
        sellingPrice: 900,
        costPrice: 300,
        inventoryTracking: 'direct',
      },
    });
    expect(pMultiRes.status).toBe(201);
    const pMultiId = pMultiRes.body.data.id;

    // 5a. Créer la recette liant pFinishedId et pIngId (+ pMultiId)
    const recipeRes = await api('/api/catalog/recipes', {
      method: 'POST',
      token: registeredToken,
      body: {
        finishedProductId: pFinishedId,
        name: 'Fiche Technique Fondant Chocolat',
        outputQuantity: 1,
        ingredients: [
          { ingredientId: pIngId, quantityRequired: 0.25 },
          { ingredientId: pMultiId, quantityRequired: 1 },
        ],
      },
    });
    expect(recipeRes.status).toBe(201);
    const recipeId = recipeRes.body.data.id;

    // 5b. Insérer uniquement une ligne dans stock_levels (sans aucun mouvement dans stock_movements) pour pStockOnlyId
    await adminPoolRef!.query(
      `INSERT INTO public.stock_levels (company_id, product_id, current_quantity)
       VALUES ($1, $2, 15)
       ON CONFLICT (company_id, product_id) DO UPDATE SET current_quantity = 15`,
      [registeredCompanyId, pStockOnlyId]
    );

    // 5c. Générer mouvement de stock + vente pour pMultiId
    const adjMulti = await api('/api/inventory/adjustments', {
      method: 'POST',
      token: registeredToken,
      body: {
        productId: pMultiId,
        movementType: 'production_in',
        quantityDelta: 20,
        notes: 'Production matin croissants',
      },
    });
    expect(adjMulti.status).toBe(201);

    const saleMulti = await api('/api/sales', {
      method: 'POST',
      token: registeredToken,
      body: {},
    });
    expect(saleMulti.status).toBe(201);
    const saleId = saleMulti.body.data.id;

    const addItemMulti = await api(`/api/sales/${saleId}/items`, {
      method: 'POST',
      token: registeredToken,
      body: { productId: pMultiId, quantity: 2 },
    });
    expect(addItemMulti.status).toBe(201);

    // 5d. Suppression du produit fini lié UNIQUEMENT à une recette (recipes) -> désactivé logiquement (200), recette préservée !
    const delFinished = await api(`/api/catalog/products/${pFinishedId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delFinished.status).toBe(200);
    expect(delFinished.body.data.mode).toBe('deactivated');
    expect(delFinished.body.data.dependencies.recipes).toBe(1);

    // 5e. Suppression de l'ingrédient lié UNIQUEMENT à recipe_ingredients -> désactivé logiquement (200), ingrédient préservé !
    const delIng = await api(`/api/catalog/products/${pIngId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delIng.status).toBe(200);
    expect(delIng.body.data.mode).toBe('deactivated');
    expect(delIng.body.data.dependencies.recipeIngredients).toBe(1);

    // 5f. Suppression du produit lié UNIQUEMENT à stock_levels -> désactivé logiquement (200), stock_levels préservé !
    const delStockOnly = await api(`/api/catalog/products/${pStockOnlyId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delStockOnly.status).toBe(200);
    expect(delStockOnly.body.data.mode).toBe('deactivated');
    expect(delStockOnly.body.data.dependencies.stockLevels).toBe(1);
    expect(delStockOnly.body.data.dependencies.stockMovements).toBe(0);

    // 5g. Suppression du produit lié à PLUSIEURS historiques simultanément -> désactivé logiquement (200), tous les historiques préservés !
    const delMulti = await api(`/api/catalog/products/${pMultiId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delMulti.status).toBe(200);
    expect(delMulti.body.data.mode).toBe('deactivated');
    expect(delMulti.body.data.dependencies.saleItems).toBeGreaterThanOrEqual(1);
    expect(delMulti.body.data.dependencies.stockMovements).toBeGreaterThanOrEqual(1);
    expect(delMulti.body.data.dependencies.stockLevels).toBe(1);
    expect(delMulti.body.data.dependencies.recipeIngredients).toBe(1);

    // Vérifier en base qu'aucune recette, aucun ingrédient, aucun niveau de stock ni aucune ligne de vente n'a été détruit
    const verifyIntegrity = await adminPoolRef!.query(
      `SELECT
         (SELECT COUNT(*)::INT FROM public.recipes WHERE id = $1) AS rec_cnt,
         (SELECT COUNT(*)::INT FROM public.recipe_ingredients WHERE recipe_id = $1) AS ing_cnt,
         (SELECT COUNT(*)::INT FROM public.stock_levels WHERE product_id IN ($2, $3)) AS sl_cnt,
         (SELECT COUNT(*)::INT FROM public.sale_items WHERE sale_id = $4) AS si_cnt`,
      [recipeId, pStockOnlyId, pMultiId, saleId]
    );
    expect(verifyIntegrity.rows[0].rec_cnt).toBe(1);
    expect(verifyIntegrity.rows[0].ing_cnt).toBe(2);
    expect(verifyIntegrity.rows[0].sl_cnt).toBe(2);
    expect(verifyIntegrity.rows[0].si_cnt).toBe(1);

    // 5h. Suppression d'un produit sans aucune dépendance -> suppression physique (mode: 'deleted')
    const pNoDepsRes = await api('/api/catalog/products', {
      method: 'POST',
      token: registeredToken,
      body: { name: 'Produit Éphémère Sans Dépendance', sellingPrice: 500, inventoryTracking: 'none' },
    });
    expect(pNoDepsRes.status).toBe(201);
    const pNoDepsId = pNoDepsRes.body.data.id;

    const delNoDeps = await api(`/api/catalog/products/${pNoDepsId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(delNoDeps.status).toBe(200);
    expect(delNoDeps.body.data.mode).toBe('deleted');

    const pNoDepsDb = await adminPoolRef!.query(
      `SELECT COUNT(*)::INT AS cnt FROM public.products WHERE id = $1`,
      [pNoDepsId]
    );
    expect(pNoDepsDb.rows[0].cnt).toBe(0);
  });

  it('6. RÉUTILISATION DE L’ADRESSE E-MAIL D’UN ANCIEN EMPLOYÉ : rattachement sans doublon avec préservation du nom et de l’historique, et refus inter-établissements', async () => {
    const staffEmail = `ancien.employe.${Date.now()}@myrestogest.com`;

    // 6a. Création initiale de l'employé dans l'établissement A
    const create1 = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Aminata Diallo Originale',
        email: staffEmail,
        password: 'OldPassword2026!',
        rolePreset: 'waiter',
      },
    });
    expect(create1.status).toBe(201);
    expect(create1.body.data.reattached).toBe(false);
    const originalUserId = create1.body.data.id;

    // Connexion de l'employé et création d'une commande/vente pour générer un historique à son nom
    const staffLogin1 = await api('/api/auth/login', {
      method: 'POST',
      body: { email: staffEmail, password: 'OldPassword2026!' },
    });
    expect(staffLogin1.status).toBe(200);
    const oldStaffToken = staffLogin1.body.data.token;

    const staffSale = await api('/api/sales', {
      method: 'POST',
      token: oldStaffToken,
      body: { notes: 'Commande prise par Aminata avant départ' },
    });
    expect(staffSale.status).toBe(201);
    const historicalSaleId = staffSale.body.data.id;

    // 6b. Tentative de rattacher le compte Super-Admin plateforme -> refusée (403)
    const superAdminAttachAttempt = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Tentative Super Admin',
        email: superAdminEmail,
        password: 'HijackPassword2026!',
        rolePreset: 'waiter',
      },
    });
    expect(superAdminAttachAttempt.status).toBe(403);

    // 6c. Tentative de recréer le même e-mail pendant qu'il est DÉJÀ actif dans l'établissement -> refusée (409)
    const dupActive = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Aminata Doublon',
        email: staffEmail,
        password: 'NewPassword2026!',
        rolePreset: 'cashier',
      },
    });
    expect(dupActive.status).toBe(409);

    // 6c. Retrait de l'employé de l'établissement (DELETE /api/staff/:userId)
    const removeRes = await api(`/api/staff/${originalUserId}`, {
      method: 'DELETE',
      token: registeredToken,
    });
    expect(removeRes.status).toBe(200);

    // Sa session précédente est immédiatement révoquée
    const oldTokenCheck = await api('/api/auth/me', { token: oldStaffToken });
    expect(oldTokenCheck.status).toBe(401);

    // 6d. Un AUTRE établissement (Restaurant B) tente de rattacher l'adresse e-mail d'Aminata -> REFUSÉ (409)
    const regOther = await api('/api/auth/register', {
      method: 'POST',
      body: {
        companyName: 'Restaurant Concurrent B',
        businessType: 'restaurant',
        countryCode: 'SN',
        email: `owner.other.b.${Date.now()}@myrestogest.com`,
        password: 'OwnerBPassword2026!',
        fullName: 'Patron Concurrent B',
        acceptTerms: true,
      },
    });
    expect(regOther.status).toBe(201);
    const otherOwnerToken = regOther.body.data.token;

    const hijackAttempt = await api('/api/staff', {
      method: 'POST',
      token: otherOwnerToken,
      body: {
        fullName: 'Tentative Récupération Inter-Établissement',
        email: staffEmail,
        password: 'HijackPassword2026!',
        rolePreset: 'waiter',
      },
    });
    expect(hijackAttempt.status).toBe(409);

    // 6e. L'établissement A réembauche/rattache son ancien employé avec la même adresse e-mail et un nouveau rôle (cashier)
    const reattachRes = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Nom Qui Ne Doit Pas Écraser',
        email: staffEmail,
        password: 'RehiredPassword2026!',
        rolePreset: 'cashier',
      },
    });
    expect(reattachRes.status).toBe(201);
    expect(reattachRes.body.data.reattached).toBe(true);
    // Même user_id (aucun doublon) et nom personnel existant préservé !
    expect(reattachRes.body.data.id).toBe(originalUserId);
    expect(reattachRes.body.data.fullName).toBe('Aminata Diallo Originale');
    expect(reattachRes.body.data.roleCode).toBe('cashier');

    // Vérifier en base qu'il n'existe qu'une seule ligne dans public.users pour cet e-mail
    const userCntRes = await adminPoolRef!.query(
      `SELECT COUNT(*)::INT AS cnt FROM public.users WHERE LOWER(email) = $1`,
      [staffEmail.toLowerCase()]
    );
    expect(userCntRes.rows[0].cnt).toBe(1);

    // Vérifier que l'historique de sa vente précédente est toujours rattaché à son user_id
    const saleHistRes = await adminPoolRef!.query(
      `SELECT user_id FROM public.sales WHERE id = $1`,
      [historicalSaleId]
    );
    expect(saleHistRes.rows[0].user_id).toBe(originalUserId);

    // Vérifier que l'employé réactivé peut se connecter avec son nouveau mot de passe et dispose bien du rôle cashier
    const staffLogin2 = await api('/api/auth/login', {
      method: 'POST',
      body: { email: staffEmail, password: 'RehiredPassword2026!' },
    });
    expect(staffLogin2.status).toBe(200);
    expect(staffLogin2.body.data.user.id).toBe(originalUserId);
    expect(staffLogin2.body.data.role.code).toBe('cashier');
  });

  it('7. HÉRITAGE DU PLAN ENTREPRISE MULTI-SITES & PÉRIMÈTRE DE PUT /api/subscriptions/company-settings', async () => {
    // 7a. Vérifier qu'un employé non-propriétaire ne peut PAS créer de site supplémentaire même sur un établissement ENTREPRISE
    const empEmail = `caissier.multisite.${Date.now()}@myrestogest.com`;
    const empCreate = await api('/api/staff', {
      method: 'POST',
      token: registeredToken,
      body: {
        fullName: 'Caissier Sans Droit Multi-Sites',
        email: empEmail,
        password: 'CashierPassword2026!',
        rolePreset: 'cashier',
      },
    });
    expect(empCreate.status).toBe(201);
    const empLogin = await api('/api/auth/login', {
      method: 'POST',
      body: { email: empEmail, password: 'CashierPassword2026!' },
    });
    expect(empLogin.status).toBe(200);
    const cashierToken = empLogin.body.data.token;

    const unauthorizedSiteCreate = await api('/api/auth/establishments', {
      method: 'POST',
      token: cashierToken,
      body: {
        companyName: 'Site Pirate Par Employé',
        businessType: 'restaurant',
        countryCode: 'SN',
      },
    });
    expect(unauthorizedSiteCreate.status).toBe(403);
    expect(unauthorizedSiteCreate.body.error.code).toBe('OWNER_PERMISSION_REQUIRED');

    // 7b. Le propriétaire a déjà 2 sites actifs (Site #1 principal + Site #2 créé à l'étape 4F).
    // Créons les sites #3 à #10 (soit 8 sites supplémentaires) pour atteindre la limite de 10 sites ENTREPRISE !
    const createdChildSiteIds: string[] = [];
    for (let siteNum = 3; siteNum <= 10; siteNum++) {
      const siteRes = await api('/api/auth/establishments', {
        method: 'POST',
        token: registeredToken,
        body: {
          companyName: `Le Teranga Site #${siteNum}`,
          businessType: 'restaurant',
          countryCode: 'SN',
        },
      });
      expect(siteRes.status).toBe(201);
      expect(siteRes.body.data.subscription.plan_code).toBe('ENTREPRISE');
      expect(siteRes.body.data.subscription.status).toBe('active');
      createdChildSiteIds.push(siteRes.body.data.id);
    }

    // 7c. Tentative de création d'un 11e site sur ENTREPRISE -> refusée (403 SUBSCRIPTION_QUOTA_EXCEEDED, maxAllowed: 10)
    const site11Res = await api('/api/auth/establishments', {
      method: 'POST',
      token: registeredToken,
      body: {
        companyName: 'Le Teranga Site #11 Dépassement Entreprise',
        businessType: 'restaurant',
        countryCode: 'SN',
      },
    });
    expect(site11Res.status).toBe(403);
    expect(site11Res.body.error.code).toBe('SUBSCRIPTION_QUOTA_EXCEEDED');
    expect(site11Res.body.error.resourceType).toBe('locations');
    expect(site11Res.body.error.currentCount).toBe(10);
    expect(site11Res.body.error.maxAllowed).toBe(10);

    // 7d. Vérifier l'absence de double facturation : aucune transaction ni facture SaaS n'a été créée pour les sites secondaires,
    // et le MRR Super-Admin ne multiplie pas le revenu par le nombre de sites secondaires
    const [childTxCount, childInvCount, saOverviewBefore] = await Promise.all([
      adminPoolRef!.query(
        `SELECT COUNT(*)::INT AS cnt
         FROM public.saas_subscription_transactions
         WHERE company_id = ANY($1::uuid[])`,
        [createdChildSiteIds]
      ),
      adminPoolRef!.query(
        `SELECT COUNT(*)::INT AS cnt
         FROM public.saas_invoices
         WHERE company_id = ANY($1::uuid[])`,
        [createdChildSiteIds]
      ),
      api('/api/subscriptions/admin/overview', { token: superAdminToken }),
    ]);
    expect(childTxCount.rows[0].cnt).toBe(0);
    expect(childInvCount.rows[0].cnt).toBe(0);
    expect(saOverviewBefore.status).toBe(200);
    // Un seul établissement principal payant en ENTREPRISE (25 000 XOF/mois), pas 10x 25 000 XOF !
    expect(Number(saOverviewBefore.body.data.kpis.mrr)).toBeLessThan(250000);

    // 7e. Connexion du propriétaire sur le Site #3 et vérification que son abonnement actif est bien ENTREPRISE
    const site3Id = createdChildSiteIds[0];
    const loginSite3 = await api('/api/auth/login', {
      method: 'POST',
      body: {
        email: (await api('/api/auth/me', { token: registeredToken })).body.data.user.email,
        password: 'Password2026!',
        companyId: site3Id,
      },
    });
    expect(loginSite3.status).toBe(200);
    const site3Token = loginSite3.body.data.token;

    const site3Sub = await api('/api/subscriptions/current', { token: site3Token });
    expect(site3Sub.status).toBe(200);
    expect(site3Sub.body.data.subscription.plan_code).toBe('ENTREPRISE');
    expect(site3Sub.body.data.subscription.status).toBe('active');
    expect(site3Sub.body.data.subscription.isReadOnly).toBe(false);

    // 7f. Lorsque l'abonnement principal expire ou est suspendu, les sites secondaires basculent immédiatement en Lecture Seule !
    await api(`/api/subscriptions/admin/subscriptions/${registeredSubId}/status`, {
      method: 'POST',
      token: superAdminToken,
      body: {
        status: 'expired',
        reason: 'Simulation expiration abonnement principal Entreprise',
      },
    });

    const blockedOnChildSite = await api('/api/catalog/products', {
      method: 'POST',
      token: site3Token,
      body: { name: 'Produit Bloqué Sur Site Secondaire Expiré', sellingPrice: 1800 },
    });
    expect(blockedOnChildSite.status).toBe(403);
    expect(blockedOnChildSite.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    // Vérifier aussi le statut 'suspended' sur l'abonnement principal
    await api(`/api/subscriptions/admin/subscriptions/${registeredSubId}/status`, {
      method: 'POST',
      token: superAdminToken,
      body: {
        status: 'suspended',
        reason: 'Simulation suspension abonnement principal Entreprise',
      },
    });

    const blockedSuspendedOnChildSite = await api('/api/sales', {
      method: 'POST',
      token: site3Token,
      body: {},
    });
    expect(blockedSuspendedOnChildSite.status).toBe(403);
    expect(blockedSuspendedOnChildSite.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    // 7g. Vérification du périmètre de PUT /api/subscriptions/company-settings en mode Lecture Seule :
    // - Les paramètres opérationnels (name, defaultTaxRate, allowNegativeStock) sont BLOQUÉS (403 SUBSCRIPTION_EXPIRED_READ_ONLY)
    const blockedOperationalSettings = await api('/api/subscriptions/company-settings', {
      method: 'PUT',
      token: registeredToken,
      body: {
        currency: 'XOF',
        name: 'Renommage Interdit En Lecture Seule',
        defaultTaxRate: 18,
        allowNegativeStock: true,
      },
    });
    expect(blockedOperationalSettings.status).toBe(403);
    expect(blockedOperationalSettings.body.error.code).toBe('SUBSCRIPTION_EXPIRED_READ_ONLY');

    // - Les paramètres de facturation pure (currency, country, whatsappPhone) restent AUTORISÉS (200) pour préparer le renouvellement
    const allowedBillingSettings = await api('/api/subscriptions/company-settings', {
      method: 'PUT',
      token: registeredToken,
      body: {
        currency: 'GNF',
        country: 'GN',
        whatsappPhone: '+221788979342',
      },
    });
    expect(allowedBillingSettings.status).toBe(200);
    expect(allowedBillingSettings.body.data.currency).toBe('GNF');

    // Remettre la devise en XOF et vérifier qu'un employé sans 'settings:manage' (cashier) est bloqué (403)
    await api('/api/subscriptions/company-settings', {
      method: 'PUT',
      token: registeredToken,
      body: { currency: 'XOF', country: 'SN' },
    });

    const cashierSettingsAttempt = await api('/api/subscriptions/company-settings', {
      method: 'PUT',
      token: cashierToken,
      body: { currency: 'GNF' },
    });
    expect(cashierSettingsAttempt.status).toBe(403);

    // 7h. Changement de formule de l'abonnement principal (ENTREPRISE -> PRO) :
    // Le site secondaire reflète immédiatement la formule PRO et ses quotas (maxUsers: 10, maxTables: 50, maxProducts: 500)
    await api(`/api/subscriptions/admin/subscriptions/${registeredSubId}/status`, {
      method: 'POST',
      token: superAdminToken,
      body: {
        status: 'active',
        planCode: 'PRO',
        extendDays: 30,
        reason: 'Changement de formule Entreprise vers Pro',
      },
    });

    const site3SubAfterDowngrade = await api('/api/subscriptions/current', { token: site3Token });
    expect(site3SubAfterDowngrade.status).toBe(200);
    expect(site3SubAfterDowngrade.body.data.subscription.plan_code).toBe('PRO');
    expect(site3SubAfterDowngrade.body.data.subscription.status).toBe('active');
    expect(site3SubAfterDowngrade.body.data.subscription.max_locations).toBe(1);
    expect(site3SubAfterDowngrade.body.data.subscription.max_users).toBe(10);
    expect(site3SubAfterDowngrade.body.data.subscription.max_tables).toBe(50);
    expect(site3SubAfterDowngrade.body.data.subscription.max_products).toBe(500);

    // Après passage à PRO (max_locations = 1), la création d'un nouveau site depuis le site principal ou secondaire est bloquée
    const [newSiteMainAfterDowngrade, newSiteChildAfterDowngrade] = await Promise.all([
      api('/api/auth/establishments', {
        method: 'POST',
        token: registeredToken,
        body: { companyName: 'Site Interdit Après Downgrade Pro (Principal)', businessType: 'restaurant', countryCode: 'SN' },
      }),
      api('/api/auth/establishments', {
        method: 'POST',
        token: site3Token,
        body: { companyName: 'Site Interdit Après Downgrade Pro (Secondaire)', businessType: 'restaurant', countryCode: 'SN' },
      }),
    ]);
    expect(newSiteMainAfterDowngrade.status).toBe(403);
    expect(newSiteMainAfterDowngrade.body.error.code).toBe('SUBSCRIPTION_QUOTA_EXCEEDED');
    expect(newSiteChildAfterDowngrade.status).toBe(403);
    expect(newSiteChildAfterDowngrade.body.error.code).toBe('SUBSCRIPTION_QUOTA_EXCEEDED');
  });
});
