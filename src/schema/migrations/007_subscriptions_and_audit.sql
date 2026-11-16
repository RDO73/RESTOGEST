-- =====================================================================
-- RESTOGEST V1 - Migration 007 : Abonnements & Journal d'Audit Immuable Automatise
-- =====================================================================

-- ---------------------------------------------------------------------
-- 12. ABONNEMENTS ET JOURNAL D'AUDIT AUTOMATISÉ
-- ---------------------------------------------------------------------
CREATE TABLE public.subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL UNIQUE,
    description TEXT,
    monthly_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (monthly_price >= 0),
    yearly_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (yearly_price >= 0),
    features JSONB NOT NULL DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE public.company_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES public.subscription_plans(id) ON DELETE RESTRICT,
    billing_period VARCHAR(20) NOT NULL CHECK (billing_period IN ('monthly', 'yearly')),
    status VARCHAR(20) NOT NULL CHECK (status IN ('trial', 'active', 'past_due', 'suspended', 'cancelled')),
    starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id)
);

CREATE TABLE public.audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    table_name VARCHAR(100) NOT NULL,
    record_id UUID,
    old_values JSONB,
    new_values JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Déclencheur automatique d'audit sur les tables sensibles
CREATE OR REPLACE FUNCTION public.trg_audit_log_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_comp_id UUID;
    v_user_id UUID;
    v_record_id UUID;
    v_old JSONB := NULL;
    v_new JSONB := NULL;
BEGIN
    v_comp_id := COALESCE(NEW.company_id, OLD.company_id, public.app_current_company_id());
    v_user_id := public.app_current_user_id();

    IF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        IF v_old ? 'id' THEN
            v_record_id := (v_old->>'id')::UUID;
        ELSIF v_old ? 'user_id' THEN
            v_record_id := (v_old->>'user_id')::UUID;
        END IF;
    ELSIF TG_OP = 'UPDATE' THEN
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
        IF v_new ? 'id' THEN
            v_record_id := (v_new->>'id')::UUID;
        ELSIF v_new ? 'user_id' THEN
            v_record_id := (v_new->>'user_id')::UUID;
        END IF;
    ELSIF TG_OP = 'INSERT' THEN
        v_new := to_jsonb(NEW);
        IF v_new ? 'id' THEN
            v_record_id := (v_new->>'id')::UUID;
        ELSIF v_new ? 'user_id' THEN
            v_record_id := (v_new->>'user_id')::UUID;
        END IF;
    END IF;

    -- Ne jamais consigner les mots de passe dans les logs
    IF TG_TABLE_NAME = 'user_credentials' THEN
        IF v_old IS NOT NULL THEN v_old := v_old - 'password_hash'; END IF;
        IF v_new IS NOT NULL THEN v_new := v_new - 'password_hash'; END IF;
    END IF;

    INSERT INTO public.audit_logs (
        company_id, user_id, action, table_name, record_id, old_values, new_values, created_at
    )
    VALUES (
        v_comp_id, v_user_id, TG_OP, TG_TABLE_NAME, v_record_id, v_old, v_new, NOW()
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- Attachement des triggers d'audit sur les pièces et tables sensibles
CREATE TRIGGER audit_sales AFTER INSERT OR UPDATE OR DELETE ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_log_change();

CREATE TRIGGER audit_purchases AFTER INSERT OR UPDATE OR DELETE ON public.purchases
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_log_change();

CREATE TRIGGER audit_payments AFTER INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_log_change();

CREATE TRIGGER audit_refunds AFTER INSERT OR UPDATE OR DELETE ON public.refunds
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_log_change();

CREATE TRIGGER audit_expenses AFTER INSERT OR UPDATE OR DELETE ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_log_change();

CREATE TRIGGER audit_roles AFTER INSERT OR UPDATE OR DELETE ON public.roles
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_log_change();

CREATE TRIGGER audit_company_users AFTER INSERT OR UPDATE OR DELETE ON public.company_users
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_log_change();

-- Immuabilité absolue de la table audit_logs
CREATE OR REPLACE FUNCTION public.trg_audit_logs_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'Le journal d''audit est strictement immuable (UPDATE et DELETE interdits)';
END;
$$;

CREATE TRIGGER trg_audit_logs_no_tamper
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.trg_audit_logs_immutable();
