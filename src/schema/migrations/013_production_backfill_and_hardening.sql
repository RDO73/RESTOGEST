-- =====================================================================
-- MyRestoGest V1.5 - Migration 013 : Backfill Production Sûr & Nettoyage Coordonnées
-- Migration 100 % incrémentale, idempotente et non destructive (compatible 001..012)
-- =====================================================================

-- 1. Créer une ligne company_subscriptions basée sur la date d'inscription réelle
--    pour tout établissement existant qui n'en possède pas encore (inscriptions antérieures à v1.5)
INSERT INTO public.company_subscriptions (
    company_id,
    plan_id,
    plan_code,
    status,
    billing_period,
    starts_at,
    ends_at,
    trial_ends_at,
    current_period_start,
    current_period_end,
    updated_at
)
SELECT
    c.id,
    (SELECT sp.id FROM public.subscription_plans sp WHERE sp.code = 'PRO' LIMIT 1),
    'PRO',
    CASE
        WHEN c.created_at + INTERVAL '14 days' < NOW() THEN 'expired'
        ELSE 'trial'
    END,
    'monthly',
    c.created_at,
    c.created_at + INTERVAL '14 days',
    c.created_at + INTERVAL '14 days',
    c.created_at,
    c.created_at + INTERVAL '14 days',
    NOW()
FROM public.companies c
WHERE c.id <> '00000000-0000-0000-0000-000000000000'::UUID
  AND NOT EXISTS (
      SELECT 1 FROM public.company_subscriptions cs WHERE cs.company_id = c.id
  )
ON CONFLICT (company_id) DO NOTHING;

-- 2. Compléter plan_code et plan_id manquants sur d'éventuelles lignes d'abonnement existantes
UPDATE public.company_subscriptions cs
SET plan_code = COALESCE(
        cs.plan_code,
        (SELECT sp.code FROM public.subscription_plans sp WHERE sp.id = cs.plan_id LIMIT 1),
        'PRO'
    ),
    plan_id = COALESCE(
        cs.plan_id,
        (SELECT sp.id FROM public.subscription_plans sp WHERE sp.code = COALESCE(cs.plan_code, 'PRO') LIMIT 1)
    ),
    updated_at = NOW()
WHERE cs.plan_code IS NULL OR cs.plan_id IS NULL;

-- 3. Remplacer les éventuels numéros ou e-mails factices résiduels dans saas_merchant_settings
--    par les coordonnées officielles exactes du fondateur Hadiry Dramé
UPDATE public.saas_merchant_settings
SET brand_name = CASE
        WHEN brand_name IS NULL OR BTRIM(brand_name) IN ('', 'RESTOGEST', 'RESTOGEST SaaS', 'RestoGest', 'RestoGest Cloud')
        THEN 'MyRestoGest'
        ELSE brand_name
    END,
    whatsapp_phone = CASE
        WHEN whatsapp_phone IS NULL OR BTRIM(whatsapp_phone) IN ('', '+221 77 000 00 00', '+221770000000')
        THEN '+221 78 897 93 42'
        ELSE whatsapp_phone
    END,
    support_phone = CASE
        WHEN support_phone IS NULL OR BTRIM(support_phone) IN ('', '+221 77 000 00 00', '+221770000000')
        THEN '+221 78 897 93 42'
        ELSE support_phone
    END,
    support_email = CASE
        WHEN support_email IS NULL OR LOWER(BTRIM(support_email)) IN ('', 'facturation@myrestogest.com', 'contact@myrestogest.com')
        THEN 'hadirydrame@gmail.com'
        ELSE support_email
    END,
    updated_at = NOW();
