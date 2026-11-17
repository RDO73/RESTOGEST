-- =====================================================================
-- RESTOGEST V1.2 - Migration 009 : Menu Digital QR Code, Commandes en Salle/Cuisine & Facturation SaaS Proprietaire
-- Migration incrementale 100 % compatible avec les donnees et tables existantes (001..008)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ENRICHISSEMENT NON DESTRUCTIF DES FORMULES ET ABONNEMENTS SAAS
-- ---------------------------------------------------------------------
ALTER TABLE public.subscription_plans
    ADD COLUMN IF NOT EXISTS code VARCHAR(50) UNIQUE,
    ADD COLUMN IF NOT EXISTS currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    ADD COLUMN IF NOT EXISTS quarterly_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (quarterly_price >= 0),
    ADD COLUMN IF NOT EXISTS semiannual_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (semiannual_price >= 0),
    ADD COLUMN IF NOT EXISTS setup_fee NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (setup_fee >= 0),
    ADD COLUMN IF NOT EXISTS trial_days INT NOT NULL DEFAULT 14 CHECK (trial_days >= 0),
    ADD COLUMN IF NOT EXISTS max_users INT NOT NULL DEFAULT 5 CHECK (max_users >= 1),
    ADD COLUMN IF NOT EXISTS max_locations INT NOT NULL DEFAULT 1 CHECK (max_locations >= 1),
    ADD COLUMN IF NOT EXISTS max_tables INT NOT NULL DEFAULT 20 CHECK (max_tables >= 1),
    ADD COLUMN IF NOT EXISTS max_products INT NOT NULL DEFAULT 500 CHECK (max_products >= 1);

ALTER TABLE public.company_subscriptions
    ALTER COLUMN plan_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS plan_code VARCHAR(50),
    ADD COLUMN IF NOT EXISTS current_period_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
    ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
    ADD COLUMN IF NOT EXISTS last_payment_method VARCHAR(40),
    ADD COLUMN IF NOT EXISTS last_payment_ref VARCHAR(120),
    ADD COLUMN IF NOT EXISTS last_payment_amount NUMERIC(14,2),
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

DELETE FROM public.company_subscriptions a
USING public.company_subscriptions b
WHERE a.company_id = b.company_id
  AND (a.created_at < b.created_at OR (a.created_at = b.created_at AND a.id::TEXT < b.id::TEXT));

CREATE UNIQUE INDEX IF NOT EXISTS uq_company_subscriptions_company_id
ON public.company_subscriptions (company_id);

CREATE TABLE IF NOT EXISTS public.company_settings (
    company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
    currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    country VARCHAR(10) NOT NULL DEFAULT 'SN',
    whatsapp_phone VARCHAR(50),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'public.company_subscriptions'::regclass
          AND contype = 'c'
    LOOP
        EXECUTE format('ALTER TABLE public.company_subscriptions DROP CONSTRAINT IF EXISTS %I', r.conname);
    END LOOP;
END $$;

ALTER TABLE public.company_subscriptions
    ADD CONSTRAINT chk_company_subscriptions_period
        CHECK (billing_period IN ('monthly', 'quarterly', 'semiannual', 'yearly')),
    ADD CONSTRAINT chk_company_subscriptions_status
        CHECK (status IN ('trial', 'active', 'pending_payment', 'past_due', 'suspended', 'cancelled', 'expired'));

-- ---------------------------------------------------------------------
-- 2. TABLES ET QR CODES (MODULE 1 & MODULE 8)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.dining_tables (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    code VARCHAR(40) NOT NULL,
    name VARCHAR(120) NOT NULL,
    zone VARCHAR(80) NOT NULL DEFAULT 'Salle intérieure',
    seats INT NOT NULL DEFAULT 4 CHECK (seats > 0),
    table_type VARCHAR(30) NOT NULL DEFAULT 'table'
        CHECK (table_type IN ('table', 'takeaway_qr', 'counter')),
    qr_token VARCHAR(96) NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    current_status VARCHAR(30) NOT NULL DEFAULT 'free'
        CHECK (current_status IN ('free', 'occupied', 'order_pending', 'in_preparation', 'preparing', 'ready', 'served', 'bill_requested', 'closed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id),
    UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_dining_tables_company ON public.dining_tables(company_id);
CREATE INDEX IF NOT EXISTS idx_dining_tables_qr_token ON public.dining_tables(qr_token);

-- ---------------------------------------------------------------------
-- 3. PARAMÈTRES DU MENU DIGITAL PUBLIC (MODULE 2 & MODULE 9)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qr_menu_settings (
    company_id UUID PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
    display_name VARCHAR(255),
    tagline VARCHAR(255) DEFAULT 'Commandez directement depuis votre table',
    logo_url TEXT,
    cover_image_url TEXT,
    cover_url TEXT,
    welcome_message TEXT NOT NULL DEFAULT 'Bienvenue ! Scannez, personnalisez et commandez directement depuis votre table.',
    footer_note TEXT NOT NULL DEFAULT 'Scannez pour consulter notre menu et commander',
    currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    phone VARCHAR(60),
    whatsapp_phone VARCHAR(60),
    address TEXT,
    opening_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
    qr_ordering_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    allow_takeaway_qr BOOLEAN NOT NULL DEFAULT TRUE,
    allow_call_waiter BOOLEAN NOT NULL DEFAULT TRUE,
    allow_request_bill BOOLEAN NOT NULL DEFAULT TRUE,
    auto_accept_orders BOOLEAN NOT NULL DEFAULT FALSE,
    require_customer_name BOOLEAN NOT NULL DEFAULT FALSE,
    require_customer_phone BOOLEAN NOT NULL DEFAULT FALSE,
    primary_color VARCHAR(20) NOT NULL DEFAULT '#f97316',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 4. PERSONNALISATION DES PRODUITS : GROUPES D'OPTIONS & SUPPLÉMENTS (MODULE 3)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.product_option_groups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    product_id UUID,
    name VARCHAR(120) NOT NULL,
    is_required BOOLEAN NOT NULL DEFAULT FALSE,
    selection_type VARCHAR(20) NOT NULL DEFAULT 'single'
        CHECK (selection_type IN ('single', 'multiple')),
    allow_multiple BOOLEAN NOT NULL DEFAULT FALSE,
    min_choices INT NOT NULL DEFAULT 0 CHECK (min_choices >= 0),
    max_choices INT NOT NULL DEFAULT 1 CHECK (max_choices >= 1),
    allow_custom_text BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.product_option_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    group_id UUID NOT NULL,
    label VARCHAR(120) NOT NULL,
    price_delta NUMERIC(14,2) NOT NULL DEFAULT 0,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, group_id) REFERENCES public.product_option_groups(company_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- 5. COMMANDES QR CODE, ARTICLES, SNAPSHOTS D'OPTIONS & HISTORIQUE (MODULES 4, 5, 6, 7)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qr_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    table_id UUID,
    table_code_snapshot VARCHAR(40) NOT NULL,
    table_name_snapshot VARCHAR(120) NOT NULL,
    order_type VARCHAR(30) NOT NULL DEFAULT 'dine_in'
        CHECK (order_type IN ('dine_in', 'takeaway', 'counter')),
    order_number VARCHAR(60) NOT NULL,
    tracking_token VARCHAR(96) NOT NULL UNIQUE,
    idempotency_key VARCHAR(120),
    customer_name VARCHAR(150),
    customer_phone VARCHAR(60),
    customer_note TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'accepted', 'preparing', 'ready', 'served', 'rejected', 'cancelled')),
    rejection_reason TEXT,
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    options_total NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (options_total >= 0),
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    linked_sale_id UUID,
    payment_status VARCHAR(30) NOT NULL DEFAULT 'unpaid'
        CHECK (payment_status IN ('unpaid', 'partial', 'paid', 'refunded')),
    payment_method VARCHAR(40),
    payment_reference VARCHAR(120),
    source_ip VARCHAR(80),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    preparing_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    served_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    paid_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    UNIQUE (company_id, id),
    UNIQUE (company_id, order_number),
    UNIQUE (company_id, idempotency_key),
    UNIQUE (company_id, linked_sale_id),
    FOREIGN KEY (company_id, table_id) REFERENCES public.dining_tables(company_id, id) ON DELETE SET NULL,
    FOREIGN KEY (company_id, linked_sale_id) REFERENCES public.sales(company_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_qr_orders_company_status ON public.qr_orders(company_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_qr_orders_tracking ON public.qr_orders(tracking_token);

CREATE TABLE IF NOT EXISTS public.qr_order_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    qr_order_id UUID NOT NULL,
    product_id UUID NOT NULL,
    product_name_snapshot VARCHAR(255) NOT NULL,
    product_description_snapshot TEXT,
    quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
    base_unit_price NUMERIC(14,2) NOT NULL CHECK (base_unit_price >= 0),
    options_unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
    subtotal NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0),
    item_note TEXT,
    custom_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_qr_order_items_subtotal CHECK (subtotal = ROUND(quantity * unit_price, 2)),
    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, qr_order_id) REFERENCES public.qr_orders(company_id, id) ON DELETE CASCADE,
    FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS public.qr_order_item_options (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    qr_order_item_id UUID NOT NULL,
    option_value_id UUID,
    group_name_snapshot VARCHAR(120) NOT NULL,
    option_label_snapshot VARCHAR(120) NOT NULL,
    price_delta_snapshot NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (company_id, qr_order_item_id) REFERENCES public.qr_order_items(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.qr_order_status_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    qr_order_id UUID NOT NULL,
    previous_status VARCHAR(30),
    old_status VARCHAR(30),
    new_status VARCHAR(30) NOT NULL,
    changed_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    changed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (company_id, qr_order_id) REFERENCES public.qr_orders(company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS public.table_service_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    table_id UUID NOT NULL,
    table_code_snapshot VARCHAR(40) NOT NULL,
    table_name_snapshot VARCHAR(120),
    qr_order_id UUID,
    request_type VARCHAR(30) NOT NULL CHECK (request_type IN ('call_waiter', 'request_bill')),
    customer_note TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged', 'resolved')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    resolved_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    FOREIGN KEY (company_id, table_id) REFERENCES public.dining_tables(company_id, id) ON DELETE CASCADE,
    FOREIGN KEY (company_id, qr_order_id) REFERENCES public.qr_orders(company_id, id) ON DELETE SET NULL
);

-- ---------------------------------------------------------------------
-- 6. CIRCUIT FINANCIER DISTINCT DU PROPRIÉTAIRE (« FINANCES RESTOGEST »)
-- Totalement séparé de public.payments et public.cash_sessions des restaurants
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.saas_merchant_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legal_name VARCHAR(160) NOT NULL DEFAULT 'RESTOGEST CLOUD SAS',
    brand_name VARCHAR(120) NOT NULL DEFAULT 'RESTOGEST SaaS',
    support_email VARCHAR(160) DEFAULT 'facturation@myrestogest.com',
    support_phone VARCHAR(60) DEFAULT '+221 77 000 00 00',
    whatsapp_phone VARCHAR(60) DEFAULT '+221 77 000 00 00',
    address TEXT DEFAULT 'Dakar (Sénégal) & Conakry (Guinée)',
    tax_id VARCHAR(100),
    default_currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    active_provider VARCHAR(50) NOT NULL DEFAULT 'paydunya',
    manual_payment_instructions TEXT NOT NULL DEFAULT 'Effectuez votre règlement par Wave, Orange Money ou virement bancaire puis transmettez la référence de transaction pour vérification et activation.',
    bank_name VARCHAR(120) DEFAULT 'UBA / Orabank Afrique de l’Ouest',
    bank_account_name VARCHAR(120) DEFAULT 'RESTOGEST CLOUD SAS',
    bank_iban VARCHAR(120) DEFAULT 'SN08 0010 2030 4050 6070 8090',
    wave_merchant_number VARCHAR(60) DEFAULT '+221 77 800 10 10',
    orange_money_merchant_number VARCHAR(60) DEFAULT '+221 77 900 20 20',
    mtn_momo_merchant_number VARCHAR(60) DEFAULT '+224 664 00 00 00',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.saas_subscription_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_ref VARCHAR(80) NOT NULL UNIQUE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    subscription_id UUID,
    plan_code VARCHAR(50) NOT NULL,
    billing_period VARCHAR(20) NOT NULL
        CHECK (billing_period IN ('monthly', 'quarterly', 'semiannual', 'yearly')),
    currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    subscription_price_snapshot NUMERIC(14,2) NOT NULL CHECK (subscription_price_snapshot >= 0),
    setup_fee_snapshot NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (setup_fee_snapshot >= 0),
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    gross_amount NUMERIC(14,2) NOT NULL CHECK (gross_amount >= 0),
    provider_fee_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (provider_fee_amount >= 0),
    net_expected_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (net_expected_amount >= 0),
    payment_provider VARCHAR(60) NOT NULL DEFAULT 'manual',
    payment_method VARCHAR(40) NOT NULL,
    provider_transaction_id VARCHAR(150),
    payer_phone VARCHAR(60),
    payer_name VARCHAR(120),
    manual_reference VARCHAR(120),
    manual_proof_note TEXT,
    status VARCHAR(30) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('initiated', 'pending', 'confirmed', 'failed', 'abandoned', 'refunded')),
    failure_reason TEXT,
    webhook_verified BOOLEAN NOT NULL DEFAULT FALSE,
    webhook_confirmations_count INT NOT NULL DEFAULT 0,
    period_start TIMESTAMPTZ,
    period_end TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    confirmed_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id)
);

CREATE INDEX IF NOT EXISTS idx_saas_tx_company ON public.saas_subscription_transactions(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saas_tx_status ON public.saas_subscription_transactions(status);

CREATE TABLE IF NOT EXISTS public.saas_invoices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_number VARCHAR(60) NOT NULL UNIQUE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
    subscription_id UUID,
    transaction_id UUID NOT NULL UNIQUE REFERENCES public.saas_subscription_transactions(id) ON DELETE RESTRICT,
    customer_company_name VARCHAR(255) NOT NULL,
    customer_email VARCHAR(255),
    customer_phone VARCHAR(60),
    customer_address TEXT,
    plan_code VARCHAR(50) NOT NULL,
    plan_name VARCHAR(120) NOT NULL,
    billing_period VARCHAR(20) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    subtotal_amount NUMERIC(14,2) NOT NULL CHECK (subtotal_amount >= 0),
    setup_fee_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (setup_fee_amount >= 0),
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount NUMERIC(14,2) NOT NULL CHECK (total_amount >= 0),
    payment_method VARCHAR(40) NOT NULL,
    payment_reference VARCHAR(120),
    status VARCHAR(30) NOT NULL DEFAULT 'paid',
    issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    paid_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS public.saas_payouts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payout_ref VARCHAR(80) NOT NULL UNIQUE,
    payment_provider VARCHAR(60) NOT NULL,
    destination_account VARCHAR(160) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    gross_collected_amount NUMERIC(14,2) NOT NULL CHECK (gross_collected_amount > 0),
    provider_fees_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (provider_fees_amount >= 0),
    net_settled_amount NUMERIC(14,2) NOT NULL CHECK (net_settled_amount >= 0),
    status VARCHAR(30) NOT NULL DEFAULT 'settled' CHECK (status IN ('pending', 'in_transit', 'settled', 'failed')),
    settled_at TIMESTAMPTZ,
    notes TEXT,
    recorded_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 7. ROW LEVEL SECURITY (RLS) & PRIVILÈGES SUR LES NOUVELLES TABLES
-- ---------------------------------------------------------------------
ALTER TABLE public.dining_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_menu_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_option_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_option_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_order_item_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.qr_order_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.table_service_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_subscription_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.saas_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_dining_tables ON public.dining_tables;
CREATE POLICY rls_dining_tables ON public.dining_tables
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_qr_menu_settings ON public.qr_menu_settings;
CREATE POLICY rls_qr_menu_settings ON public.qr_menu_settings
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_product_option_groups ON public.product_option_groups;
CREATE POLICY rls_product_option_groups ON public.product_option_groups
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_product_option_values ON public.product_option_values;
CREATE POLICY rls_product_option_values ON public.product_option_values
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_qr_orders ON public.qr_orders;
CREATE POLICY rls_qr_orders ON public.qr_orders
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_qr_order_items ON public.qr_order_items;
CREATE POLICY rls_qr_order_items ON public.qr_order_items
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_qr_order_item_options ON public.qr_order_item_options;
CREATE POLICY rls_qr_order_item_options ON public.qr_order_item_options
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_qr_order_status_history ON public.qr_order_status_history;
CREATE POLICY rls_qr_order_status_history ON public.qr_order_status_history
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_table_service_requests ON public.table_service_requests;
CREATE POLICY rls_table_service_requests ON public.table_service_requests
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

ALTER TABLE public.company_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_company_settings ON public.company_settings;
CREATE POLICY rls_company_settings ON public.company_settings
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_saas_subscription_transactions ON public.saas_subscription_transactions;
CREATE POLICY rls_saas_subscription_transactions ON public.saas_subscription_transactions
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

DROP POLICY IF EXISTS rls_saas_invoices ON public.saas_invoices;
CREATE POLICY rls_saas_invoices ON public.saas_invoices
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON
    public.company_settings,
    public.dining_tables,
    public.qr_menu_settings,
    public.product_option_groups,
    public.product_option_values,
    public.qr_orders,
    public.qr_order_items,
    public.qr_order_item_options,
    public.qr_order_status_history,
    public.table_service_requests
TO restogest_app;

GRANT SELECT, INSERT, UPDATE ON
    public.subscription_plans,
    public.company_subscriptions,
    public.saas_subscription_transactions,
    public.saas_invoices,
    public.saas_merchant_settings
TO restogest_app;

REVOKE ALL ON public.saas_payouts FROM PUBLIC, restogest_app;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO restogest_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO restogest_admin;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper = TRUE) THEN
        ALTER TABLE public.company_settings FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.dining_tables FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.qr_menu_settings FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.product_option_groups FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.product_option_values FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.qr_orders FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.qr_order_items FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.qr_order_item_options FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.qr_order_status_history FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.table_service_requests FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.saas_subscription_transactions FORCE ROW LEVEL SECURITY;
        ALTER TABLE public.saas_invoices FORCE ROW LEVEL SECURITY;

        ALTER TABLE public.company_settings OWNER TO restogest_owner;
        ALTER TABLE public.dining_tables OWNER TO restogest_owner;
        ALTER TABLE public.qr_menu_settings OWNER TO restogest_owner;
        ALTER TABLE public.product_option_groups OWNER TO restogest_owner;
        ALTER TABLE public.product_option_values OWNER TO restogest_owner;
        ALTER TABLE public.qr_orders OWNER TO restogest_owner;
        ALTER TABLE public.qr_order_items OWNER TO restogest_owner;
        ALTER TABLE public.qr_order_item_options OWNER TO restogest_owner;
        ALTER TABLE public.qr_order_status_history OWNER TO restogest_owner;
        ALTER TABLE public.table_service_requests OWNER TO restogest_owner;
        ALTER TABLE public.saas_subscription_transactions OWNER TO restogest_owner;
        ALTER TABLE public.saas_invoices OWNER TO restogest_owner;

        ALTER TABLE public.saas_merchant_settings OWNER TO restogest_admin;
        ALTER TABLE public.saas_payouts OWNER TO restogest_admin;
    END IF;
END $$;
