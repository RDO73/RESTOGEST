import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../../middlewares/auth-middleware.js';
import { adminPool, ensureDatabaseReady } from '../../db/pool.js';
import { withTenantContext } from '../../db/tenant-context.js';
import { ensureSessionHydrated } from '../../db/demo-seed.js';

export const subscriptionsRouter = Router();

subscriptionsRouter.use(requireAuth);

const DEFAULT_PLANS = [
  {
    name: 'Essentiel POS',
    description: 'Caisse POS tactile, gestion des stocks et clôture Z de caisse (1 poste)',
    monthlyPrice: 15000,
    yearlyPrice: 150000,
    features: {
      gnf_monthly: 225000,
      gnf_yearly: 2250000,
      max_registers: 1,
      whatsapp: true,
      floor_plan: false,
      highlights: [
        'Caisse POS tactile illimitée',
        'Gestion des stocks & alertes ruptures',
        'Rapport Z de caisse exportable',
        'Support standard WhatsApp',
      ],
    },
  },
  {
    name: 'Pro Cloud Restaurant',
    description: 'Plan de salle interactif, fiches recettes anti-coulage, livraison WhatsApp & multi-postes',
    monthlyPrice: 29000,
    yearlyPrice: 290000,
    features: {
      gnf_monthly: 435000,
      gnf_yearly: 4350000,
      max_registers: 5,
      whatsapp: true,
      floor_plan: true,
      recommended: true,
      highlights: [
        'Plan de salle visuel (Tables, Terrasse, Comptoir)',
        'Livraison & Récap automatique WhatsApp',
        'Fiches recettes anti-coulage & coût PMP',
        'Paiements Wave, Orange Money & Carte',
      ],
    },
  },
  {
    name: 'Entreprise Multi-Sites',
    description: 'Multi-établissements, traçabilité complète et accompagnement VIP 24/7 Sénégal & Guinée',
    monthlyPrice: 59000,
    yearlyPrice: 590000,
    features: {
      gnf_monthly: 885000,
      gnf_yearly: 8850000,
      max_registers: 99,
      whatsapp: true,
      floor_plan: true,
      vip_support: true,
      highlights: [
        'Postes et serveurs illimités',
        'Journal d\'audit bancaire & contrôle coûts',
        'Onboarding équipe sur site / visio',
        'Assistance prioritaire 7j/7 Dakar & Conakry',
      ],
    },
  },
];

async function ensureDefaultPlans(): Promise<void> {
  for (const plan of DEFAULT_PLANS) {
    await adminPool.query(
      `INSERT INTO public.subscription_plans (name, description, monthly_price, yearly_price, features, is_active)
       VALUES ($1, $2, $3, $4, $5::jsonb, TRUE)
       ON CONFLICT (name) DO NOTHING`,
      [
        plan.name,
        plan.description,
        plan.monthlyPrice,
        plan.yearlyPrice,
        JSON.stringify(plan.features),
      ]
    );
  }
}

// -------------------------------------------------------------
// 1. STATUT DE L'ABONNEMENT, PLANS TARIFAIRES & PARAMÈTRES ENTREPRISE
// -------------------------------------------------------------
subscriptionsRouter.get('/current', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    await ensureSessionHydrated(req.auth!);
    await ensureDefaultPlans();

    const data = await withTenantContext(req.auth!, async (client) => {
      const plansRes = await client.query(
        `SELECT id, name, description, monthly_price, yearly_price, features, is_active
         FROM public.subscription_plans
         WHERE is_active = TRUE
         ORDER BY monthly_price ASC`
      );

      const subRes = await client.query(
        `SELECT cs.*, sp.name AS plan_name, sp.description AS plan_description,
                sp.monthly_price, sp.yearly_price, sp.features AS plan_features
         FROM public.company_subscriptions cs
         JOIN public.subscription_plans sp ON sp.id = cs.plan_id
         WHERE cs.company_id = $1
         ORDER BY cs.created_at DESC
         LIMIT 1`,
        [req.auth!.companyId]
      );

      const compRes = await client.query(
        `SELECT id, name, business_type, currency, default_tax_rate, allow_negative_stock
         FROM public.companies
         WHERE id = $1`,
        [req.auth!.companyId]
      );

      return {
        plans: plansRes.rows,
        subscription: subRes.rows[0] || null,
        company: compRes.rows[0] || null,
      };
    });

    // Créer automatiquement un essai gratuit de 14 jours s'il n'existe aucun abonnement
    if (!data.subscription && data.plans.length > 0) {
      const defaultPlan =
        data.plans.find((p: any) => p.name === 'Pro Cloud Restaurant') || data.plans[0];

      await adminPool.query(
        `INSERT INTO public.company_subscriptions (company_id, plan_id, billing_period, status, starts_at, ends_at)
         VALUES ($1, $2, 'monthly', 'trial', NOW(), NOW() + INTERVAL '14 days')`,
        [req.auth!.companyId, defaultPlan.id]
      );

      const refreshedSub = await adminPool.query(
        `SELECT cs.*, sp.name AS plan_name, sp.description AS plan_description,
                sp.monthly_price, sp.yearly_price, sp.features AS plan_features
         FROM public.company_subscriptions cs
         JOIN public.subscription_plans sp ON sp.id = cs.plan_id
         WHERE cs.company_id = $1
         ORDER BY cs.created_at DESC
         LIMIT 1`,
        [req.auth!.companyId]
      );
      data.subscription = refreshedSub.rows[0] || null;
    }

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 2. SOUSCRIPTION / RENOUVELLEMENT SAAS (WAVE / ORANGE MONEY / CARTE)
// -------------------------------------------------------------
subscriptionsRouter.post('/checkout', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    await ensureSessionHydrated(req.auth!);
    await ensureDefaultPlans();

    const schema = z.object({
      planId: z.string().uuid(),
      billingPeriod: z.enum(['monthly', 'yearly']),
      paymentMethod: z.enum(['wave', 'orange_money', 'card_visa_uba']),
      payerReference: z.string().max(120).optional(),
    });
    const data = schema.parse(req.body);

    const planRes = await adminPool.query(
      `SELECT id, name, description, monthly_price, yearly_price, features
       FROM public.subscription_plans
       WHERE id = $1 AND is_active = TRUE`,
      [data.planId]
    );
    if (planRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Plan tarifaire introuvable' });
      return;
    }
    const plan = planRes.rows[0];

    const client = await adminPool.connect();
    let activated: any;
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE public.company_subscriptions
         SET status = 'cancelled'
         WHERE company_id = $1 AND status IN ('trial', 'active', 'past_due')`,
        [req.auth!.companyId]
      );

      const intervalSql = data.billingPeriod === 'yearly' ? "INTERVAL '1 year'" : "INTERVAL '1 month'";
      const insRes = await client.query(
        `INSERT INTO public.company_subscriptions (company_id, plan_id, billing_period, status, starts_at, ends_at)
         VALUES ($1, $2, $3, 'active', NOW(), NOW() + ${intervalSql})
         RETURNING *`,
        [req.auth!.companyId, data.planId, data.billingPeriod]
      );
      activated = insRes.rows[0];
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const licenseReference = `LIC-RG-${Date.now().toString().slice(-6)}`;

    res.status(201).json({
      success: true,
      message: `Licence ${plan.name} activée avec succès`,
      data: {
        subscription: {
          ...activated,
          plan_name: plan.name,
          plan_description: plan.description,
          monthly_price: plan.monthly_price,
          yearly_price: plan.yearly_price,
          plan_features: plan.features,
        },
        paymentMethod: data.paymentMethod,
        payerReference: data.payerReference || null,
        licenseReference,
      },
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 3. PARAMÈTRES ÉTABLISSEMENT & MULTI-DEVISES (XOF / GNF)
// -------------------------------------------------------------
subscriptionsRouter.put('/company-settings', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    await ensureSessionHydrated(req.auth!);

    const schema = z.object({
      name: z.string().min(2).max(255).optional(),
      currency: z.enum(['XOF', 'GNF', 'EUR', 'USD', 'MAD', 'CAD']).optional(),
      defaultTaxRate: z.number().min(0).max(100).optional(),
      allowNegativeStock: z.boolean().optional(),
    });
    const data = schema.parse(req.body);

    const updRes = await adminPool.query(
      `UPDATE public.companies
       SET name = COALESCE($1, name),
           currency = COALESCE($2, currency),
           default_tax_rate = COALESCE($3, default_tax_rate),
           allow_negative_stock = COALESCE($4, allow_negative_stock),
           updated_at = NOW()
       WHERE id = $5
       RETURNING id, name, business_type, currency, default_tax_rate, allow_negative_stock`,
      [
        data.name ?? null,
        data.currency ?? null,
        data.defaultTaxRate ?? null,
        typeof data.allowNegativeStock === 'boolean' ? data.allowNegativeStock : null,
        req.auth!.companyId,
      ]
    );

    if (updRes.rows.length === 0) {
      res.status(404).json({ success: false, error: 'Établissement introuvable' });
      return;
    }

    res.json({
      success: true,
      message: 'Paramètres de l\'établissement enregistrés',
      data: updRes.rows[0],
    });
  } catch (error) {
    next(error);
  }
});
