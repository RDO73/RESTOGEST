-- =====================================================================
-- Rollback Migration 012 : Preuve d'Acceptation CGU/CGV & Quotas
-- =====================================================================

DROP TRIGGER IF EXISTS trg_guard_user_terms_acceptances ON public.user_terms_acceptances;
DROP FUNCTION IF EXISTS public.trg_user_terms_acceptances_immutable();
DROP TABLE IF EXISTS public.user_terms_acceptances;

ALTER TABLE public.company_subscriptions
    DROP COLUMN IF EXISTS custom_max_users,
    DROP COLUMN IF EXISTS custom_max_locations,
    DROP COLUMN IF EXISTS custom_max_tables,
    DROP COLUMN IF EXISTS custom_max_products,
    DROP COLUMN IF EXISTS quota_override_reason;
