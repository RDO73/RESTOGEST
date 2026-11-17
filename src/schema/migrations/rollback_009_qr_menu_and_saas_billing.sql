-- =====================================================================
-- RESTOGEST V1.2 - Rollback de la Migration 009
-- Procédure de retour arrière non destructive pour les tables 001..008
-- =====================================================================

BEGIN;

DROP TABLE IF EXISTS public.table_service_requests CASCADE;
DROP TABLE IF EXISTS public.qr_order_status_history CASCADE;
DROP TABLE IF EXISTS public.qr_order_item_options CASCADE;
DROP TABLE IF EXISTS public.qr_order_items CASCADE;
DROP TABLE IF EXISTS public.qr_orders CASCADE;
DROP TABLE IF EXISTS public.product_option_values CASCADE;
DROP TABLE IF EXISTS public.product_option_groups CASCADE;
DROP TABLE IF EXISTS public.qr_menu_settings CASCADE;
DROP TABLE IF EXISTS public.dining_tables CASCADE;

DROP TABLE IF EXISTS public.saas_invoices CASCADE;
DROP TABLE IF EXISTS public.saas_subscription_transactions CASCADE;
DROP TABLE IF EXISTS public.saas_payouts CASCADE;
DROP TABLE IF EXISTS public.saas_merchant_settings CASCADE;

DELETE FROM public.schema_migrations WHERE filename = '009_qr_menu_and_saas_billing.sql';

COMMIT;
