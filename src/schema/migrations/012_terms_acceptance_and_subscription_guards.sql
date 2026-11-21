-- =====================================================================
-- MyRestoGest V1.5 - Migration 012 : Preuve d'Acceptation CGU/CGV,
-- Quotas par Formule, Essai 14 Jours & Verification Manuelle Honnete
-- Migration 100 % incrementale et non destructive (compatible 001..011)
-- =====================================================================

-- 1. Table d'historique immuable (append-only) des acceptations CGU / CGV
--    et prises de connaissance de la Politique de Confidentialite
CREATE TABLE IF NOT EXISTS public.user_terms_acceptances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    cgu_version VARCHAR(40) NOT NULL,
    cgv_version VARCHAR(40) NOT NULL,
    privacy_policy_version VARCHAR(40) NOT NULL,
    privacy_policy_acknowledged BOOLEAN NOT NULL DEFAULT TRUE,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acceptance_source VARCHAR(60) NOT NULL DEFAULT 'register'
        CHECK (acceptance_source IN ('register', 'reacceptance', 'admin_demo')),
    proof_hash VARCHAR(64) NOT NULL,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_user_terms_acceptances_company_user
    ON public.user_terms_acceptances(company_id, user_id, accepted_at DESC);

-- Trigger garantissant l'immuabilite des preuves d'acceptation deja enregistrees
-- (interdit tout UPDATE et tout DELETE direct tant que l'entreprise et l'utilisateur existent)
CREATE OR REPLACE FUNCTION public.trg_user_terms_acceptances_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'Modification interdite : les preuves d''acceptation CGU/CGV sont strictement immuables (id=%).', OLD.id;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF EXISTS (SELECT 1 FROM public.companies WHERE id = OLD.company_id)
           AND EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id) THEN
            RAISE EXCEPTION 'Suppression interdite : l''historique des acceptations CGU/CGV est strictement immuable (id=%).', OLD.id;
        END IF;
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_user_terms_acceptances ON public.user_terms_acceptances;
CREATE TRIGGER trg_guard_user_terms_acceptances
    BEFORE UPDATE OR DELETE ON public.user_terms_acceptances
    FOR EACH ROW
    EXECUTE FUNCTION public.trg_user_terms_acceptances_immutable();

ALTER TABLE public.user_terms_acceptances ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rls_user_terms_acceptances_tenant ON public.user_terms_acceptances;
CREATE POLICY rls_user_terms_acceptances_tenant ON public.user_terms_acceptances
    FOR ALL TO restogest_app
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

GRANT SELECT, INSERT ON public.user_terms_acceptances TO restogest_app, restogest_admin;

-- 2. Colonnes de derogation exceptionnelle de quotas par le Super-Admin (tracees dans audit_logs)
ALTER TABLE public.company_subscriptions
    ADD COLUMN IF NOT EXISTS custom_max_users INT CHECK (custom_max_users IS NULL OR custom_max_users >= 1),
    ADD COLUMN IF NOT EXISTS custom_max_locations INT CHECK (custom_max_locations IS NULL OR custom_max_locations >= 1),
    ADD COLUMN IF NOT EXISTS custom_max_tables INT CHECK (custom_max_tables IS NULL OR custom_max_tables >= 1),
    ADD COLUMN IF NOT EXISTS custom_max_products INT CHECK (custom_max_products IS NULL OR custom_max_products >= 1),
    ADD COLUMN IF NOT EXISTS quota_override_reason TEXT;

-- 3. Alignement strict des quotas par formule dans subscription_plans
UPDATE public.subscription_plans
SET max_locations = 1, max_users = 3, max_tables = 15, max_products = 100
WHERE code = 'ESSENTIEL';

UPDATE public.subscription_plans
SET max_locations = 1, max_users = 10, max_tables = 50, max_products = 500
WHERE code = 'PRO';

UPDATE public.subscription_plans
SET max_locations = 10, max_users = 999, max_tables = 999, max_products = 9999
WHERE code = 'ENTREPRISE';

-- 4. Honnetete des moyens de paiement SN & GN : tant qu'aucune passerelle de redirection
--    automatisee temps reel n'est branchee en production, toutes les methodes SN/GN
--    exigent une verification avant activation.
UPDATE public.saas_country_payment_methods
SET requires_manual_verification = TRUE
WHERE country_code IN ('SN', 'GN');

-- 5. Identite legale prudente et exacte dans saas_merchant_settings (uniquement sur les valeurs par defaut)
UPDATE public.saas_merchant_settings
SET brand_name = 'MyRestoGest',
    legal_name = 'Hadiry Dramé (Fondateur & Exploitant — activité en lancement commercial)',
    bank_account_name = 'Hadiry Dramé — MyRestoGest',
    support_email = 'hadirydrame@gmail.com',
    updated_at = NOW()
WHERE brand_name IN ('RESTOGEST', 'RESTOGEST SaaS', 'RestoGest', 'RestoGest Cloud', 'MyRestoGest')
  AND legal_name IN (
      'RESTOGEST CLOUD SAS',
      'RESTOGEST — Hadiry Dramé',
      'MyRestoGest — Hadiry Dramé'
  );
