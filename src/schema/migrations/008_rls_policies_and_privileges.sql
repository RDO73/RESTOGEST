-- =====================================================================
-- RESTOGEST V1 - Migration 008 : Row Level Security (RLS Forcee), Politiques d'Isolation, Matrice GRANT/REVOKE & Proprietaires
-- =====================================================================

-- ---------------------------------------------------------------------
-- 13. ROW LEVEL SECURITY (RLS) FORCÉE SUR TOUTES LES TABLES
-- ---------------------------------------------------------------------
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.company_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories FORCE ROW LEVEL SECURITY;
ALTER TABLE public.products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.products FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipe_ingredients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stock_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_levels FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_movements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales FORCE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sale_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.refunds FORCE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.suppliers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items FORCE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses FORCE ROW LEVEL SECURITY;
ALTER TABLE public.cash_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cash_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customers FORCE ROW LEVEL SECURITY;
ALTER TABLE public.company_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_subscriptions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_logs FORCE ROW LEVEL SECURITY;

-- Politiques RLS sans récursion (Fail-Closed)
CREATE POLICY rls_companies ON public.companies
    FOR SELECT USING (id = public.app_current_company_id());

CREATE POLICY rls_users ON public.users
    FOR SELECT USING (
        id = public.app_current_user_id()
        OR EXISTS (
            SELECT 1 FROM public.company_users cu1
            JOIN public.company_users cu2 ON cu1.company_id = cu2.company_id
            WHERE cu1.user_id = public.app_current_user_id() AND cu2.user_id = users.id
        )
    );

CREATE POLICY rls_company_users ON public.company_users
    FOR SELECT USING (user_id = public.app_current_user_id());

CREATE POLICY rls_roles ON public.roles
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_categories ON public.categories
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_products ON public.products
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_recipes ON public.recipes
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_recipe_ingredients ON public.recipe_ingredients
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_stock_levels ON public.stock_levels
    FOR SELECT USING (company_id = public.app_current_company_id());

CREATE POLICY rls_stock_movements ON public.stock_movements
    FOR SELECT USING (company_id = public.app_current_company_id());

CREATE POLICY rls_sales ON public.sales
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_sale_items ON public.sale_items
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_payments ON public.payments
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_refunds ON public.refunds
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_suppliers ON public.suppliers
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_purchases ON public.purchases
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_purchase_items ON public.purchase_items
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_expenses ON public.expenses
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_cash_sessions ON public.cash_sessions
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_customers ON public.customers
    USING (company_id = public.app_current_company_id())
    WITH CHECK (company_id = public.app_current_company_id());

CREATE POLICY rls_subscriptions ON public.company_subscriptions
    FOR SELECT USING (company_id = public.app_current_company_id());

CREATE POLICY rls_audit_logs ON public.audit_logs
    FOR SELECT USING (company_id = public.app_current_company_id());

-- ---------------------------------------------------------------------
-- 14. MATRICE CHIRURGICALE DES PRIVILÈGES ET PROPRIÉTÉS DES RÔLES
-- ---------------------------------------------------------------------
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO restogest_app, restogest_admin;
GRANT ALL ON SCHEMA public TO restogest_owner;

-- Tables catalogue et CRM
GRANT SELECT, INSERT, UPDATE, DELETE ON 
    public.categories, public.products, public.recipes, public.recipe_ingredients, public.customers 
TO restogest_app;

-- Ventes et articles
GRANT SELECT, INSERT ON public.sales TO restogest_app;
GRANT UPDATE (customer_id, cash_session_id, notes, discount_amount) ON public.sales TO restogest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sale_items TO restogest_app;

-- Achats : UPDATE autorisé uniquement sur les colonnes non critiques (status et received_at exclus)
GRANT SELECT, INSERT ON public.purchases TO restogest_app;
GRANT UPDATE (supplier_id, reference, notes, total_amount, purchased_at) ON public.purchases TO restogest_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.purchase_items TO restogest_app;
GRANT SELECT, INSERT, UPDATE ON public.suppliers TO restogest_app;

-- Paiements, remboursements et caisse (clôture exclusive via close_cash_session())
GRANT SELECT, INSERT ON public.payments TO restogest_app;
GRANT SELECT, INSERT ON public.refunds TO restogest_app;
GRANT UPDATE (reason, gateway_transaction_id, gateway_response) ON public.refunds TO restogest_app;
GRANT SELECT, INSERT ON public.cash_sessions TO restogest_app;
GRANT SELECT, INSERT ON public.expenses TO restogest_app;

-- Tables en lecture seule pour restogest_app
GRANT SELECT ON public.companies TO restogest_app;
GRANT SELECT ON public.subscription_plans TO restogest_app;
GRANT SELECT ON public.stock_levels TO restogest_app;
GRANT SELECT ON public.stock_movements TO restogest_app;
GRANT SELECT ON public.audit_logs TO restogest_app;
GRANT SELECT ON public.company_subscriptions TO restogest_app;
GRANT SELECT ON public.roles TO restogest_app;
GRANT SELECT ON public.company_users TO restogest_app;
GRANT SELECT ON public.users TO restogest_app;

-- Tables strictement inaccessibles pour restogest_app (et restogest_owner)
REVOKE ALL ON public.user_credentials FROM PUBLIC, restogest_app, restogest_owner;
REVOKE ALL ON public.user_sessions FROM PUBLIC, restogest_app, restogest_owner;
REVOKE ALL ON public.app_security_config FROM PUBLIC, restogest_app, restogest_owner;

-- Droits d'exécution des procédures SECURITY DEFINER
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

-- Privilèges d'administration technique (BYPASSRLS)
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO restogest_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO restogest_admin;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO restogest_admin;
GRANT restogest_app TO restogest_admin;

-- Exécution autorisée pour restogest_app et restogest_owner (nécessaire notamment pour l'évaluation RLS)
GRANT EXECUTE ON FUNCTION public.register_company_and_owner(VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT, VARCHAR) TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.set_session_context(VARCHAR, UUID) TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.app_current_company_id() TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.complete_sale(UUID) TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.cancel_sale(UUID, TEXT) TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.receive_purchase(UUID) TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.cancel_purchase(UUID, TEXT) TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.record_stock_adjustment(UUID, VARCHAR, NUMERIC, TEXT) TO restogest_app, restogest_owner;
GRANT EXECUTE ON FUNCTION public.close_cash_session(UUID, NUMERIC) TO restogest_app, restogest_owner;

-- Ségrégation explicite des propriétaires (si déployé par un superutilisateur comme postgres)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper = TRUE) THEN
        ALTER SCHEMA public OWNER TO restogest_owner;

        -- Tables métier détenues par restogest_owner (NOBYPASSRLS => FORCE RLS actif même pour le propriétaire)
        ALTER TABLE public.companies OWNER TO restogest_owner;
        ALTER TABLE public.users OWNER TO restogest_owner;
        ALTER TABLE public.roles OWNER TO restogest_owner;
        ALTER TABLE public.company_users OWNER TO restogest_owner;
        ALTER TABLE public.categories OWNER TO restogest_owner;
        ALTER TABLE public.products OWNER TO restogest_owner;
        ALTER TABLE public.recipes OWNER TO restogest_owner;
        ALTER TABLE public.recipe_ingredients OWNER TO restogest_owner;
        ALTER TABLE public.stock_levels OWNER TO restogest_owner;
        ALTER TABLE public.stock_movements OWNER TO restogest_owner;
        ALTER TABLE public.cash_sessions OWNER TO restogest_owner;
        ALTER TABLE public.customers OWNER TO restogest_owner;
        ALTER TABLE public.sales OWNER TO restogest_owner;
        ALTER TABLE public.sale_items OWNER TO restogest_owner;
        ALTER TABLE public.payments OWNER TO restogest_owner;
        ALTER TABLE public.refunds OWNER TO restogest_owner;
        ALTER TABLE public.suppliers OWNER TO restogest_owner;
        ALTER TABLE public.purchases OWNER TO restogest_owner;
        ALTER TABLE public.purchase_items OWNER TO restogest_owner;
        ALTER TABLE public.expenses OWNER TO restogest_owner;
        ALTER TABLE public.subscription_plans OWNER TO restogest_owner;
        ALTER TABLE public.company_subscriptions OWNER TO restogest_owner;
        ALTER TABLE public.audit_logs OWNER TO restogest_owner;

        -- Tables de sécurité strictement isolées détenues par restogest_admin
        ALTER TABLE public.app_security_config OWNER TO restogest_admin;
        ALTER TABLE public.user_credentials OWNER TO restogest_admin;
        ALTER TABLE public.user_sessions OWNER TO restogest_admin;

        -- Fonctions SECURITY DEFINER détenues par restogest_admin (BYPASSRLS)
        -- Garantit l'exécution interne sous FORCE RLS (audit_logs, stock_levels, register, etc.)
        ALTER FUNCTION public.register_company_and_owner(VARCHAR, VARCHAR, VARCHAR, VARCHAR, TEXT, VARCHAR) OWNER TO restogest_admin;
        ALTER FUNCTION public.set_session_context(VARCHAR, UUID) OWNER TO restogest_admin;
        ALTER FUNCTION public.app_current_company_id() OWNER TO restogest_admin;
        ALTER FUNCTION public.app_current_user_id() OWNER TO restogest_admin;
        ALTER FUNCTION public.apply_stock_movement() OWNER TO restogest_admin;
        ALTER FUNCTION public.trg_lock_sale_on_child_change() OWNER TO restogest_admin;
        ALTER FUNCTION public.trg_validate_refund() OWNER TO restogest_admin;
        ALTER FUNCTION public.complete_sale(UUID) OWNER TO restogest_admin;
        ALTER FUNCTION public.cancel_sale(UUID, TEXT) OWNER TO restogest_admin;
        ALTER FUNCTION public.trg_purchases_guard() OWNER TO restogest_admin;
        ALTER FUNCTION public.trg_lock_purchase_on_item_change() OWNER TO restogest_admin;
        ALTER FUNCTION public.receive_purchase(UUID) OWNER TO restogest_admin;
        ALTER FUNCTION public.cancel_purchase(UUID, TEXT) OWNER TO restogest_admin;
        ALTER FUNCTION public.record_stock_adjustment(UUID, VARCHAR, NUMERIC, TEXT) OWNER TO restogest_admin;
        ALTER FUNCTION public.trg_expense_cash_session() OWNER TO restogest_admin;
        ALTER FUNCTION public.close_cash_session(UUID, NUMERIC) OWNER TO restogest_admin;
        ALTER FUNCTION public.trg_audit_log_change() OWNER TO restogest_admin;
    END IF;
END $$;
