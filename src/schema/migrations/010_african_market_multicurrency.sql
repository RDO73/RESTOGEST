-- =====================================================================
-- RESTOGEST V1.3 - Migration 010 : Marche Africain, Pays, Devises, Tarifs Locaux, Taux de Change & Moyens de Reception
-- Migration 100 % incrementale et non destructive (compatible 001..009)
-- =====================================================================

-- 1. Ajout du pays sur les etablissements, transactions et factures SaaS
ALTER TABLE public.companies
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) NOT NULL DEFAULT 'SN';

ALTER TABLE public.saas_subscription_transactions
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) NOT NULL DEFAULT 'SN',
    ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS refund_reason TEXT;

ALTER TABLE public.saas_invoices
    ADD COLUMN IF NOT EXISTS country_code VARCHAR(10) NOT NULL DEFAULT 'SN';

-- 2. Referentiel centralise des pays africains & devises (Section 2)
CREATE TABLE IF NOT EXISTS public.saas_countries (
    code VARCHAR(10) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    dial_code VARCHAR(15) NOT NULL,
    currency_code VARCHAR(10) NOT NULL,
    currency_symbol VARCHAR(15) NOT NULL DEFAULT '',
    decimal_separator VARCHAR(5) NOT NULL DEFAULT ',',
    thousands_separator VARCHAR(5) NOT NULL DEFAULT ' ',
    display_format VARCHAR(30) NOT NULL DEFAULT '{amount} {symbol}',
    commercial_status VARCHAR(20) NOT NULL DEFAULT 'coming_soon'
        CHECK (commercial_status IN ('active', 'pilot', 'coming_soon', 'inactive')),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.saas_countries (
    code, name, dial_code, currency_code, currency_symbol,
    decimal_separator, thousands_separator, display_format, commercial_status, is_active, sort_order
)
VALUES
    ('SN', 'Sénégal', '+221', 'XOF', 'FCFA', ',', ' ', '{amount} {symbol}', 'active', TRUE, 1),
    ('GN', 'Guinée', '+224', 'GNF', 'FG', ',', ' ', '{amount} {symbol}', 'active', TRUE, 2),
    ('CI', 'Côte d''Ivoire', '+225', 'XOF', 'FCFA', ',', ' ', '{amount} {symbol}', 'pilot', TRUE, 3),
    ('ML', 'Mali', '+223', 'XOF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 4),
    ('BF', 'Burkina Faso', '+226', 'XOF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 5),
    ('BJ', 'Bénin', '+229', 'XOF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 6),
    ('TG', 'Togo', '+228', 'XOF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 7),
    ('NE', 'Niger', '+227', 'XOF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 8),
    ('CM', 'Cameroun', '+237', 'XAF', 'FCFA', ',', ' ', '{amount} {symbol}', 'pilot', TRUE, 9),
    ('GA', 'Gabon', '+241', 'XAF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 10),
    ('CG', 'Congo', '+242', 'XAF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 11),
    ('TD', 'Tchad', '+235', 'XAF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 12),
    ('CF', 'République centrafricaine', '+236', 'XAF', 'FCFA', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 13),
    ('NG', 'Nigeria', '+234', 'NGN', '₦', '.', ',', '{symbol}{amount}', 'coming_soon', TRUE, 14),
    ('GH', 'Ghana', '+233', 'GHS', 'GH₵', '.', ',', '{symbol}{amount}', 'coming_soon', TRUE, 15),
    ('KE', 'Kenya', '+254', 'KES', 'KSh', '.', ',', '{symbol} {amount}', 'coming_soon', TRUE, 16),
    ('ZA', 'Afrique du Sud', '+27', 'ZAR', 'R', '.', ' ', '{symbol} {amount}', 'coming_soon', TRUE, 17),
    ('RW', 'Rwanda', '+250', 'RWF', 'RF', '.', ',', '{amount} {symbol}', 'coming_soon', TRUE, 18),
    ('TZ', 'Tanzanie', '+255', 'TZS', 'TSh', '.', ',', '{symbol} {amount}', 'coming_soon', TRUE, 19),
    ('UG', 'Ouganda', '+256', 'UGX', 'USh', '.', ',', '{symbol} {amount}', 'coming_soon', TRUE, 20),
    ('ZM', 'Zambie', '+260', 'ZMW', 'ZK', '.', ',', '{symbol} {amount}', 'coming_soon', TRUE, 21),
    ('EG', 'Égypte', '+20', 'EGP', 'E£', '.', ',', '{symbol} {amount}', 'coming_soon', TRUE, 22),
    ('MA', 'Maroc', '+212', 'MAD', 'DH', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 23),
    ('TN', 'Tunisie', '+216', 'TND', 'DT', ',', ' ', '{amount} {symbol}', 'coming_soon', TRUE, 24),
    ('SL', 'Sierra Leone', '+232', 'SLE', 'Le', '.', ',', '{symbol} {amount}', 'coming_soon', TRUE, 25),
    ('LR', 'Liberia', '+231', 'LRD', 'L$', '.', ',', '{symbol}{amount}', 'coming_soon', TRUE, 26)
ON CONFLICT (code) DO NOTHING;

-- 3. Prestataires de paiement compatibles (Section 8)
CREATE TABLE IF NOT EXISTS public.saas_payment_providers (
    code VARCHAR(50) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    adapter_type VARCHAR(30) NOT NULL DEFAULT 'aggregator'
        CHECK (adapter_type IN ('manual', 'aggregator', 'bank')),
    supported_countries JSONB NOT NULL DEFAULT '[]'::jsonb,
    supported_currencies JSONB NOT NULL DEFAULT '[]'::jsonb,
    supported_methods JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (default_fee_percent >= 0),
    settlement_delay_label VARCHAR(80) NOT NULL DEFAULT 'J+1 à J+3',
    supports_refunds BOOLEAN NOT NULL DEFAULT FALSE,
    mode VARCHAR(20) NOT NULL DEFAULT 'sandbox' CHECK (mode IN ('manual', 'sandbox', 'live')),
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    notes TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.saas_payment_providers (
    code, name, adapter_type, supported_countries, supported_currencies, supported_methods,
    default_fee_percent, settlement_delay_label, supports_refunds, mode, is_active, notes
)
VALUES
    ('manual_wave_sn', 'Wave Sénégal (Vérification Manuelle)', 'manual', '["SN"]', '["XOF"]', '["wave"]', 0, 'Immédiat sur compte marchand', FALSE, 'manual', TRUE, 'Compte marchand Wave +221788979342 — validation Super-Admin requise avant activation.'),
    ('bank_transfer', 'Virement Bancaire / Dépôt avec Preuve', 'bank', '["SN","GN","CI","CM","NG","MA","TN"]', '["XOF","GNF","XAF","NGN","MAD","TND"]', '["bank_transfer","manual"]', 0, '24h à 72h ouvrées', FALSE, 'manual', TRUE, 'Validation manuelle par le Super-Administrateur après contrôle du relevé.'),
    ('paydunya', 'PayDunya Checkout (UEMOA)', 'aggregator', '["SN","CI","BJ","TG","ML","BF"]', '["XOF"]', '["wave","orange_money","free_money","card_visa_uba"]', 2.0, 'J+1 ouvré', TRUE, 'sandbox', TRUE, 'Nécessite PAYDUNYA_MASTER_KEY / PAYDUNYA_PRIVATE_KEY en production.'),
    ('paytech', 'PayTech Sénégal', 'aggregator', '["SN"]', '["XOF"]', '["wave","orange_money","free_money","card_visa_uba"]', 2.0, 'J+1 à J+2', FALSE, 'sandbox', FALSE, 'Nécessite PAYTECH_API_KEY et PAYTECH_API_SECRET.'),
    ('cinetpay', 'CinetPay Afrique', 'aggregator', '["SN","GN","CI","CM","ML","BF","TG","BJ"]', '["XOF","GNF","XAF"]', '["orange_money","mtn_momo","moov_money","wave","card_visa_uba"]', 2.5, 'J+2 à J+3', FALSE, 'sandbox', TRUE, 'Couvre XOF, GNF et XAF selon activation du compte marchand CinetPay.'),
    ('flutterwave', 'Flutterwave Africa', 'aggregator', '["NG","GH","KE","ZA","RW","TZ","UG","ZM","CM","CI","SN"]', '["NGN","GHS","KES","ZAR","RWF","TZS","UGX","ZMW","XAF","XOF"]', '["card_visa_uba","mpesa","mtn_momo","bank_transfer"]', 2.9, 'J+1 à J+5', TRUE, 'sandbox', FALSE, 'À activer après vérification KYC Flutterwave et clés FLW_SECRET_KEY.'),
    ('paystack', 'Paystack (NG / GH / ZA / KE)', 'aggregator', '["NG","GH","ZA","KE"]', '["NGN","GHS","ZAR","KES"]', '["card_visa_uba","bank_transfer","mpesa"]', 1.9, 'J+1', TRUE, 'sandbox', FALSE, 'À activer avec PAYSTACK_SECRET_KEY.')
ON CONFLICT (code) DO NOTHING;

-- 4. Moyens de paiement configurables par pays (Section 6)
CREATE TABLE IF NOT EXISTS public.saas_country_payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code VARCHAR(10) NOT NULL REFERENCES public.saas_countries(code) ON DELETE CASCADE,
    method_code VARCHAR(40) NOT NULL,
    method_label VARCHAR(120) NOT NULL,
    provider_code VARCHAR(50) NOT NULL REFERENCES public.saas_payment_providers(code) ON DELETE RESTRICT,
    currency_code VARCHAR(10) NOT NULL,
    requires_manual_verification BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 10,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (country_code, method_code, provider_code)
);

INSERT INTO public.saas_country_payment_methods (
    country_code, method_code, method_label, provider_code, currency_code,
    requires_manual_verification, is_active, sort_order
)
VALUES
    -- SÉNÉGAL (XOF)
    ('SN', 'wave', 'Wave Sénégal (Compte Marchand +221 78 897 93 42)', 'manual_wave_sn', 'XOF', TRUE, TRUE, 1),
    ('SN', 'orange_money', 'Orange Money Sénégal (via PayDunya / Manuel)', 'paydunya', 'XOF', TRUE, TRUE, 2),
    ('SN', 'free_money', 'Free Money Sénégal', 'paydunya', 'XOF', TRUE, FALSE, 3),
    ('SN', 'card_visa_uba', 'Carte Bancaire (Visa / Mastercard)', 'paydunya', 'XOF', FALSE, TRUE, 4),
    ('SN', 'bank_transfer', 'Virement Bancaire UBA / Orabank', 'bank_transfer', 'XOF', TRUE, TRUE, 5),
    -- GUINÉE (GNF)
    ('GN', 'orange_money', 'Orange Money Guinée (CinetPay / Vérification Manuelle)', 'cinetpay', 'GNF', TRUE, TRUE, 1),
    ('GN', 'mtn_momo', 'MTN MoMo Guinée', 'cinetpay', 'GNF', TRUE, FALSE, 2),
    ('GN', 'bank_transfer', 'Virement Bancaire Guinée', 'bank_transfer', 'GNF', TRUE, TRUE, 3),
    -- CÔTE D'IVOIRE (XOF)
    ('CI', 'wave', 'Wave Côte d''Ivoire', 'cinetpay', 'XOF', TRUE, TRUE, 1),
    ('CI', 'orange_money', 'Orange Money Côte d''Ivoire', 'cinetpay', 'XOF', TRUE, TRUE, 2),
    ('CI', 'mtn_momo', 'MTN Mobile Money Côte d''Ivoire', 'cinetpay', 'XOF', TRUE, TRUE, 3),
    ('CI', 'moov_money', 'Moov Money Côte d''Ivoire', 'cinetpay', 'XOF', TRUE, TRUE, 4),
    ('CI', 'card_visa_uba', 'Carte Bancaire', 'cinetpay', 'XOF', FALSE, TRUE, 5),
    -- CAMEROUN (XAF)
    ('CM', 'mtn_momo', 'MTN Mobile Money Cameroun', 'cinetpay', 'XAF', TRUE, TRUE, 1),
    ('CM', 'orange_money', 'Orange Money Cameroun', 'cinetpay', 'XAF', TRUE, TRUE, 2),
    ('CM', 'card_visa_uba', 'Carte Bancaire', 'cinetpay', 'XAF', FALSE, FALSE, 3),
    -- KENYA (KES)
    ('KE', 'mpesa', 'M-Pesa Kenya', 'flutterwave', 'KES', FALSE, FALSE, 1),
    ('KE', 'card_visa_uba', 'Carte Bancaire', 'flutterwave', 'KES', FALSE, FALSE, 2),
    -- GHANA (GHS)
    ('GH', 'mtn_momo', 'Mobile Money Ghana', 'paystack', 'GHS', FALSE, FALSE, 1),
    ('GH', 'card_visa_uba', 'Carte Bancaire', 'paystack', 'GHS', FALSE, FALSE, 2),
    -- NIGERIA (NGN)
    ('NG', 'card_visa_uba', 'Carte Bancaire (Paystack / Flutterwave)', 'paystack', 'NGN', FALSE, FALSE, 1),
    ('NG', 'bank_transfer', 'Virement Bancaire Nigeria', 'bank_transfer', 'NGN', TRUE, TRUE, 2)
ON CONFLICT (country_code, method_code, provider_code) DO NOTHING;

-- 5. « Moyens de réception RestoGest » (Section 7)
CREATE TABLE IF NOT EXISTS public.saas_reception_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code VARCHAR(10) NOT NULL REFERENCES public.saas_countries(code) ON DELETE RESTRICT,
    provider_code VARCHAR(50) NOT NULL,
    method_code VARCHAR(40) NOT NULL,
    account_label VARCHAR(150) NOT NULL,
    merchant_number_or_iban VARCHAR(150) NOT NULL,
    currency_code VARCHAR(10) NOT NULL,
    usage_scope VARCHAR(200) NOT NULL DEFAULT 'abonnements et frais commerciaux RestoGest',
    verification_status VARCHAR(40) NOT NULL DEFAULT 'manual_verification_required'
        CHECK (verification_status IN ('manual_verification_required', 'verified_api', 'inactive')),
    instructions TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (country_code, provider_code, merchant_number_or_iban)
);

INSERT INTO public.saas_reception_accounts (
    country_code, provider_code, method_code, account_label,
    merchant_number_or_iban, currency_code, usage_scope, verification_status, instructions, is_active
)
VALUES
    (
        'SN', 'wave', 'wave', 'Compte Marchand Wave Sénégal — RestoGest',
        '+221788979342', 'XOF', 'abonnements et frais commerciaux RestoGest',
        'manual_verification_required',
        'Envoyez le montant exact en XOF sur le compte Wave +221 78 897 93 42 puis saisissez votre référence de transaction. Activation après vérification manuelle par le Super-Administrateur.',
        TRUE
    ),
    (
        'SN', 'bank_transfer', 'bank_transfer', 'Compte Bancaire UBA / Orabank (XOF)',
        'SN08 0010 2030 4050 6070 8090', 'XOF', 'abonnements et frais commerciaux RestoGest',
        'manual_verification_required',
        'Effectuez un virement en mentionnant le nom de votre établissement et soumettez la référence bancaire.',
        TRUE
    )
ON CONFLICT (country_code, provider_code, merchant_number_or_iban) DO NOTHING;

-- Mettre à jour le numéro Wave dans saas_merchant_settings pour cohérence stricte
UPDATE public.saas_merchant_settings
SET wave_merchant_number = '+221788979342',
    updated_at = NOW()
WHERE wave_merchant_number IS NULL OR wave_merchant_number = '+221 77 800 10 10';

-- 6. Tarifs locaux par pays (Section 4)
CREATE TABLE IF NOT EXISTS public.saas_country_plan_prices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    country_code VARCHAR(10) NOT NULL REFERENCES public.saas_countries(code) ON DELETE CASCADE,
    plan_code VARCHAR(50) NOT NULL,
    billing_period VARCHAR(20) NOT NULL
        CHECK (billing_period IN ('monthly', 'quarterly', 'semiannual', 'yearly')),
    reference_price NUMERIC(14,2) NOT NULL CHECK (reference_price >= 0),
    local_price NUMERIC(14,2) NOT NULL CHECK (local_price >= 0),
    currency_code VARCHAR(10) NOT NULL,
    setup_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (setup_fee >= 0),
    effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (country_code, plan_code, billing_period)
);

INSERT INTO public.saas_country_plan_prices (
    country_code, plan_code, billing_period, reference_price, local_price, currency_code, setup_fee, is_active
)
VALUES
    -- SÉNÉGAL (XOF) : conservation stricte des tarifs 15 000, 29 000, 59 000 FCFA
    ('SN', 'ESSENTIEL', 'monthly',    15000, 15000, 'XOF', 0, TRUE),
    ('SN', 'ESSENTIEL', 'quarterly',  42000, 42000, 'XOF', 0, TRUE),
    ('SN', 'ESSENTIEL', 'semiannual', 81000, 81000, 'XOF', 0, TRUE),
    ('SN', 'ESSENTIEL', 'yearly',    150000, 150000, 'XOF', 0, TRUE),
    ('SN', 'PRO',       'monthly',    29000, 29000, 'XOF', 0, TRUE),
    ('SN', 'PRO',       'quarterly',  81000, 81000, 'XOF', 0, TRUE),
    ('SN', 'PRO',       'semiannual',156000, 156000, 'XOF', 0, TRUE),
    ('SN', 'PRO',       'yearly',    290000, 290000, 'XOF', 0, TRUE),
    ('SN', 'ENTREPRISE','monthly',    59000, 59000, 'XOF', 25000, TRUE),
    ('SN', 'ENTREPRISE','quarterly', 165000, 165000, 'XOF', 25000, TRUE),
    ('SN', 'ENTREPRISE','semiannual',318000, 318000, 'XOF', 25000, TRUE),
    ('SN', 'ENTREPRISE','yearly',    590000, 590000, 'XOF', 25000, TRUE),
    -- GUINÉE (GNF) : tarifs officiels locaux GNF
    ('GN', 'ESSENTIEL', 'monthly',    15000, 225000, 'GNF', 0, TRUE),
    ('GN', 'ESSENTIEL', 'quarterly',  42000, 630000, 'GNF', 0, TRUE),
    ('GN', 'ESSENTIEL', 'semiannual', 81000, 1215000, 'GNF', 0, TRUE),
    ('GN', 'ESSENTIEL', 'yearly',    150000, 2250000, 'GNF', 0, TRUE),
    ('GN', 'PRO',       'monthly',    29000, 435000, 'GNF', 0, TRUE),
    ('GN', 'PRO',       'quarterly',  81000, 1215000, 'GNF', 0, TRUE),
    ('GN', 'PRO',       'semiannual',156000, 2340000, 'GNF', 0, TRUE),
    ('GN', 'PRO',       'yearly',    290000, 4350000, 'GNF', 0, TRUE),
    ('GN', 'ENTREPRISE','monthly',    59000, 885000, 'GNF', 375000, TRUE),
    ('GN', 'ENTREPRISE','quarterly', 165000, 2475000, 'GNF', 375000, TRUE),
    ('GN', 'ENTREPRISE','semiannual',318000, 4770000, 'GNF', 375000, TRUE),
    ('GN', 'ENTREPRISE','yearly',    590000, 8850000, 'GNF', 375000, TRUE)
ON CONFLICT (country_code, plan_code, billing_period) DO NOTHING;

-- 7. Taux de change & historique (Section 5)
CREATE TABLE IF NOT EXISTS public.saas_exchange_rates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    target_currency VARCHAR(10) NOT NULL,
    rate NUMERIC(18,6) NOT NULL CHECK (rate > 0),
    source VARCHAR(100) NOT NULL DEFAULT 'BCEAO / Référentiel RestoGest',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (base_currency, target_currency)
);

CREATE TABLE IF NOT EXISTS public.saas_exchange_rate_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    base_currency VARCHAR(10) NOT NULL,
    target_currency VARCHAR(10) NOT NULL,
    rate NUMERIC(18,6) NOT NULL,
    source VARCHAR(100) NOT NULL,
    recorded_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.saas_exchange_rates (base_currency, target_currency, rate, source)
VALUES
    ('XOF', 'XOF', 1.000000, 'Parité fixe'),
    ('XOF', 'XAF', 1.000000, 'Parité CFA / CEMAC'),
    ('XOF', 'GNF', 15.000000, 'Référentiel indicatif Afrique de l''Ouest'),
    ('XOF', 'NGN', 2.650000, 'Référentiel indicatif'),
    ('XOF', 'GHS', 0.025000, 'Référentiel indicatif'),
    ('XOF', 'KES', 0.215000, 'Référentiel indicatif'),
    ('XOF', 'MAD', 0.016500, 'Référentiel indicatif'),
    ('XOF', 'ZAR', 0.030000, 'Référentiel indicatif')
ON CONFLICT (base_currency, target_currency) DO NOTHING;

-- Droits pour l'applicatif et l'administrateur
GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.saas_countries,
    public.saas_payment_providers,
    public.saas_country_payment_methods,
    public.saas_reception_accounts,
    public.saas_country_plan_prices,
    public.saas_exchange_rates,
    public.saas_exchange_rate_history
TO restogest_app, restogest_admin;
