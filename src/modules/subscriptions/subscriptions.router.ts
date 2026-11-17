import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth-middleware.js';
import { adminPool, type IDbClient } from '../../db/pool.js';
import { config } from '../../config/env.js';

export const subscriptionsRouter = Router();

async function withAdminTransaction<T>(fn: (client: IDbClient) => Promise<T>): Promise<T> {
  const client = await adminPool.connect();
  try {
    await client.query('BEGIN');
    const res = await fn(client);
    await client.query('COMMIT');
    return res;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const DEFAULT_PLANS = [
  {
    code: 'ESSENTIEL',
    name: 'Essentiel POS',
    monthlyPrice: 15000,
    quarterlyPrice: 42000,
    semiannualPrice: 81000,
    yearlyPrice: 150000,
    setupFee: 0,
    trialDays: 14,
    maxUsers: 3,
    maxLocations: 1,
    maxTables: 15,
    maxProducts: 100,
    features: [
      'Caisse tactile POS & Tickets',
      'Menu Digital QR Code (jusqu’à 15 tables)',
      'Suivi des stocks de base',
      'Clôture de caisse Z quotidienne',
      '1 établissement • 3 utilisateurs',
    ],
  },
  {
    code: 'PRO',
    name: 'Pro Cloud Restaurant',
    monthlyPrice: 29000,
    quarterlyPrice: 81000,
    semiannualPrice: 156000,
    yearlyPrice: 290000,
    setupFee: 0,
    trialDays: 14,
    maxUsers: 10,
    maxLocations: 1,
    maxTables: 50,
    maxProducts: 500,
    features: [
      'Plan de salle interactif & Commandes QR illimitées',
      'Écran Cuisine (KDS) temps réel & alertes sonores',
      'Recettes & déstockage anti-coulage automatique',
      'Livraison & Récapitulatif WhatsApp',
      'Rapports Z exportables & Statistiques digitales',
    ],
  },
  {
    code: 'ENTREPRISE',
    name: 'Entreprise Multi-Sites',
    monthlyPrice: 59000,
    quarterlyPrice: 165000,
    semiannualPrice: 318000,
    yearlyPrice: 590000,
    setupFee: 25000,
    trialDays: 14,
    maxUsers: 999,
    maxLocations: 10,
    maxTables: 999,
    maxProducts: 9999,
    features: [
      'Multi-établissements & Utilisateurs illimités',
      'Audit de sécurité complet & Contrôle des écarts',
      'Menu QR multi-zones VIP, Terrasse & À emporter',
      'Support prioritaire 24/7 (Sénégal & Guinée)',
      'Accompagnement déploiement sur site inclus',
    ],
  },
];

export function computeSaasWebhookSignature(payload: string): string {
  const secret = process.env.SAAS_WEBHOOK_SECRET || config.jwt.secret;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

async function ensureDefaultPlansAndMerchant(client: IDbClient): Promise<void> {
  for (const p of DEFAULT_PLANS) {
    await client.query(
      `INSERT INTO public.subscription_plans (
         code, name, monthly_price, quarterly_price, semiannual_price, yearly_price,
         setup_fee, trial_days, max_users, max_locations, max_tables, max_products,
         currency, features, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'XOF', $13::jsonb, TRUE)
       ON CONFLICT (name) DO UPDATE
       SET code = COALESCE(public.subscription_plans.code, EXCLUDED.code),
           quarterly_price = CASE WHEN public.subscription_plans.quarterly_price = 0 THEN EXCLUDED.quarterly_price ELSE public.subscription_plans.quarterly_price END,
           semiannual_price = CASE WHEN public.subscription_plans.semiannual_price = 0 THEN EXCLUDED.semiannual_price ELSE public.subscription_plans.semiannual_price END,
           max_users = COALESCE(public.subscription_plans.max_users, EXCLUDED.max_users),
           max_locations = COALESCE(public.subscription_plans.max_locations, EXCLUDED.max_locations),
           max_tables = COALESCE(public.subscription_plans.max_tables, EXCLUDED.max_tables),
           max_products = COALESCE(public.subscription_plans.max_products, EXCLUDED.max_products)`,
      [
        p.code,
        p.name,
        p.monthlyPrice,
        p.quarterlyPrice,
        p.semiannualPrice,
        p.yearlyPrice,
        p.setupFee,
        p.trialDays,
        p.maxUsers,
        p.maxLocations,
        p.maxTables,
        p.maxProducts,
        JSON.stringify(p.features),
      ]
    );
  }

  const merchCount = await client.query(`SELECT COUNT(*)::INT AS cnt FROM public.saas_merchant_settings`);
  if (Number(merchCount.rows[0]?.cnt || 0) === 0) {
    await client.query(
      `INSERT INTO public.saas_merchant_settings (
         legal_name, brand_name, support_email, support_phone, whatsapp_phone,
         address, default_currency, active_provider, wave_merchant_number,
         orange_money_merchant_number, mtn_momo_merchant_number,
         bank_name, bank_account_name, bank_iban
       )
       VALUES (
         'RESTOGEST CLOUD SAS', 'RESTOGEST SaaS', 'facturation@myrestogest.com',
         '+221 77 000 00 00', '+221 77 000 00 00',
         'Dakar (Sénégal) & Conakry (Guinée)', 'XOF', 'paydunya',
         '+221 77 800 10 10', '+221 77 900 20 20', '+224 664 00 00 00',
         'UBA / Orabank Afrique de l’Ouest', 'RESTOGEST CLOUD SAS', 'SN08 0010 2030 4050 6070 8090'
       )`
    );
  }
}

function getPeriodDays(billingPeriod: string): number {
  if (billingPeriod === 'yearly') return 365;
  if (billingPeriod === 'semiannual') return 180;
  if (billingPeriod === 'quarterly') return 90;
  return 30;
}

function getPlanPriceForPeriod(plan: any, billingPeriod: string, currency: string): {
  baseSubscriptionPrice: number;
  setupFee: number;
} {
  const rate = currency === 'GNF' ? 15 : 1;
  let baseXof = Number(plan.monthly_price);
  if (billingPeriod === 'quarterly') {
    baseXof = Number(plan.quarterly_price || Number(plan.monthly_price) * 3);
  } else if (billingPeriod === 'semiannual') {
    baseXof = Number(plan.semiannual_price || Number(plan.monthly_price) * 6);
  } else if (billingPeriod === 'yearly') {
    baseXof = Number(plan.yearly_price);
  }
  const setupXof = Number(plan.setup_fee || 0);
  return {
    baseSubscriptionPrice: Math.round(baseXof * rate),
    setupFee: Math.round(setupXof * rate),
  };
}

function computeProviderFeeRate(method: string): number {
  if (['bank_transfer', 'manual'].includes(method)) return 0;
  if (method === 'wave') return 0.01; // 1% Wave Business
  if (['orange_money', 'mtn_momo'].includes(method)) return 0.015; // 1.5% Mobile Money
  if (['paydunya', 'paytech', 'cinetpay'].includes(method)) return 0.02; // 2% Agrégateur
  if (method === 'card_visa_uba') return 0.025; // 2.5% Carte Visa/Mastercard
  return 0.015;
}

async function confirmSaasTransactionAndActivateSubscription(
  client: IDbClient,
  txRow: any,
  opts: {
    providerTransactionId?: string | null;
    confirmedByUserId?: string | null;
    isWebhook?: boolean;
  } = {}
): Promise<{
  alreadyConfirmed: boolean;
  transaction: any;
  subscription: any;
  invoice: any;
}> {
  if (txRow.status === 'confirmed') {
    const updatedTx = await client.query(
      `UPDATE public.saas_subscription_transactions
       SET webhook_confirmations_count = webhook_confirmations_count + CASE WHEN $2 THEN 1 ELSE 0 END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [txRow.id, Boolean(opts.isWebhook)]
    );
    const subRes = await client.query(
      `SELECT * FROM public.company_subscriptions WHERE company_id = $1`,
      [txRow.company_id]
    );
    const invRes = await client.query(
      `SELECT * FROM public.saas_invoices WHERE transaction_id = $1`,
      [txRow.id]
    );
    return {
      alreadyConfirmed: true,
      transaction: updatedTx.rows[0],
      subscription: subRes.rows[0] || null,
      invoice: invRes.rows[0] || null,
    };
  }

  const periodDays = getPeriodDays(txRow.billing_period);

  // If subscription is currently active and in the future, extend from current_period_end, else from NOW()
  const existingSubRes = await client.query(
    `SELECT * FROM public.company_subscriptions WHERE company_id = $1 FOR UPDATE`,
    [txRow.company_id]
  );

  let periodStart = new Date();
  if (
    existingSubRes.rows.length > 0 &&
    existingSubRes.rows[0].status === 'active' &&
    new Date(existingSubRes.rows[0].current_period_end) > periodStart
  ) {
    periodStart = new Date(existingSubRes.rows[0].current_period_end);
  }
  const periodEnd = new Date(periodStart.getTime() + periodDays * 24 * 3600 * 1000);

  const planRes = await client.query(
    `SELECT id, name FROM public.subscription_plans WHERE code = $1`,
    [txRow.plan_code]
  );
  const planId = planRes.rows[0]?.id || null;
  const planName = planRes.rows[0]?.name || txRow.plan_code;

  const subRes = await client.query(
    `INSERT INTO public.company_subscriptions (
       company_id, plan_id, plan_code, status, billing_period,
       starts_at, ends_at, current_period_start, current_period_end,
       last_payment_method, last_payment_ref, last_payment_amount, updated_at
     )
     VALUES ($1, $2, $3, 'active', $4, $5, $6, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (company_id) DO UPDATE
     SET plan_id = COALESCE(EXCLUDED.plan_id, public.company_subscriptions.plan_id),
         plan_code = EXCLUDED.plan_code,
         status = 'active',
         billing_period = EXCLUDED.billing_period,
         starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         last_payment_method = EXCLUDED.last_payment_method,
         last_payment_ref = EXCLUDED.last_payment_ref,
         last_payment_amount = EXCLUDED.last_payment_amount,
         updated_at = NOW()
     RETURNING *`,
    [
      txRow.company_id,
      planId,
      txRow.plan_code,
      txRow.billing_period,
      periodStart.toISOString(),
      periodEnd.toISOString(),
      txRow.payment_method,
      txRow.transaction_ref,
      txRow.gross_amount,
    ]
  );
  const subscription = subRes.rows[0];

  const txUpdateRes = await client.query(
    `UPDATE public.saas_subscription_transactions
     SET status = 'confirmed',
         subscription_id = $2,
         provider_transaction_id = COALESCE($3, provider_transaction_id),
         webhook_verified = CASE WHEN $4 THEN TRUE ELSE webhook_verified END,
         webhook_confirmations_count = webhook_confirmations_count + CASE WHEN $4 THEN 1 ELSE 0 END,
         confirmed_by_user_id = COALESCE($5, confirmed_by_user_id),
         period_start = $6,
         period_end = $7,
         confirmed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [
      txRow.id,
      subscription.id,
      opts.providerTransactionId || null,
      Boolean(opts.isWebhook),
      opts.confirmedByUserId || null,
      periodStart.toISOString(),
      periodEnd.toISOString(),
    ]
  );
  const confirmedTx = txUpdateRes.rows[0];

  // Fetch company details for official invoice
  const compRes = await client.query(
    `SELECT name FROM public.companies WHERE id = $1`,
    [txRow.company_id]
  );
  const company = compRes.rows[0] || { name: 'Client RestoGest' };

  const invoiceNumber = `FA-RG-${new Date().getFullYear()}-${Date.now().toString().slice(-5)}-${crypto
    .randomBytes(2)
    .toString('hex')
    .toUpperCase()}`;

  const invRes = await client.query(
    `INSERT INTO public.saas_invoices (
       invoice_number, company_id, subscription_id, transaction_id,
       customer_company_name, customer_email, customer_phone, customer_address,
       plan_code, plan_name, billing_period, period_start, period_end,
       currency, subtotal_amount, setup_fee_amount, discount_amount, tax_amount, total_amount,
       payment_method, payment_reference, status, issued_at, paid_at
     )
     VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12, $13,
       $14, $15, $16, $17, $18, $19,
       $20, $21, 'paid', NOW(), NOW()
     )
     ON CONFLICT (transaction_id) DO UPDATE
     SET updated_at = NOW()
     RETURNING *`,
    [
      invoiceNumber,
      txRow.company_id,
      subscription.id,
      confirmedTx.id,
      company.name,
      company.email || null,
      company.phone || null,
      company.address || null,
      txRow.plan_code,
      planName,
      txRow.billing_period,
      periodStart.toISOString(),
      periodEnd.toISOString(),
      txRow.currency,
      txRow.subscription_price_snapshot,
      txRow.setup_fee_snapshot,
      txRow.discount_amount,
      txRow.tax_amount,
      txRow.gross_amount,
      txRow.payment_method,
      txRow.transaction_ref,
    ]
  );

  return {
    alreadyConfirmed: false,
    transaction: confirmedTx,
    subscription,
    invoice: invRes.rows[0],
  };
}

// -------------------------------------------------------------
// 1. ENDPOINT PUBLIC : COMPARATEUR DES OFFRES & TARIFS SAAS
// -------------------------------------------------------------
subscriptionsRouter.get('/plans/public', async (_req, res, next) => {
  try {
    const client = await adminPool.connect();
    try {
      await ensureDefaultPlansAndMerchant(client);
      const plansRes = await client.query(
        `SELECT code, name, monthly_price, quarterly_price, semiannual_price, yearly_price,
                setup_fee, trial_days, max_users, max_locations, max_tables, max_products,
                currency, features, is_active
         FROM public.subscription_plans
         WHERE is_active = TRUE
         ORDER BY monthly_price ASC`
      );
      const merchRes = await client.query(
        `SELECT brand_name, support_email, support_phone, whatsapp_phone,
                default_currency, active_provider, manual_payment_instructions,
                bank_name, bank_account_name, bank_iban,
                wave_merchant_number, orange_money_merchant_number, mtn_momo_merchant_number
         FROM public.saas_merchant_settings
         ORDER BY created_at ASC LIMIT 1`
      );
      res.json({
        data: {
          plans: plansRes.rows,
          merchant: merchRes.rows[0] || null,
          supportedPaymentMethods: [
            { code: 'wave', label: 'Wave Mobile Money', category: 'mobile_money', instant: true },
            { code: 'orange_money', label: 'Orange Money', category: 'mobile_money', instant: true },
            { code: 'mtn_momo', label: 'MTN MoMo', category: 'mobile_money', instant: true },
            { code: 'paydunya', label: 'PayDunya Checkout (Sénégal / UEMOA)', category: 'aggregator', instant: true },
            { code: 'paytech', label: 'PayTech Sénégal', category: 'aggregator', instant: true },
            { code: 'cinetpay', label: 'CinetPay Afrique (Guinée / UEMOA)', category: 'aggregator', instant: true },
            { code: 'card_visa_uba', label: 'Carte Bancaire (Visa / Mastercard / UBA)', category: 'card', instant: true },
            { code: 'bank_transfer', label: 'Virement Bancaire (Validation Super-Admin)', category: 'manual', instant: false },
            { code: 'manual', label: 'Dépôt / Référence manuelle avec preuve', category: 'manual', instant: false },
          ],
        },
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 2. WEBHOOK SÉCURISÉ PRESTATAIRES DE PAIEMENT SAAS (SECTION 6)
// -------------------------------------------------------------
const webhookPayloadSchema = z.object({
  transactionRef: z.string().min(4),
  event: z.enum(['confirmed', 'failed', 'abandoned', 'refunded']),
  providerTransactionId: z.string().optional().nullable(),
  failureReason: z.string().optional().nullable(),
  amount: z.number().optional(),
});

subscriptionsRouter.post('/webhooks/:provider', async (req, res, next) => {
  try {
    const provider = String(req.params.provider || 'gateway').toLowerCase();
    const signatureHeader = String(req.headers['x-saas-signature'] || '').trim();
    const rawBody = JSON.stringify(req.body || {});
    const expectedSignature = computeSaasWebhookSignature(rawBody);

    if (
      !signatureHeader ||
      signatureHeader.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSignature))
    ) {
      res.status(401).json({
        error: {
          code: 'INVALID_WEBHOOK_SIGNATURE',
          message: 'Signature HMAC du webhook invalide ou non autorisée.',
        },
      });
      return;
    }

    const parsed = webhookPayloadSchema.parse(req.body);

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      const txRes = await client.query(
        `SELECT * FROM public.saas_subscription_transactions WHERE transaction_ref = $1 FOR UPDATE`,
        [parsed.transactionRef]
      );
      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({
          error: { code: 'TRANSACTION_NOT_FOUND', message: 'Transaction SaaS introuvable.' },
        });
        return;
      }

      const txRow = txRes.rows[0];

      if (parsed.event === 'confirmed') {
        const confirmed = await confirmSaasTransactionAndActivateSubscription(client, txRow, {
          providerTransactionId: parsed.providerTransactionId || `${provider.toUpperCase()}-${Date.now()}`,
          isWebhook: true,
        });
        await client.query('COMMIT');
        res.json({
          data: {
            alreadyConfirmed: confirmed.alreadyConfirmed,
            transaction: confirmed.transaction,
            subscription: confirmed.subscription,
            invoice: confirmed.invoice,
          },
        });
        return;
      }

      // Failed / abandoned / refunded
      if (txRow.status === 'confirmed' && parsed.event !== 'refunded') {
        await client.query('ROLLBACK');
        res.json({
          data: {
            alreadyConfirmed: true,
            message: 'Transaction déjà confirmée, événement d’échec ignoré.',
          },
        });
        return;
      }

      const updatedTxRes = await client.query(
        `UPDATE public.saas_subscription_transactions
         SET status = $2,
             failure_reason = COALESCE($3, failure_reason),
             webhook_verified = TRUE,
             webhook_confirmations_count = webhook_confirmations_count + 1,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [txRow.id, parsed.event, parsed.failureReason || `Paiement ${parsed.event} signalé par ${provider}`]
      );

      await client.query('COMMIT');
      res.json({
        data: {
          alreadyConfirmed: false,
          transaction: updatedTxRes.rows[0],
        },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Toutes les routes suivantes nécessitent une authentification
subscriptionsRouter.use(requireAuth);

// -------------------------------------------------------------
// 3. MON ABONNEMENT, HISTORIQUE TRANSACTIONS & FACTURES SAAS
// -------------------------------------------------------------
subscriptionsRouter.get('/current', async (req, res, next) => {
  try {
    const data = await withAdminTransaction(async (client) => {
      await ensureDefaultPlansAndMerchant(client);

      const plansRes = await client.query(
        `SELECT id, code, name, monthly_price, quarterly_price, semiannual_price, yearly_price,
                setup_fee, trial_days, max_users, max_locations, max_tables, max_products,
                currency, features, is_active
         FROM public.subscription_plans
         WHERE is_active = TRUE
         ORDER BY monthly_price ASC`
      );

      let subRes = await client.query(
        `SELECT cs.*, sp.code AS resolved_plan_code, sp.name AS plan_name, sp.monthly_price, sp.quarterly_price,
                sp.semiannual_price, sp.yearly_price, sp.setup_fee, sp.features,
                sp.max_users, sp.max_locations, sp.max_tables, sp.max_products
         FROM public.company_subscriptions cs
         LEFT JOIN public.subscription_plans sp ON sp.code = cs.plan_code OR sp.id = cs.plan_id
         WHERE cs.company_id = $1`,
        [req.auth!.companyId]
      );

      if (subRes.rows.length === 0) {
        const proPlan = plansRes.rows.find((p: any) => p.code === 'PRO') || plansRes.rows[0];
        await client.query(
          `INSERT INTO public.company_subscriptions (company_id, plan_id, plan_code, status, billing_period)
           VALUES ($1, $2, 'PRO', 'trial', 'monthly')
           ON CONFLICT (company_id) DO NOTHING`,
          [req.auth!.companyId, proPlan?.id || null]
        );
        subRes = await client.query(
          `SELECT cs.*, sp.code AS resolved_plan_code, sp.name AS plan_name, sp.monthly_price, sp.quarterly_price,
                  sp.semiannual_price, sp.yearly_price, sp.setup_fee, sp.features,
                  sp.max_users, sp.max_locations, sp.max_tables, sp.max_products
           FROM public.company_subscriptions cs
           LEFT JOIN public.subscription_plans sp ON sp.code = cs.plan_code OR sp.id = cs.plan_id
           WHERE cs.company_id = $1`,
          [req.auth!.companyId]
        );
      }

      const settingsRes = await client.query(
        `SELECT currency, country, whatsapp_phone, updated_at
         FROM public.company_settings
         WHERE company_id = $1`,
        [req.auth!.companyId]
      );

      const settings = settingsRes.rows[0] || {
        currency: 'XOF',
        country: 'SN',
        whatsapp_phone: null,
      };

      const transactionsRes = await client.query(
        `SELECT id, transaction_ref, plan_code, billing_period, currency,
                subscription_price_snapshot, setup_fee_snapshot, discount_amount,
                tax_amount, gross_amount, payment_provider, payment_method,
                payer_phone, manual_reference, status, failure_reason,
                period_start, period_end, created_at, confirmed_at
         FROM public.saas_subscription_transactions
         WHERE company_id = $1
         ORDER BY created_at DESC
         LIMIT 30`,
        [req.auth!.companyId]
      );

      const invoicesRes = await client.query(
        `SELECT id, invoice_number, plan_code, plan_name, billing_period,
                period_start, period_end, currency, subtotal_amount, setup_fee_amount,
                discount_amount, tax_amount, total_amount, payment_method,
                payment_reference, status, issued_at, paid_at
         FROM public.saas_invoices
         WHERE company_id = $1
         ORDER BY issued_at DESC
         LIMIT 30`,
        [req.auth!.companyId]
      );

      const merchRes = await client.query(
        `SELECT brand_name, support_email, support_phone, whatsapp_phone,
                active_provider, manual_payment_instructions,
                bank_name, bank_account_name, bank_iban,
                wave_merchant_number, orange_money_merchant_number, mtn_momo_merchant_number
         FROM public.saas_merchant_settings
         ORDER BY created_at ASC LIMIT 1`
      );

      const sub = subRes.rows[0];
      const now = new Date();
      const endDate = new Date(sub.current_period_end || sub.trial_ends_at);
      const daysRemaining = Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 3600 * 24)));

      return {
        subscription: {
          ...sub,
          daysRemaining,
          isExpired: endDate.getTime() < now.getTime() && !['active'].includes(sub.status),
        },
        plans: plansRes.rows,
        settings,
        transactions: transactionsRes.rows,
        invoices: invoicesRes.rows,
        merchantPaymentInfo: merchRes.rows[0] || null,
      };
    });

    res.json({ data });
  } catch (err) {
    next(err);
  }
});

const updateSettingsSchema = z.object({
  currency: z.enum(['XOF', 'GNF']),
  country: z.enum(['SN', 'GN']),
  whatsappPhone: z.string().max(40).optional().nullable(),
});

subscriptionsRouter.put('/settings', async (req, res, next) => {
  try {
    const parsed = updateSettingsSchema.parse(req.body);
    const updated = await withAdminTransaction(async (client) => {
      await client.query(
        `UPDATE public.companies SET currency = $2, updated_at = NOW() WHERE id = $1`,
        [req.auth!.companyId, parsed.currency]
      );

      const result = await client.query(
        `INSERT INTO public.company_settings (company_id, currency, country, whatsapp_phone, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (company_id) DO UPDATE
         SET currency = EXCLUDED.currency,
             country = EXCLUDED.country,
             whatsapp_phone = EXCLUDED.whatsapp_phone,
             updated_at = NOW()
         RETURNING currency, country, whatsapp_phone, updated_at`,
        [req.auth!.companyId, parsed.currency, parsed.country, parsed.whatsappPhone || null]
      );

      await client.query(
        `UPDATE public.qr_menu_settings
         SET currency = $2, updated_at = NOW()
         WHERE company_id = $1`,
        [req.auth!.companyId, parsed.currency]
      );

      return result.rows[0];
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

const updateCompanySettingsLegacySchema = z.object({
  name: z.string().min(2).max(200).optional(),
  currency: z.string().min(2).max(10),
  defaultTaxRate: z.number().min(0).max(100).optional(),
  allowNegativeStock: z.boolean().optional(),
});

subscriptionsRouter.put('/company-settings', async (req, res, next) => {
  try {
    const parsed = updateCompanySettingsLegacySchema.parse(req.body);
    const updated = await withAdminTransaction(async (client) => {
      const compRes = await client.query(
        `UPDATE public.companies
         SET name = COALESCE($2, name),
             currency = $3,
             default_tax_rate = COALESCE($4, default_tax_rate),
             allow_negative_stock = COALESCE($5, allow_negative_stock),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          req.auth!.companyId,
          parsed.name || null,
          parsed.currency,
          parsed.defaultTaxRate !== undefined ? parsed.defaultTaxRate : null,
          parsed.allowNegativeStock !== undefined ? parsed.allowNegativeStock : null,
        ]
      );

      const country = parsed.currency === 'GNF' ? 'GN' : 'SN';
      await client.query(
        `INSERT INTO public.company_settings (company_id, currency, country, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (company_id) DO UPDATE
         SET currency = EXCLUDED.currency, updated_at = NOW()`,
        [req.auth!.companyId, parsed.currency, country]
      );

      return compRes.rows[0];
    });
    res.json({ data: updated });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 4. PARCOURS DE SOUSCRIPTION EN 9 ÉTAPES & TRANSACTIONS SAAS
// -------------------------------------------------------------
const createSaasTransactionSchema = z.object({
  planCode: z.enum(['ESSENTIEL', 'PRO', 'ENTREPRISE']),
  billingPeriod: z.enum(['monthly', 'quarterly', 'semiannual', 'yearly']).default('monthly'),
  paymentMethod: z.enum([
    'wave',
    'orange_money',
    'mtn_momo',
    'paydunya',
    'paytech',
    'cinetpay',
    'card_visa_uba',
    'bank_transfer',
    'manual',
  ]),
  paymentMode: z.enum(['instant_gateway', 'pending_webhook', 'manual_proof']).optional(),
  payerPhone: z.string().max(40).optional().nullable(),
  payerName: z.string().max(120).optional().nullable(),
  manualReference: z.string().max(120).optional().nullable(),
  manualProofNote: z.string().max(500).optional().nullable(),
  promoCode: z.string().max(40).optional().nullable(),
});

subscriptionsRouter.post('/transactions', async (req, res, next) => {
  try {
    const parsed = createSaasTransactionSchema.parse(req.body);

    const result = await withAdminTransaction(async (client) => {
      await ensureDefaultPlansAndMerchant(client);

      const planRes = await client.query(
        `SELECT * FROM public.subscription_plans WHERE code = $1 AND is_active = TRUE`,
        [parsed.planCode]
      );
      if (planRes.rows.length === 0) {
        return { errorStatus: 404, errorCode: 'PLAN_NOT_FOUND', errorMessage: 'Formule d’abonnement introuvable.' };
      }
      const plan = planRes.rows[0];

      const settingsRes = await client.query(
        `SELECT currency FROM public.company_settings WHERE company_id = $1`,
        [req.auth!.companyId]
      );
      const currency = settingsRes.rows[0]?.currency || 'XOF';

      const subRes = await client.query(
        `SELECT * FROM public.company_subscriptions WHERE company_id = $1`,
        [req.auth!.companyId]
      );
      const currentSub = subRes.rows[0] || null;

      const { baseSubscriptionPrice, setupFee } = getPlanPriceForPeriod(plan, parsed.billingPeriod, currency);
      // Apply setup fee only if company has never had an active subscription on ENTREPRISE
      const effectiveSetupFee =
        currentSub && currentSub.status === 'active' && currentSub.plan_code === parsed.planCode ? 0 : setupFee;

      const discountAmount =
        parsed.promoCode && parsed.promoCode.trim().toUpperCase() === 'BIENVENUE10'
          ? Math.round(baseSubscriptionPrice * 0.1)
          : 0;
      const taxAmount = 0;
      const grossAmount = Math.max(0, baseSubscriptionPrice + effectiveSetupFee - discountAmount + taxAmount);

      const feeRate = computeProviderFeeRate(parsed.paymentMethod);
      const providerFeeAmount = Math.round(grossAmount * feeRate);
      const netExpectedAmount = Math.max(0, grossAmount - providerFeeAmount);

      const isManualMethod = ['bank_transfer', 'manual'].includes(parsed.paymentMethod);
      const effectiveMode =
        parsed.paymentMode || (isManualMethod ? 'manual_proof' : 'instant_gateway');

      if (effectiveMode === 'manual_proof' && (!parsed.manualReference || !parsed.manualReference.trim())) {
        return {
          errorStatus: 400,
          errorCode: 'MANUAL_REFERENCE_REQUIRED',
          errorMessage: 'Veuillez saisir la référence du virement ou du transfert pour validation.',
        };
      }

      const txRef = `TX-SAAS-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const providerName = ['paydunya', 'paytech', 'cinetpay'].includes(parsed.paymentMethod)
        ? parsed.paymentMethod
        : isManualMethod
          ? 'manual_verification'
          : `${parsed.paymentMethod}_direct`;

      const insTxRes = await client.query(
        `INSERT INTO public.saas_subscription_transactions (
           transaction_ref, company_id, subscription_id, plan_code, billing_period,
           currency, subscription_price_snapshot, setup_fee_snapshot, discount_amount,
           tax_amount, gross_amount, provider_fee_amount, net_expected_amount,
           payment_provider, payment_method, payer_phone, payer_name,
           manual_reference, manual_proof_note, status, created_by_user_id
         )
         VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13,
           $14, $15, $16, $17,
           $18, $19, 'pending', $20
         )
         RETURNING *`,
        [
          txRef,
          req.auth!.companyId,
          currentSub?.id || null,
          parsed.planCode,
          parsed.billingPeriod,
          currency,
          baseSubscriptionPrice,
          effectiveSetupFee,
          discountAmount,
          taxAmount,
          grossAmount,
          providerFeeAmount,
          netExpectedAmount,
          providerName,
          parsed.paymentMethod,
          parsed.payerPhone?.trim() || null,
          parsed.payerName?.trim() || null,
          parsed.manualReference?.trim() || null,
          parsed.manualProofNote?.trim() || null,
          req.auth!.userId,
        ]
      );
      const txRow = insTxRes.rows[0];

      // If instant_gateway, confirm immediately via our unified confirmation pipeline
      if (effectiveMode === 'instant_gateway') {
        const confirmed = await confirmSaasTransactionAndActivateSubscription(client, txRow, {
          providerTransactionId: `${providerName.toUpperCase()}-${Date.now()}`,
          confirmedByUserId: req.auth!.userId,
          isWebhook: false,
        });
        return {
          mode: 'confirmed',
          transaction: confirmed.transaction,
          subscription: confirmed.subscription,
          invoice: confirmed.invoice,
        };
      }

      // Otherwise keep transaction in 'pending' (awaiting webhook or Super-Admin manual approval)
      if (!currentSub || currentSub.status !== 'active') {
        await client.query(
          `INSERT INTO public.company_subscriptions (company_id, plan_code, status, billing_period)
           VALUES ($1, $2, 'pending_payment', $3)
           ON CONFLICT (company_id) DO UPDATE
           SET status = CASE WHEN public.company_subscriptions.status = 'active' THEN 'active' ELSE 'pending_payment' END,
               updated_at = NOW()`,
          [req.auth!.companyId, parsed.planCode, parsed.billingPeriod]
        );
      }

      return {
        mode: effectiveMode,
        transaction: txRow,
        subscription: currentSub,
        invoice: null,
      };
    });

    if ('errorStatus' in result && result.errorStatus) {
      res.status(result.errorStatus).json({
        error: { code: result.errorCode, message: result.errorMessage },
      });
      return;
    }

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 5. COMPATIBILITÉ CHECKOUT V1.1 (AVEC TRAÇABILITÉ SAAS V1.2)
// -------------------------------------------------------------
const checkoutSchema = z.object({
  planCode: z.enum(['ESSENTIEL', 'PRO', 'ENTREPRISE']).optional(),
  planId: z.string().uuid().optional(),
  billingPeriod: z.enum(['monthly', 'quarterly', 'semiannual', 'yearly']),
  paymentMethod: z.enum([
    'wave',
    'orange_money',
    'mtn_momo',
    'paydunya',
    'paytech',
    'cinetpay',
    'card_visa_uba',
    'bank_transfer',
    'manual',
  ]),
  paymentPhone: z.string().max(40).optional().nullable(),
  payerReference: z.string().max(80).optional().nullable(),
});

subscriptionsRouter.post('/checkout', async (req, res, next) => {
  try {
    const parsed = checkoutSchema.parse(req.body);
    const result = await withAdminTransaction(async (client) => {
      await ensureDefaultPlansAndMerchant(client);

      const planRes = parsed.planId
        ? await client.query(`SELECT * FROM public.subscription_plans WHERE id = $1 AND is_active = TRUE`, [parsed.planId])
        : await client.query(`SELECT * FROM public.subscription_plans WHERE code = $1 AND is_active = TRUE`, [parsed.planCode || 'PRO']);

      if (planRes.rows.length === 0) {
        return null;
      }
      const plan = planRes.rows[0];
      const effectivePlanCode = plan.code || parsed.planCode || 'PRO';

      const settingsRes = await client.query(
        `SELECT currency FROM public.company_settings WHERE company_id = $1`,
        [req.auth!.companyId]
      );
      const currency = settingsRes.rows[0]?.currency || 'XOF';

      const { baseSubscriptionPrice, setupFee } = getPlanPriceForPeriod(plan, parsed.billingPeriod, currency);
      const grossAmount = baseSubscriptionPrice + setupFee;
      const feeRate = computeProviderFeeRate(parsed.paymentMethod);
      const providerFeeAmount = Math.round(grossAmount * feeRate);
      const netExpectedAmount = Math.max(0, grossAmount - providerFeeAmount);

      const paymentRef = `LIC-RG-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const insTxRes = await client.query(
        `INSERT INTO public.saas_subscription_transactions (
           transaction_ref, company_id, plan_code, billing_period,
           currency, subscription_price_snapshot, setup_fee_snapshot,
           discount_amount, tax_amount, gross_amount, provider_fee_amount, net_expected_amount,
           payment_provider, payment_method, payer_phone, status, created_by_user_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9, $10, $11, $12, $13, 'pending', $14)
         RETURNING *`,
        [
          paymentRef,
          req.auth!.companyId,
          effectivePlanCode,
          parsed.billingPeriod,
          currency,
          baseSubscriptionPrice,
          setupFee,
          grossAmount,
          providerFeeAmount,
          netExpectedAmount,
          parsed.paymentMethod,
          parsed.paymentMethod,
          parsed.paymentPhone || parsed.payerReference || null,
          req.auth!.userId,
        ]
      );

      const confirmed = await confirmSaasTransactionAndActivateSubscription(client, insTxRes.rows[0], {
        providerTransactionId: `DIRECT-${paymentRef}`,
        confirmedByUserId: req.auth!.userId,
        isWebhook: false,
      });

      return {
        ...confirmed.subscription,
        subscription: confirmed.subscription,
        licenseReference: paymentRef,
        plan_name: plan.name,
        currency,
        invoice_number: confirmed.invoice?.invoice_number || null,
        transaction_id: confirmed.transaction?.id || null,
      };
    });

    if (!result) {
      res.status(404).json({ error: { code: 'PLAN_NOT_FOUND', message: 'Plan introuvable' } });
      return;
    }

    res.status(201).json({ data: result });
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 6. CONSULTATION D'UNE FACTURE D'ABONNEMENT SAAS
// -------------------------------------------------------------
subscriptionsRouter.get('/invoices/:id', async (req, res, next) => {
  try {
    const invoiceId = req.params.id;
    const client = await adminPool.connect();
    try {
      const invRes = await client.query(
        `SELECT si.*
         FROM public.saas_invoices si
         WHERE si.id = $1`,
        [invoiceId]
      );
      if (invRes.rows.length === 0) {
        res.status(404).json({ error: { code: 'INVOICE_NOT_FOUND', message: 'Facture SaaS introuvable.' } });
        return;
      }
      const invoice = invRes.rows[0];
      const roleUpper = String(req.auth?.role || '').toUpperCase();
      const isSuperOrOwner = ['SUPER_ADMIN', 'OWNER', 'ADMIN'].includes(roleUpper);
      if (invoice.company_id !== req.auth?.companyId && !isSuperOrOwner) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Accès refusé à cette facture.' } });
        return;
      }

      const merchRes = await client.query(
        `SELECT legal_name, brand_name, support_email, support_phone, whatsapp_phone, address, tax_id
         FROM public.saas_merchant_settings
         ORDER BY created_at ASC LIMIT 1`
      );

      res.json({
        data: {
          invoice,
          merchant: merchRes.rows[0] || null,
        },
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// -------------------------------------------------------------
// 7. SUPER-ADMIN : ESPACE « FINANCES RESTOGEST » (SECTIONS 8, 9, 10)
// -------------------------------------------------------------
function ensurePlatformAdminAccess(req: any, res: any): boolean {
  const roleUpper = String(req.auth?.role || '').toUpperCase();
  if (!req.auth || !['SUPER_ADMIN', 'OWNER', 'ADMIN'].includes(roleUpper)) {
    res.status(403).json({
      error: {
        code: 'SUPER_ADMIN_REQUIRED',
        message: 'Seul le propriétaire / Super-Administrateur peut accéder à Finances RESTOGEST.',
      },
    });
    return false;
  }
  return true;
}

subscriptionsRouter.get('/admin/overview', async (req, res, next) => {
  try {
    if (!ensurePlatformAdminAccess(req, res)) return;

    const period = String(req.query.period || 'all');
    const statusFilter = req.query.status ? String(req.query.status) : null;
    const methodFilter = req.query.paymentMethod ? String(req.query.paymentMethod) : null;

    const client = await adminPool.connect();
    try {
      await ensureDefaultPlansAndMerchant(client);

      let dateCondition = '';
      if (period === 'today') {
        dateCondition = `AND tx.created_at >= CURRENT_DATE`;
      } else if (period === 'week') {
        dateCondition = `AND tx.created_at >= NOW() - INTERVAL '7 days'`;
      } else if (period === 'month') {
        dateCondition = `AND tx.created_at >= DATE_TRUNC('month', NOW())`;
      } else if (period === 'year') {
        dateCondition = `AND tx.created_at >= DATE_TRUNC('year', NOW())`;
      }

      const kpiRes = await client.query(
        `SELECT
           COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS confirmed_gross_revenue,
           COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status IN ('pending', 'initiated')), 0) AS pending_amount,
           COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status IN ('failed', 'abandoned')), 0) AS failed_amount,
           COALESCE(SUM(tx.provider_fee_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS total_provider_fees,
           COALESCE(SUM(tx.net_expected_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS net_expected_revenue,
           COUNT(tx.id) FILTER (WHERE tx.status = 'confirmed')::INT AS confirmed_count,
           COUNT(tx.id) FILTER (WHERE tx.status IN ('pending', 'initiated'))::INT AS pending_count,
           COUNT(tx.id) FILTER (WHERE tx.status IN ('failed', 'abandoned'))::INT AS failed_count
         FROM public.saas_subscription_transactions tx
         WHERE 1=1 ${dateCondition}`
      );
      const kpiRow = kpiRes.rows[0] || {};

      const payoutsAggRes = await client.query(
        `SELECT
           COALESCE(SUM(net_settled_amount) FILTER (WHERE status = 'settled'), 0) AS settled_payouts_total,
           COALESCE(SUM(net_settled_amount) FILTER (WHERE status IN ('pending', 'in_transit')), 0) AS in_transit_payouts_total
         FROM public.saas_payouts`
      );
      const payoutsAgg = payoutsAggRes.rows[0] || {};

      const subsStatsRes = await client.query(
        `SELECT
           COUNT(cs.id) FILTER (WHERE cs.status = 'active')::INT AS active_subscriptions_count,
           COUNT(cs.id) FILTER (WHERE cs.status = 'trial')::INT AS trial_subscriptions_count,
           COUNT(cs.id) FILTER (WHERE cs.status = 'pending_payment')::INT AS pending_payment_count,
           COUNT(cs.id) FILTER (
             WHERE cs.status = 'active'
               AND cs.current_period_end <= NOW() + INTERVAL '7 days'
               AND cs.current_period_end >= NOW()
           )::INT AS expiring_soon_count,
           COUNT(cs.id) FILTER (
             WHERE cs.status IN ('expired', 'suspended', 'past_due', 'cancelled')
           )::INT AS expired_or_suspended_count,
           COALESCE(SUM(
             CASE
               WHEN cs.status = 'active' AND cs.billing_period = 'monthly' THEN sp.monthly_price
               WHEN cs.status = 'active' AND cs.billing_period = 'quarterly' THEN ROUND(sp.quarterly_price / 3.0, 2)
               WHEN cs.status = 'active' AND cs.billing_period = 'semiannual' THEN ROUND(sp.semiannual_price / 6.0, 2)
               WHEN cs.status = 'active' AND cs.billing_period = 'yearly' THEN ROUND(sp.yearly_price / 12.0, 2)
               ELSE 0
             END
           ), 0) AS estimated_mrr
         FROM public.company_subscriptions cs
         LEFT JOIN public.subscription_plans sp ON sp.code = cs.plan_code`
      );
      const subsStats = subsStatsRes.rows[0] || {};

      const byMethodRes = await client.query(
        `SELECT payment_method,
                COUNT(*)::INT AS count,
                COALESCE(SUM(gross_amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_amount,
                COALESCE(SUM(net_expected_amount) FILTER (WHERE status = 'confirmed'), 0) AS net_amount
         FROM public.saas_subscription_transactions tx
         WHERE 1=1 ${dateCondition}
         GROUP BY payment_method
         ORDER BY confirmed_amount DESC`
      );

      const byPlanRes = await client.query(
        `SELECT plan_code,
                COUNT(*)::INT AS count,
                COALESCE(SUM(gross_amount) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_amount
         FROM public.saas_subscription_transactions tx
         WHERE 1=1 ${dateCondition}
         GROUP BY plan_code
         ORDER BY confirmed_amount DESC`
      );

      const txParams: any[] = [];
      const txWhere: string[] = ['1=1'];
      if (statusFilter) {
        txParams.push(statusFilter);
        txWhere.push(`tx.status = $${txParams.length}`);
      }
      if (methodFilter) {
        txParams.push(methodFilter);
        txWhere.push(`tx.payment_method = $${txParams.length}`);
      }

      const transactionsRes = await client.query(
        `SELECT tx.*, c.name AS company_name
         FROM public.saas_subscription_transactions tx
         JOIN public.companies c ON c.id = tx.company_id
         WHERE ${txWhere.join(' AND ')}
         ORDER BY tx.created_at DESC
         LIMIT 100`,
        txParams
      );

      const subscriptionsRes = await client.query(
        `SELECT cs.*, c.name AS company_name,
                sp.name AS plan_name, sp.monthly_price
         FROM public.company_subscriptions cs
         JOIN public.companies c ON c.id = cs.company_id
         LEFT JOIN public.subscription_plans sp ON sp.code = cs.plan_code OR sp.id = cs.plan_id
         ORDER BY cs.updated_at DESC`
      );

      const invoicesRes = await client.query(
        `SELECT si.*
         FROM public.saas_invoices si
         ORDER BY si.issued_at DESC
         LIMIT 100`
      );

      const payoutsRes = await client.query(
        `SELECT sp.*
         FROM public.saas_payouts sp
         ORDER BY sp.created_at DESC
         LIMIT 50`
      );

      const plansRes = await client.query(
        `SELECT * FROM public.subscription_plans ORDER BY monthly_price ASC`
      );

      const merchRes = await client.query(
        `SELECT * FROM public.saas_merchant_settings ORDER BY created_at ASC LIMIT 1`
      );

      const netExpectedRevenue = Number(kpiRow.net_expected_revenue || 0);
      const settledPayoutsTotal = Number(payoutsAgg.settled_payouts_total || 0);
      const unsettledBalance = Math.max(0, netExpectedRevenue - settledPayoutsTotal);
      const mrr = Number(subsStats.estimated_mrr || 0);

      res.json({
        data: {
          kpis: {
            confirmedGrossRevenue: Number(kpiRow.confirmed_gross_revenue || 0),
            pendingAmount: Number(kpiRow.pending_amount || 0),
            failedAmount: Number(kpiRow.failed_amount || 0),
            totalProviderFees: Number(kpiRow.total_provider_fees || 0),
            netExpectedRevenue,
            settledPayoutsTotal,
            inTransitPayoutsTotal: Number(payoutsAgg.in_transit_payouts_total || 0),
            unsettledBalance,
            confirmedCount: Number(kpiRow.confirmed_count || 0),
            pendingCount: Number(kpiRow.pending_count || 0),
            failedCount: Number(kpiRow.failed_count || 0),
            mrr,
            arr: Math.round(mrr * 12),
            activeSubscriptionsCount: Number(subsStats.active_subscriptions_count || 0),
            trialSubscriptionsCount: Number(subsStats.trial_subscriptions_count || 0),
            pendingPaymentCount: Number(subsStats.pending_payment_count || 0),
            expiringSoonCount: Number(subsStats.expiring_soon_count || 0),
            expiredOrSuspendedCount: Number(subsStats.expired_or_suspended_count || 0),
          },
          revenueByMethod: byMethodRes.rows,
          revenueByPlan: byPlanRes.rows,
          transactions: transactionsRes.rows,
          subscriptions: subscriptionsRes.rows,
          invoices: invoicesRes.rows,
          payouts: payoutsRes.rows,
          plans: plansRes.rows,
          merchantSettings: merchRes.rows[0] || null,
        },
      });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

const updateMerchantSettingsSchema = z.object({
  legalName: z.string().min(2).max(160).optional(),
  brandName: z.string().min(2).max(120).optional(),
  supportEmail: z.string().max(160).optional().nullable(),
  supportPhone: z.string().max(50).optional().nullable(),
  whatsappPhone: z.string().max(50).optional().nullable(),
  address: z.string().max(250).optional().nullable(),
  taxId: z.string().max(100).optional().nullable(),
  defaultCurrency: z.enum(['XOF', 'GNF']).optional(),
  activeProvider: z.string().max(50).optional(),
  manualPaymentInstructions: z.string().max(1000).optional(),
  bankName: z.string().max(120).optional().nullable(),
  bankAccountName: z.string().max(120).optional().nullable(),
  bankIban: z.string().max(120).optional().nullable(),
  waveMerchantNumber: z.string().max(60).optional().nullable(),
  orangeMoneyMerchantNumber: z.string().max(60).optional().nullable(),
  mtnMomoMerchantNumber: z.string().max(60).optional().nullable(),
});

subscriptionsRouter.put('/admin/merchant-settings', async (req, res, next) => {
  try {
    if (!ensurePlatformAdminAccess(req, res)) return;
    const parsed = updateMerchantSettingsSchema.parse(req.body);

    const client = await adminPool.connect();
    try {
      await ensureDefaultPlansAndMerchant(client);
      const currRes = await client.query(`SELECT * FROM public.saas_merchant_settings ORDER BY created_at ASC LIMIT 1`);
      const curr = currRes.rows[0];

      const updRes = await client.query(
        `UPDATE public.saas_merchant_settings
         SET legal_name = $2,
             brand_name = $3,
             support_email = $4,
             support_phone = $5,
             whatsapp_phone = $6,
             address = $7,
             tax_id = $8,
             default_currency = $9,
             active_provider = $10,
             manual_payment_instructions = $11,
             bank_name = $12,
             bank_account_name = $13,
             bank_iban = $14,
             wave_merchant_number = $15,
             orange_money_merchant_number = $16,
             mtn_momo_merchant_number = $17,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          curr.id,
          parsed.legalName ?? curr.legal_name,
          parsed.brandName ?? curr.brand_name,
          parsed.supportEmail !== undefined ? parsed.supportEmail : curr.support_email,
          parsed.supportPhone !== undefined ? parsed.supportPhone : curr.support_phone,
          parsed.whatsappPhone !== undefined ? parsed.whatsappPhone : curr.whatsapp_phone,
          parsed.address !== undefined ? parsed.address : curr.address,
          parsed.taxId !== undefined ? parsed.taxId : curr.tax_id,
          parsed.defaultCurrency ?? curr.default_currency,
          parsed.activeProvider ?? curr.active_provider,
          parsed.manualPaymentInstructions ?? curr.manual_payment_instructions,
          parsed.bankName !== undefined ? parsed.bankName : curr.bank_name,
          parsed.bankAccountName !== undefined ? parsed.bankAccountName : curr.bank_account_name,
          parsed.bankIban !== undefined ? parsed.bankIban : curr.bank_iban,
          parsed.waveMerchantNumber !== undefined ? parsed.waveMerchantNumber : curr.wave_merchant_number,
          parsed.orangeMoneyMerchantNumber !== undefined ? parsed.orangeMoneyMerchantNumber : curr.orange_money_merchant_number,
          parsed.mtnMomoMerchantNumber !== undefined ? parsed.mtnMomoMerchantNumber : curr.mtn_momo_merchant_number,
        ]
      );
      res.json({ data: updRes.rows[0] });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Approbation manuelle d'une transaction en attente par le Super-Admin
subscriptionsRouter.post('/admin/transactions/:id/confirm', async (req, res, next) => {
  try {
    if (!ensurePlatformAdminAccess(req, res)) return;
    const txId = req.params.id;
    const note = String(req.body?.note || 'Validation manuelle par Super-Admin').trim();

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      const txRes = await client.query(
        `SELECT * FROM public.saas_subscription_transactions WHERE id = $1 FOR UPDATE`,
        [txId]
      );
      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: { code: 'TRANSACTION_NOT_FOUND', message: 'Transaction introuvable.' } });
        return;
      }

      const confirmed = await confirmSaasTransactionAndActivateSubscription(client, txRes.rows[0], {
        providerTransactionId: `ADMIN-VALIDATED-${Date.now()}`,
        confirmedByUserId: req.auth!.userId,
        isWebhook: false,
      });

      await client.query(
        `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
         VALUES ($1, $2, 'SAAS_TRANSACTION_MANUALLY_CONFIRMED', 'saas_subscription_transactions', $3, $4::jsonb)`,
        [
          txRes.rows[0].company_id,
          req.auth!.userId,
          txRes.rows[0].id,
          JSON.stringify({ note, transactionRef: txRes.rows[0].transaction_ref }),
        ]
      );

      await client.query('COMMIT');
      res.json({ data: confirmed });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.post('/admin/transactions/:id/reject', async (req, res, next) => {
  try {
    if (!ensurePlatformAdminAccess(req, res)) return;
    const txId = req.params.id;
    const reason = String(req.body?.reason || 'Preuve de paiement non conforme').trim();

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      const txRes = await client.query(
        `SELECT * FROM public.saas_subscription_transactions WHERE id = $1 FOR UPDATE`,
        [txId]
      );
      if (txRes.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: { code: 'TRANSACTION_NOT_FOUND', message: 'Transaction introuvable.' } });
        return;
      }
      if (txRes.rows[0].status === 'confirmed') {
        await client.query('ROLLBACK');
        res.status(409).json({
          error: { code: 'ALREADY_CONFIRMED', message: 'Une transaction déjà confirmée ne peut pas être rejetée.' },
        });
        return;
      }

      const updRes = await client.query(
        `UPDATE public.saas_subscription_transactions
         SET status = 'failed', failure_reason = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [txId, reason]
      );

      await client.query(
        `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
         VALUES ($1, $2, 'SAAS_TRANSACTION_REJECTED', 'saas_subscription_transactions', $3, $4::jsonb)`,
        [txRes.rows[0].company_id, req.auth!.userId, txId, JSON.stringify({ reason })]
      );

      await client.query('COMMIT');
      res.json({ data: updRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Gestion du cycle de vie & prolongation exceptionnelle avec motif obligatoire (Section 9)
const adminSubscriptionStatusSchema = z.object({
  status: z
    .enum(['trial', 'active', 'pending_payment', 'past_due', 'suspended', 'cancelled', 'expired'])
    .optional(),
  extendDays: z.number().int().min(1).max(365).optional(),
  reason: z.string().min(4, 'Un motif explicite est obligatoire pour toute action administrative.'),
});

subscriptionsRouter.post('/admin/subscriptions/:id/status', async (req, res, next) => {
  try {
    if (!ensurePlatformAdminAccess(req, res)) return;
    const subId = req.params.id;
    const parsed = adminSubscriptionStatusSchema.parse(req.body);

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');
      const subRes = await client.query(
        `SELECT * FROM public.company_subscriptions WHERE id = $1 FOR UPDATE`,
        [subId]
      );
      if (subRes.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Abonnement introuvable.' } });
        return;
      }
      const sub = subRes.rows[0];
      const nextStatus = parsed.status || sub.status;

      let nextPeriodEnd = new Date(sub.current_period_end || Date.now());
      if (parsed.extendDays && parsed.extendDays > 0) {
        const baseTime = Math.max(Date.now(), nextPeriodEnd.getTime());
        nextPeriodEnd = new Date(baseTime + parsed.extendDays * 24 * 3600 * 1000);
      }

      const updRes = await client.query(
        `UPDATE public.company_subscriptions
         SET status = $2,
             current_period_end = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [subId, nextStatus, nextPeriodEnd.toISOString()]
      );

      await client.query(
        `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
         VALUES ($1, $2, 'SAAS_SUBSCRIPTION_ADMIN_OVERRIDE', 'company_subscriptions', $3, $4::jsonb)`,
        [
          sub.company_id,
          req.auth!.userId,
          subId,
          JSON.stringify({
            previousStatus: sub.status,
            newStatus: nextStatus,
            extendDays: parsed.extendDays || 0,
            reason: parsed.reason,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({ data: updRes.rows[0] });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Enregistrement d'un reversement / payout vers le compte du propriétaire RESTOGEST
const createPayoutSchema = z.object({
  paymentProvider: z.string().min(2).max(50),
  destinationAccount: z.string().min(3).max(160),
  currency: z.enum(['XOF', 'GNF']).default('XOF'),
  grossCollectedAmount: z.number().min(1),
  providerFeesAmount: z.number().min(0).default(0),
  status: z.enum(['pending', 'in_transit', 'settled']).default('settled'),
  notes: z.string().max(400).optional().nullable(),
});

subscriptionsRouter.post('/admin/payouts', async (req, res, next) => {
  try {
    if (!ensurePlatformAdminAccess(req, res)) return;
    const parsed = createPayoutSchema.parse(req.body);
    const netSettled = Math.max(0, parsed.grossCollectedAmount - parsed.providerFeesAmount);
    const payoutRef = `PAYOUT-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const client = await adminPool.connect();
    try {
      const settledAtIso = parsed.status === 'settled' ? new Date().toISOString() : null;
      const insRes = await client.query(
        `INSERT INTO public.saas_payouts (
           payout_ref, payment_provider, destination_account, currency,
           gross_collected_amount, provider_fees_amount, net_settled_amount,
           status, settled_at, notes, recorded_by_user_id
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          payoutRef,
          parsed.paymentProvider,
          parsed.destinationAccount,
          parsed.currency,
          parsed.grossCollectedAmount,
          parsed.providerFeesAmount,
          netSettled,
          parsed.status,
          settledAtIso,
          parsed.notes || null,
          req.auth!.userId,
        ]
      );
      res.status(201).json({ data: insRes.rows[0] });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});

// Mise à jour d'un plan d'abonnement par le Super-Admin
const updatePlanSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  monthlyPrice: z.number().min(0).optional(),
  quarterlyPrice: z.number().min(0).optional(),
  semiannualPrice: z.number().min(0).optional(),
  yearlyPrice: z.number().min(0).optional(),
  setupFee: z.number().min(0).optional(),
  trialDays: z.number().int().min(0).max(90).optional(),
  maxUsers: z.number().int().min(1).optional(),
  maxLocations: z.number().int().min(1).optional(),
  maxTables: z.number().int().min(1).optional(),
  maxProducts: z.number().int().min(1).optional(),
  isActive: z.boolean().optional(),
});

subscriptionsRouter.put('/admin/plans/:code', async (req, res, next) => {
  try {
    if (!ensurePlatformAdminAccess(req, res)) return;
    const planCode = String(req.params.code || '').toUpperCase();
    const parsed = updatePlanSchema.parse(req.body);

    const client = await adminPool.connect();
    try {
      const currRes = await client.query(`SELECT * FROM public.subscription_plans WHERE code = $1`, [planCode]);
      if (currRes.rows.length === 0) {
        res.status(404).json({ error: { code: 'PLAN_NOT_FOUND', message: 'Plan introuvable.' } });
        return;
      }
      const curr = currRes.rows[0];
      const updRes = await client.query(
        `UPDATE public.subscription_plans
         SET name = $2,
             monthly_price = $3,
             quarterly_price = $4,
             semiannual_price = $5,
             yearly_price = $6,
             setup_fee = $7,
             trial_days = $8,
             max_users = $9,
             max_locations = $10,
             max_tables = $11,
             max_products = $12,
             is_active = $13
         WHERE code = $1
         RETURNING *`,
        [
          planCode,
          parsed.name ?? curr.name,
          parsed.monthlyPrice ?? Number(curr.monthly_price),
          parsed.quarterlyPrice ?? Number(curr.quarterly_price),
          parsed.semiannualPrice ?? Number(curr.semiannual_price),
          parsed.yearlyPrice ?? Number(curr.yearly_price),
          parsed.setupFee ?? Number(curr.setup_fee),
          parsed.trialDays ?? Number(curr.trial_days),
          parsed.maxUsers ?? Number(curr.max_users),
          parsed.maxLocations ?? Number(curr.max_locations),
          parsed.maxTables ?? Number(curr.max_tables),
          parsed.maxProducts ?? Number(curr.max_products),
          parsed.isActive !== undefined ? parsed.isActive : curr.is_active,
        ]
      );
      res.json({ data: updRes.rows[0] });
    } finally {
      client.release();
    }
  } catch (err) {
    next(err);
  }
});
