-- =====================================================================
-- Rollback Migration 010 : Marche Africain & Multi-Devises
-- =====================================================================

DROP TABLE IF EXISTS public.saas_exchange_rate_history CASCADE;
DROP TABLE IF EXISTS public.saas_exchange_rates CASCADE;
DROP TABLE IF EXISTS public.saas_country_plan_prices CASCADE;
DROP TABLE IF EXISTS public.saas_reception_accounts CASCADE;
DROP TABLE IF EXISTS public.saas_country_payment_methods CASCADE;
DROP TABLE IF EXISTS public.saas_payment_providers CASCADE;
DROP TABLE IF EXISTS public.saas_countries CASCADE;

ALTER TABLE public.saas_invoices
    DROP COLUMN IF EXISTS country_code;

ALTER TABLE public.saas_subscription_transactions
    DROP COLUMN IF EXISTS country_code,
    DROP COLUMN IF EXISTS refunded_at,
    DROP COLUMN IF EXISTS refund_reason;

ALTER TABLE public.companies
    DROP COLUMN IF EXISTS country_code;
