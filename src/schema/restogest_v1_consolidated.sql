-- =====================================================================
-- RESTOGEST V1 - ARCHITECTURE SQL CONSOLIDÉE DE RÉFÉRENCE
-- Version cible : PostgreSQL 14.0+
-- Sécurité : RLS Forcée, Sessions Validées & Signées, Anti-Spoofing,
--            Anti-Deadlock, PMP Sérialisé, Audit Automatisé
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. CRÉATION EXPLICITE DES RÔLES ET GESTION DES PRIVILÈGES (FAIL-CLOSED)
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'restogest_owner') THEN
        BEGIN
            CREATE ROLE restogest_owner WITH LOGIN CREATEROLE;
        EXCEPTION WHEN insufficient_privilege THEN
            CREATE ROLE restogest_owner WITH LOGIN;
        END;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'restogest_admin') THEN
        BEGIN
            CREATE ROLE restogest_admin WITH LOGIN BYPASSRLS;
        EXCEPTION WHEN insufficient_privilege THEN
            CREATE ROLE restogest_admin WITH LOGIN;
        END;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'restogest_app') THEN
        CREATE ROLE restogest_app WITH LOGIN NOBYPASSRLS;
    END IF;
END $$;

-- Révocation stricte de tout privilège accordé implicitement par PostgreSQL
ALTER DEFAULT PRIVILEGES REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE ALL ON SEQUENCES FROM PUBLIC;

-- ---------------------------------------------------------------------
-- 2. TABLE TECHNIQUE DE SÉCURITÉ (CLÉ DE SIGNATURE DES SESSIONS)
-- ---------------------------------------------------------------------
-- Cette table contient le secret interne servant à signer les variables de session
-- et les jetons internes d'autorisation (ex: réception d'achat).
-- Ni restogest_app ni restogest_owner n'ont accès à cette table (REVOKE ALL).
CREATE TABLE IF NOT EXISTS public.app_security_config (
    id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    hmac_secret TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE ALL ON public.app_security_config FROM PUBLIC, restogest_app, restogest_owner;

INSERT INTO public.app_security_config (id, hmac_secret)
VALUES (1, encode(sha256((gen_random_uuid()::TEXT || clock_timestamp()::TEXT)::bytea), 'hex'))
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 3. ENTREPRISES ET STRUCTURE D'ACCÈS
-- ---------------------------------------------------------------------
CREATE TABLE public.companies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    business_type VARCHAR(30) NOT NULL
        CHECK (business_type IN ('restaurant', 'pastry_shop', 'both')),
    currency VARCHAR(10) NOT NULL DEFAULT 'XOF',
    default_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 0
        CHECK (default_tax_rate >= 0 AND default_tax_rate <= 100),
    allow_negative_stock BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX uq_users_email_lower ON public.users (LOWER(email));

-- Secrets d'authentification strictement isolés
CREATE TABLE public.user_credentials (
    user_id UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
    password_hash TEXT NOT NULL,
    algo VARCHAR(30) NOT NULL DEFAULT 'argon2id',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
REVOKE ALL ON public.user_credentials FROM PUBLIC, restogest_app;

-- Sessions authentifiées avec hash de jeton cryptographique
CREATE TABLE public.user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE, -- Hash SHA-256 du jeton JWT JTI / Session ID
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_user_sessions_lookup ON public.user_sessions(token_hash) WHERE revoked_at IS NULL;
REVOKE ALL ON public.user_sessions FROM PUBLIC, restogest_app;

CREATE TABLE public.roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    permissions JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id),
    UNIQUE (company_id, name)
);

CREATE TABLE public.company_users (
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (company_id, user_id),
    FOREIGN KEY (company_id, role_id) REFERENCES public.roles(company_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------
-- 4. INSCRIPTION AUTONOME ET GESTION DU CONTEXTE (ANTI-SPOOFING SIGNÉ)
-- ---------------------------------------------------------------------

-- Fonction d'inscription sécurisée (SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.register_company_and_owner(
    p_company_name VARCHAR(255),
    p_business_type VARCHAR(30),
    p_currency VARCHAR(10),
    p_owner_email VARCHAR(255),
    p_password_hash TEXT,
    p_owner_full_name VARCHAR(255)
)
RETURNS TABLE (
    company_id UUID,
    user_id UUID,
    role_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_company_id UUID;
    v_user_id UUID;
    v_role_id UUID;
BEGIN
    IF p_owner_email IS NULL OR TRIM(p_owner_email) = '' THEN
        RAISE EXCEPTION 'L''adresse email est obligatoire';
    END IF;

    IF EXISTS (SELECT 1 FROM public.users WHERE LOWER(email) = LOWER(TRIM(p_owner_email))) THEN
        RAISE EXCEPTION 'Cet e-mail est déjà associé à un compte existant';
    END IF;

    -- Création atomique de l'entreprise
    INSERT INTO public.companies (name, business_type, currency)
    VALUES (p_company_name, p_business_type, COALESCE(p_currency, 'XOF'))
    RETURNING id INTO v_company_id;

    -- Création du compte utilisateur
    INSERT INTO public.users (email, full_name)
    VALUES (LOWER(TRIM(p_owner_email)), p_owner_full_name)
    RETURNING id INTO v_user_id;

    -- Stockage des identifiants (argon2id)
    INSERT INTO public.user_credentials (user_id, password_hash, algo)
    VALUES (v_user_id, p_password_hash, 'argon2id');

    -- Création du rôle propriétaire
    INSERT INTO public.roles (company_id, name, permissions)
    VALUES (v_company_id, 'Propriétaire', '{"all": true}'::jsonb)
    RETURNING id INTO v_role_id;

    -- Rattachement en tant que membre actif
    INSERT INTO public.company_users (company_id, user_id, role_id, is_active)
    VALUES (v_company_id, v_user_id, v_role_id, TRUE);

    RETURN QUERY SELECT v_company_id, v_user_id, v_role_id;
END;
$$;

-- Établissement du contexte de session avec calcul de signature SHA-256 liée à la session et à la transaction
CREATE OR REPLACE FUNCTION public.set_session_context(
    p_token_hash VARCHAR(64),
    p_company_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_session RECORD;
    v_is_member BOOLEAN;
    v_company_active BOOLEAN;
    v_secret TEXT;
    v_sig TEXT;
BEGIN
    -- Réinitialisation immédiate (fail-closed)
    PERFORM set_config('app.session_id', '', true);
    PERFORM set_config('app.session_user_id', '', true);
    PERFORM set_config('app.session_company_id', '', true);
    PERFORM set_config('app.session_signature', '', true);

    IF p_token_hash IS NULL OR p_company_id IS NULL THEN
        RAISE EXCEPTION 'Authentification refusée : paramètres manquants';
    END IF;

    -- Vérification de la session active (avec son id réel et son entreprise autorisée)
    SELECT s.id, s.user_id, s.company_id, u.is_active AS user_active
    INTO v_session
    FROM public.user_sessions s
    JOIN public.users u ON u.id = s.user_id
    WHERE s.token_hash = p_token_hash
      AND s.expires_at > NOW()
      AND s.revoked_at IS NULL;

    IF NOT FOUND OR NOT v_session.user_active THEN
        RAISE EXCEPTION 'Authentification refusée : session invalide, expirée ou révoquée';
    END IF;

    -- Vérification stricte que le jeton de session correspond bien à l'entreprise demandée
    IF v_session.company_id <> p_company_id THEN
        RAISE EXCEPTION 'Accès refusé : session non autorisée pour l''entreprise demandée';
    END IF;

    SELECT is_active INTO v_company_active
    FROM public.companies
    WHERE id = p_company_id;

    IF NOT COALESCE(v_company_active, FALSE) THEN
        RAISE EXCEPTION 'Accès refusé : entreprise inactive ou introuvable';
    END IF;

    -- Vérification de l'appartenance active à l'entreprise demandée
    SELECT EXISTS (
        SELECT 1 FROM public.company_users
        WHERE company_id = p_company_id
          AND user_id = v_session.user_id
          AND is_active = TRUE
    ) INTO v_is_member;

    IF NOT v_is_member THEN
        RAISE EXCEPTION 'Accès refusé : utilisateur non rattaché à l''entreprise demandée';
    END IF;

    -- Signature SHA-256 (double secret préfixe/suffixe) liée au contexte exact et à la transaction courante
    -- Empêche la falsification par set_config() ET le rejeu hors transaction courante
    SELECT hmac_secret INTO v_secret FROM public.app_security_config WHERE id = 1;
    v_sig := encode(
        sha256((
            v_secret || '|' || v_session.id::TEXT || '|' || v_session.user_id::TEXT || '|' ||
            p_company_id::TEXT || '|' || pg_backend_pid()::TEXT || '|' ||
            transaction_timestamp()::TEXT || '|' || v_secret
        )::bytea),
        'hex'
    );

    -- Stockage transactionnel des GUC (is_local = true pour purge sur COMMIT/ROLLBACK)
    PERFORM set_config('app.session_id', v_session.id::TEXT, true);
    PERFORM set_config('app.session_user_id', v_session.user_id::TEXT, true);
    PERFORM set_config('app.session_company_id', p_company_id::TEXT, true);
    PERFORM set_config('app.session_signature', v_sig, true);
END;
$$;

-- Fonctions d'extraction du contexte : vérifient signature SHA-256 + révocation exacte de session_id + cohérence
CREATE OR REPLACE FUNCTION public.app_current_company_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_sid TEXT;
    v_uid TEXT;
    v_cid TEXT;
    v_sig TEXT;
    v_secret TEXT;
    v_expected_sig TEXT;
BEGIN
    v_sid := NULLIF(current_setting('app.session_id', true), '');
    v_uid := NULLIF(current_setting('app.session_user_id', true), '');
    v_cid := NULLIF(current_setting('app.session_company_id', true), '');
    v_sig := NULLIF(current_setting('app.session_signature', true), '');

    IF v_sid IS NULL OR v_uid IS NULL OR v_cid IS NULL OR v_sig IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT hmac_secret INTO v_secret FROM public.app_security_config WHERE id = 1;

    v_expected_sig := encode(
        sha256((
            v_secret || '|' || v_sid || '|' || v_uid || '|' ||
            v_cid || '|' || pg_backend_pid()::TEXT || '|' ||
            transaction_timestamp()::TEXT || '|' || v_secret
        )::bytea),
        'hex'
    );

    -- Vérification stricte de la signature : détecte toute altération directe via set_config() ou rejeu inter-transactions
    IF v_sig IS DISTINCT FROM v_expected_sig THEN
        RETURN NULL;
    END IF;

    -- Vérification en temps réel sur l'identifiant réel de session (s.id) et la correspondance (session, user, company)
    IF NOT EXISTS (
        SELECT 1
        FROM public.user_sessions s
        JOIN public.users u ON u.id = s.user_id
        JOIN public.companies c ON c.id = s.company_id
        JOIN public.company_users cu ON cu.company_id = s.company_id AND cu.user_id = s.user_id
        WHERE s.id = v_sid::UUID
          AND s.user_id = v_uid::UUID
          AND s.company_id = v_cid::UUID
          AND s.expires_at > clock_timestamp()
          AND s.revoked_at IS NULL
          AND u.is_active = TRUE
          AND c.is_active = TRUE
          AND cu.is_active = TRUE
    ) THEN
        RETURN NULL;
    END IF;

    RETURN v_cid::UUID;
END;
$$;

CREATE OR REPLACE FUNCTION public.app_current_user_id()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_sid TEXT;
    v_uid TEXT;
    v_cid TEXT;
    v_sig TEXT;
    v_secret TEXT;
    v_expected_sig TEXT;
BEGIN
    v_sid := NULLIF(current_setting('app.session_id', true), '');
    v_uid := NULLIF(current_setting('app.session_user_id', true), '');
    v_cid := NULLIF(current_setting('app.session_company_id', true), '');
    v_sig := NULLIF(current_setting('app.session_signature', true), '');

    IF v_sid IS NULL OR v_uid IS NULL OR v_cid IS NULL OR v_sig IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT hmac_secret INTO v_secret FROM public.app_security_config WHERE id = 1;

    v_expected_sig := encode(
        sha256((
            v_secret || '|' || v_sid || '|' || v_uid || '|' ||
            v_cid || '|' || pg_backend_pid()::TEXT || '|' ||
            transaction_timestamp()::TEXT || '|' || v_secret
        )::bytea),
        'hex'
    );

    -- Vérification stricte de la signature
    IF v_sig IS DISTINCT FROM v_expected_sig THEN
        RETURN NULL;
    END IF;

    -- Vérification en temps réel sur l'identifiant réel de session (s.id) et la correspondance (session, user, company)
    IF NOT EXISTS (
        SELECT 1
        FROM public.user_sessions s
        JOIN public.users u ON u.id = s.user_id
        JOIN public.companies c ON c.id = s.company_id
        JOIN public.company_users cu ON cu.company_id = s.company_id AND cu.user_id = s.user_id
        WHERE s.id = v_sid::UUID
          AND s.user_id = v_uid::UUID
          AND s.company_id = v_cid::UUID
          AND s.expires_at > clock_timestamp()
          AND s.revoked_at IS NULL
          AND u.is_active = TRUE
          AND c.is_active = TRUE
          AND cu.is_active = TRUE
    ) THEN
        RETURN NULL;
    END IF;

    RETURN v_uid::UUID;
END;
$$;

-- ---------------------------------------------------------------------
-- 5. CATALOGUE ET RECETTES (AVEC DÉTECTION SÉRIALISÉE DES CYCLES)
-- ---------------------------------------------------------------------
CREATE TABLE public.categories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name VARCHAR(150) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id),
    UNIQUE (company_id, name)
);

CREATE TABLE public.products (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    category_id UUID,
    name VARCHAR(255) NOT NULL,
    sku VARCHAR(100),
    product_type VARCHAR(30) NOT NULL
        CHECK (product_type IN ('raw_material', 'semi_finished', 'finished_good', 'service')),
    inventory_tracking VARCHAR(20) NOT NULL DEFAULT 'direct'
        CHECK (inventory_tracking IN ('direct', 'recipe_on_sale', 'none')),
    unit VARCHAR(30) NOT NULL,
    selling_price NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (selling_price >= 0),
    cost_price NUMERIC(14,4) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    tax_rate NUMERIC(5,2),
    min_stock_alert NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (min_stock_alert >= 0),
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (company_id, id),
    UNIQUE (company_id, sku),
    FOREIGN KEY (company_id, category_id)
        REFERENCES public.categories(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.recipes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    finished_product_id UUID NOT NULL,
    name VARCHAR(255) NOT NULL,
    output_quantity NUMERIC(14,4) NOT NULL DEFAULT 1 CHECK (output_quantity > 0),
    instructions TEXT,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, finished_product_id)
        REFERENCES public.products(company_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_recipes_one_active_per_product
ON public.recipes (company_id, finished_product_id)
WHERE is_active = TRUE;

CREATE TABLE public.recipe_ingredients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    recipe_id UUID NOT NULL,
    ingredient_id UUID NOT NULL,
    quantity_required NUMERIC(14,4) NOT NULL CHECK (quantity_required > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (company_id, id),
    UNIQUE (recipe_id, ingredient_id),

    FOREIGN KEY (company_id, recipe_id)
        REFERENCES public.recipes(company_id, id) ON DELETE CASCADE,
    FOREIGN KEY (company_id, ingredient_id)
        REFERENCES public.products(company_id, id) ON DELETE RESTRICT
);

-- Déclencheur BEFORE de détection des cycles et de sérialisation
CREATE OR REPLACE FUNCTION public.trg_lock_and_detect_recipe_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_comp_id UUID;
    v_parent_product UUID;
    v_target_ingredient UUID;
    v_cycle_detected BOOLEAN := FALSE;
    v_cycle_path TEXT;
    v_max_depth BOOLEAN := FALSE;
BEGIN
    v_comp_id := COALESCE(NEW.company_id, OLD.company_id);

    -- Sérialisation exclusive par entreprise avant toute modification du graphe
    PERFORM pg_advisory_xact_lock(hashtext('recipe_graph_' || v_comp_id::TEXT));

    IF TG_TABLE_NAME = 'recipe_ingredients' THEN
        SELECT finished_product_id INTO v_parent_product
        FROM public.recipes
        WHERE id = NEW.recipe_id AND company_id = v_comp_id;

        v_target_ingredient := NEW.ingredient_id;

        -- 1. Auto-référence directe
        IF v_parent_product = v_target_ingredient THEN
            RAISE EXCEPTION 'Auto-référence directe interdite : le produit % ne peut être son propre ingrédient', v_target_ingredient;
        END IF;

        -- 2. Détection de cycle indirect prenant en compte la NOUVELLE relation (NEW)
        -- Existe-t-il un chemin orienté allant de v_target_ingredient jusqu'à v_parent_product ?
        WITH RECURSIVE downstream AS (
            SELECT
                r.finished_product_id AS parent_prod,
                ri.ingredient_id AS child_prod,
                ARRAY[v_parent_product, v_target_ingredient, ri.ingredient_id] AS path,
                1 AS depth
            FROM public.recipes r
            JOIN public.recipe_ingredients ri ON ri.recipe_id = r.id AND ri.company_id = v_comp_id
            WHERE r.finished_product_id = v_target_ingredient
              AND r.is_active = TRUE
              AND r.company_id = v_comp_id
              AND (TG_OP <> 'UPDATE' OR ri.id <> OLD.id)

            UNION ALL

            SELECT
                r.finished_product_id AS parent_prod,
                ri.ingredient_id AS child_prod,
                d.path || ri.ingredient_id,
                d.depth + 1
            FROM downstream d
            JOIN public.recipes r ON r.finished_product_id = d.child_prod
                                 AND r.is_active = TRUE
                                 AND r.company_id = v_comp_id
            JOIN public.recipe_ingredients ri ON ri.recipe_id = r.id AND ri.company_id = v_comp_id
            WHERE d.depth <= 50
              AND NOT (v_parent_product = ANY(d.path[2:]))
              AND (TG_OP <> 'UPDATE' OR ri.id <> OLD.id)
        )
        SELECT
            EXISTS (SELECT 1 FROM downstream WHERE child_prod = v_parent_product),
            (SELECT array_to_string(path, ' -> ') FROM downstream WHERE child_prod = v_parent_product LIMIT 1),
            EXISTS (SELECT 1 FROM downstream WHERE depth > 50)
        INTO v_cycle_detected, v_cycle_path, v_max_depth;

        IF v_cycle_detected THEN
            RAISE EXCEPTION 'Cycle de recette interdit détecté ! Parcours : %', v_cycle_path;
        END IF;

        IF v_max_depth THEN
            RAISE EXCEPTION 'Profondeur maximale de sous-recettes (50) dépassée';
        END IF;

    ELSIF TG_TABLE_NAME = 'recipes' THEN
        IF NOT NEW.is_active THEN
            RETURN NEW;
        END IF;

        v_parent_product := NEW.finished_product_id;

        -- Vérifie si un ingrédient de cette recette mènerait au nouveau produit fini
        WITH RECURSIVE downstream AS (
            SELECT
                ri.ingredient_id AS child_prod,
                ARRAY[v_parent_product, ri.ingredient_id] AS path,
                1 AS depth
            FROM public.recipe_ingredients ri
            WHERE ri.recipe_id = NEW.id
              AND ri.company_id = v_comp_id

            UNION ALL

            SELECT
                ri.ingredient_id AS child_prod,
                d.path || ri.ingredient_id,
                d.depth + 1
            FROM downstream d
            JOIN public.recipes r ON r.finished_product_id = d.child_prod
                                 AND r.is_active = TRUE
                                 AND r.company_id = v_comp_id
            JOIN public.recipe_ingredients ri ON ri.recipe_id = r.id AND ri.company_id = v_comp_id
            WHERE d.depth <= 50
              AND NOT (v_parent_product = ANY(d.path[2:]))
        )
        SELECT
            EXISTS (SELECT 1 FROM downstream WHERE child_prod = v_parent_product),
            (SELECT array_to_string(path, ' -> ') FROM downstream WHERE child_prod = v_parent_product LIMIT 1),
            EXISTS (SELECT 1 FROM downstream WHERE depth > 50)
        INTO v_cycle_detected, v_cycle_path, v_max_depth;

        IF v_cycle_detected THEN
            RAISE EXCEPTION 'Cycle de recette interdit détecté ! Parcours : %', v_cycle_path;
        END IF;

        IF v_max_depth THEN
            RAISE EXCEPTION 'Profondeur maximale de sous-recettes (50) dépassée';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_recipe_ingredients_cycle
BEFORE INSERT OR UPDATE OF ingredient_id, recipe_id ON public.recipe_ingredients
FOR EACH ROW EXECUTE FUNCTION public.trg_lock_and_detect_recipe_cycle();

CREATE TRIGGER trg_recipes_cycle
BEFORE UPDATE OF finished_product_id, is_active ON public.recipes
FOR EACH ROW EXECUTE FUNCTION public.trg_lock_and_detect_recipe_cycle();

-- ---------------------------------------------------------------------
-- 6. STOCKS ET MOUVEMENTS (ANTI-ALTÉRATION DIRECTE)
-- ---------------------------------------------------------------------
CREATE TABLE public.stock_levels (
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    product_id UUID NOT NULL,
    current_quantity NUMERIC(14,3) NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (company_id, product_id),
    FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.stock_movements (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    product_id UUID NOT NULL,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    movement_type VARCHAR(30) NOT NULL CHECK (
        movement_type IN (
            'purchase_in',
            'sale_out',
            'recipe_out',
            'production_in',
            'loss',
            'adjustment',
            'sale_reversal'
        )
    ),
    quantity_delta NUMERIC(14,3) NOT NULL CHECK (quantity_delta <> 0),
    source_type VARCHAR(30),
    source_id UUID,
    source_line_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON DELETE RESTRICT
);

-- Index d'idempotence ciblé uniquement sur les pièces comptables traçables
CREATE UNIQUE INDEX uq_stock_movements_traceable ON public.stock_movements (
    company_id, source_type, source_id, source_line_id, product_id, movement_type
)
WHERE source_type IS NOT NULL AND source_line_id IS NOT NULL;

-- Garde-fou strict : Interdiction de créer des mouvements de stock sur les produits sans suivi (none)
CREATE OR REPLACE FUNCTION public.trg_check_stock_movement_allowed()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_tracking VARCHAR(20);
BEGIN
    SELECT inventory_tracking INTO v_tracking
    FROM public.products
    WHERE id = NEW.product_id AND company_id = NEW.company_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Produit % introuvable pour mouvement de stock', NEW.product_id;
    END IF;

    IF v_tracking = 'none' THEN
        RAISE EXCEPTION 'Mouvement de stock interdit : le suivi de stock est désactivé (none) pour le produit %', NEW.product_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stock_movement_tracking_guard
BEFORE INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.trg_check_stock_movement_allowed();

-- Trigger d'application atomique du stock
CREATE OR REPLACE FUNCTION public.apply_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_allow_negative BOOLEAN;
    v_updated_rows INTEGER;
BEGIN
    SELECT allow_negative_stock INTO v_allow_negative
    FROM public.companies WHERE id = NEW.company_id;

    -- Contrôle strict : interdire le négatif initial si allow_negative_stock = FALSE
    IF NOT COALESCE(v_allow_negative, FALSE) AND NEW.quantity_delta < 0 THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.stock_levels
            WHERE company_id = NEW.company_id AND product_id = NEW.product_id
        ) THEN
            RAISE EXCEPTION 'Stock insuffisant pour le produit % (aucun stock initial)', NEW.product_id;
        END IF;
    END IF;

    INSERT INTO public.stock_levels (company_id, product_id, current_quantity, updated_at)
    VALUES (NEW.company_id, NEW.product_id, NEW.quantity_delta, NOW())
    ON CONFLICT (company_id, product_id)
    DO UPDATE SET
        current_quantity = stock_levels.current_quantity + EXCLUDED.current_quantity,
        updated_at = NOW()
    WHERE v_allow_negative OR (stock_levels.current_quantity + EXCLUDED.current_quantity) >= 0;

    GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

    IF v_updated_rows = 0 THEN
        RAISE EXCEPTION 'Stock insuffisant pour le produit %', NEW.product_id;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_apply_stock_movement
AFTER INSERT ON public.stock_movements
FOR EACH ROW EXECUTE FUNCTION public.apply_stock_movement();

-- ---------------------------------------------------------------------
-- 7. CAISSES, CLIENTS, VENTES ET PAIEMENTS
-- ---------------------------------------------------------------------
CREATE TABLE public.cash_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    opened_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    closed_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    opening_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (opening_amount >= 0),
    expected_closing_amount NUMERIC(14,2),
    actual_closing_amount NUMERIC(14,2) CHECK (actual_closing_amount IS NULL OR actual_closing_amount >= 0),
    difference_amount NUMERIC(14,2),
    status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    UNIQUE (company_id, id)
);

CREATE UNIQUE INDEX one_open_cash_session_per_company
ON public.cash_sessions(company_id) WHERE status = 'open';

CREATE TABLE public.customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    loyalty_points INTEGER NOT NULL DEFAULT 0 CHECK (loyalty_points >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id)
);

CREATE TABLE public.sales (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    customer_id UUID,
    cash_session_id UUID,
    invoice_number VARCHAR(100) NOT NULL,
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('draft', 'pending', 'completed', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,

    UNIQUE (company_id, id),
    UNIQUE (company_id, invoice_number),
    FOREIGN KEY (company_id, customer_id)
        REFERENCES public.customers(company_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (company_id, cash_session_id)
        REFERENCES public.cash_sessions(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.sale_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL,
    product_id UUID NOT NULL,
    quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
    unit_price NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
    unit_cost_snapshot NUMERIC(14,4) NOT NULL DEFAULT 0,
    subtotal NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Intégrité arithmétique inviolable
    CONSTRAINT chk_sale_items_subtotal CHECK (subtotal = ROUND(quantity * unit_price, 2)),

    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, sale_id) REFERENCES public.sales(company_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL,
    cash_session_id UUID,
    payment_method VARCHAR(30) NOT NULL CHECK (
        payment_method IN ('cash', 'card', 'mobile_money', 'transfer', 'check', 'other')
    ),
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    reference VARCHAR(255),
    paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (company_id, id),
    UNIQUE (company_id, sale_id, id),
    FOREIGN KEY (company_id, sale_id) REFERENCES public.sales(company_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (company_id, cash_session_id) REFERENCES public.cash_sessions(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.refunds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL,
    payment_id UUID NOT NULL,
    cash_session_id UUID,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    refund_method VARCHAR(30) NOT NULL CHECK (
        refund_method IN ('cash', 'card', 'mobile_money', 'transfer', 'check', 'other')
    ),
    status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (
        status IN (
            'pending',
            'recorded_accounting_only',
            'processing_gateway',
            'completed',
            'failed',
            'rejected'
        )
    ),
    gateway_transaction_id VARCHAR(255),
    gateway_response JSONB,
    reason TEXT NOT NULL,
    created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,

    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, sale_id, payment_id)
        REFERENCES public.payments(company_id, sale_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (company_id, cash_session_id)
        REFERENCES public.cash_sessions(company_id, id) ON DELETE RESTRICT
);

-- ---------------------------------------------------------------------
-- 8. TRIGGERS D'IMMUABILITÉ ET VERROUILLAGE SÉRIALISÉ
-- ---------------------------------------------------------------------

-- Interdiction d'insérer directement une vente completed ou cancelled
CREATE OR REPLACE FUNCTION public.trg_sales_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Une vente ne peut être créée directement au statut %', NEW.status;
    END IF;
    IF NEW.status IS NULL THEN
        NEW.status := 'pending';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_before_insert
BEFORE INSERT ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.trg_sales_insert_guard();

-- Machine à états des ventes corrigée : autorise les mises à jour en mode pending
CREATE OR REPLACE FUNCTION public.trg_sales_state_machine()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status = 'cancelled' THEN
        RAISE EXCEPTION 'Une vente annulée est définitivement verrouillée';
    END IF;

    IF OLD.status = 'completed' THEN
        IF NEW.status = 'cancelled' THEN
            -- Seule l'annulation est permise, les montants doivent rester intacts
            IF (OLD.subtotal, OLD.discount_amount, OLD.tax_amount, OLD.total_amount) 
               IS DISTINCT FROM 
               (NEW.subtotal, NEW.discount_amount, NEW.tax_amount, NEW.total_amount) THEN
                RAISE EXCEPTION 'Interdiction de modifier les montants lors de l''annulation de la vente %', OLD.invoice_number;
            END IF;
            RETURN NEW;
        ELSE
            RAISE EXCEPTION 'Une vente validée ne peut être modifiée (seule l''annulation est permise)';
        END IF;
    END IF;

    IF OLD.status = 'draft' AND NEW.status NOT IN ('draft', 'pending', 'cancelled') THEN
        RAISE EXCEPTION 'Transition invalide depuis draft vers %', NEW.status;
    END IF;

    -- Correction essentielle : autorise les modifications tant que le statut reste pending
    IF OLD.status = 'pending' AND NEW.status NOT IN ('pending', 'completed', 'cancelled') THEN
        RAISE EXCEPTION 'Transition invalide depuis pending vers %', NEW.status;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sales_state_machine
BEFORE UPDATE ON public.sales
FOR EACH ROW EXECUTE FUNCTION public.trg_sales_state_machine();

-- Verrouillage FOR SHARE de la vente parente lors de modifications sur articles ou paiements
CREATE OR REPLACE FUNCTION public.trg_lock_sale_on_child_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_sale_id UUID;
    v_comp_id UUID;
    v_status VARCHAR(20);
BEGIN
    v_sale_id := COALESCE(NEW.sale_id, OLD.sale_id);
    v_comp_id := COALESCE(NEW.company_id, OLD.company_id);

    SELECT status INTO v_status
    FROM public.sales
    WHERE id = v_sale_id AND company_id = v_comp_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vente parente introuvable';
    END IF;

    IF v_status IN ('completed', 'cancelled') THEN
        RAISE EXCEPTION 'Modification interdite : la vente % est clôturée', v_sale_id;
    END IF;

    -- Contrôle de rattachement caisse pour les paiements en espèces
    IF TG_TABLE_NAME = 'payments' AND TG_OP IN ('INSERT', 'UPDATE') THEN
        IF NEW.payment_method = 'cash' THEN
            IF NEW.cash_session_id IS NULL THEN
                RAISE EXCEPTION 'Un paiement en espèces exige obligatoirement une session de caisse';
            END IF;

            PERFORM 1 FROM public.cash_sessions
            WHERE id = NEW.cash_session_id AND company_id = NEW.company_id AND status = 'open'
            FOR SHARE;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'La session de caisse pour ce paiement est fermée ou invalide';
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_sale_items_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.sale_items
FOR EACH ROW EXECUTE FUNCTION public.trg_lock_sale_on_child_change();

CREATE TRIGGER trg_payments_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.trg_lock_sale_on_child_change();

-- Validation stricte des remboursements (Plafond, session cash, verrou FOR UPDATE)
CREATE OR REPLACE FUNCTION public.trg_validate_refund()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_pay_amount NUMERIC(14,2);
    v_already_refunded NUMERIC(14,2);
BEGIN
    -- Verrouille le paiement pour sérialiser les remboursements concurrents
    SELECT amount INTO v_pay_amount
    FROM public.payments
    WHERE id = NEW.payment_id AND company_id = NEW.company_id
    FOR UPDATE;

    SELECT COALESCE(SUM(amount), 0) INTO v_already_refunded
    FROM public.refunds
    WHERE payment_id = NEW.payment_id
      AND company_id = NEW.company_id
      AND status IN ('pending', 'recorded_accounting_only', 'processing_gateway', 'completed')
      AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::UUID);

    IF (v_already_refunded + NEW.amount) > v_pay_amount THEN
        RAISE EXCEPTION 'Dépassement interdit : total remboursé (%) + demande (%) > montant payé (%)',
            v_already_refunded, NEW.amount, v_pay_amount;
    END IF;

    IF NEW.refund_method = 'cash' THEN
        IF NEW.cash_session_id IS NULL THEN
            RAISE EXCEPTION 'Remboursement en espèces exige une session de caisse';
        END IF;

        PERFORM 1 FROM public.cash_sessions
        WHERE id = NEW.cash_session_id AND company_id = NEW.company_id AND status = 'open'
        FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Session de caisse fermée ou invalide';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_refund_guard
BEFORE INSERT OR UPDATE OF amount, status, cash_session_id ON public.refunds
FOR EACH ROW EXECUTE FUNCTION public.trg_validate_refund();

-- ---------------------------------------------------------------------
-- 9. FONCTIONS MÉTIER DE VENTE ET ANNULATION
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.complete_sale(p_sale_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_sale public.sales%ROWTYPE;
    v_item RECORD;
    v_recipe RECORD;
    v_subtotal NUMERIC(14,2);
    v_tax_rate NUMERIC(5,2);
    v_taxable_base NUMERIC(14,2);
    v_tax NUMERIC(14,2);
    v_total NUMERIC(14,2);
    v_paid NUMERIC(14,2);
    v_recipe_cost NUMERIC(14,4);
    v_ing_tracking VARCHAR(20);
BEGIN
    SELECT * INTO v_sale
    FROM public.sales
    WHERE id = p_sale_id AND company_id = public.app_current_company_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vente introuvable ou accès refusé';
    END IF;

    IF v_sale.status <> 'pending' THEN
        RAISE EXCEPTION 'Seules les ventes en attente peuvent être validées';
    END IF;

    -- Recalcul strict et validation des sous-totaux
    SELECT COALESCE(SUM(subtotal), 0) INTO v_subtotal
    FROM public.sale_items WHERE sale_id = v_sale.id AND company_id = v_sale.company_id;

    IF v_subtotal <= 0 THEN
        RAISE EXCEPTION 'Impossible de valider une vente sans articles';
    END IF;

    -- Contrôle du plafond de remise
    IF v_sale.discount_amount > v_subtotal THEN
        RAISE EXCEPTION 'Remise supérieure au sous-total (remise: %, sous-total: %)', v_sale.discount_amount, v_subtotal;
    END IF;

    SELECT default_tax_rate INTO v_tax_rate FROM public.companies WHERE id = v_sale.company_id;
    v_taxable_base := v_subtotal - v_sale.discount_amount;
    v_tax := ROUND((v_taxable_base * COALESCE(v_tax_rate, 0) / 100), 2);
    v_total := v_taxable_base + v_tax;

    -- Verrouillage des paiements puis calcul de l'encaissé
    PERFORM 1 FROM public.payments
    WHERE sale_id = v_sale.id AND company_id = v_sale.company_id
    FOR UPDATE;

    SELECT COALESCE(SUM(amount), 0) INTO v_paid
    FROM public.payments
    WHERE sale_id = v_sale.id AND company_id = v_sale.company_id;

    IF v_paid < v_total THEN
        RAISE EXCEPTION 'Paiement insuffisant : perçu (%) < montant dû (%)', v_paid, v_total;
    END IF;

    IF v_paid > v_total THEN
        RAISE EXCEPTION 'Trop-perçu non régularisé : montant encaissé (%) supérieur au total dû (%)', v_paid, v_total;
    END IF;

    -- Déstockage ordonné (anti-deadlock) selon le mode inventory_tracking
    FOR v_item IN
        SELECT si.*, p.inventory_tracking, p.cost_price AS catalog_cost
        FROM public.sale_items si
        JOIN public.products p ON p.id = si.product_id AND p.company_id = si.company_id
        WHERE si.sale_id = v_sale.id AND si.company_id = v_sale.company_id
        ORDER BY si.product_id ASC
    LOOP
        IF v_item.inventory_tracking = 'none' THEN
            -- Service : aucun mouvement de stock
            UPDATE public.sale_items SET unit_cost_snapshot = 0 WHERE id = v_item.id;
        ELSIF v_item.inventory_tracking = 'recipe_on_sale' THEN
            -- Déstockage des ingrédients selon la recette active
            SELECT * INTO v_recipe
            FROM public.recipes
            WHERE finished_product_id = v_item.product_id 
              AND company_id = v_sale.company_id 
              AND is_active = TRUE;

            IF NOT FOUND THEN
                RAISE EXCEPTION 'Fiche technique active manquante pour le produit %', v_item.product_id;
            END IF;

            SELECT COALESCE(SUM((ri.quantity_required / v_recipe.output_quantity) * p_ing.cost_price), 0)
            INTO v_recipe_cost
            FROM public.recipe_ingredients ri
            JOIN public.products p_ing ON p_ing.id = ri.ingredient_id AND p_ing.company_id = ri.company_id
            WHERE ri.recipe_id = v_recipe.id AND ri.company_id = v_sale.company_id;

            UPDATE public.sale_items SET unit_cost_snapshot = v_recipe_cost WHERE id = v_item.id;

            -- Décrémente uniquement les ingrédients qui ont un suivi de stock actif
            INSERT INTO public.stock_movements (
                company_id, product_id, user_id, movement_type, quantity_delta,
                source_type, source_id, source_line_id, notes
            )
            SELECT
                v_sale.company_id, ri.ingredient_id, v_sale.user_id, 'recipe_out',
                -(ri.quantity_required / v_recipe.output_quantity * v_item.quantity),
                'sale', v_sale.id, v_item.id, 'Sortie recette vente ' || v_sale.invoice_number
            FROM public.recipe_ingredients ri
            JOIN public.products ping ON ping.id = ri.ingredient_id AND ping.company_id = ri.company_id
            WHERE ri.recipe_id = v_recipe.id 
              AND ri.company_id = v_sale.company_id
              AND ping.inventory_tracking <> 'none'
            ORDER BY ri.ingredient_id ASC;
        ELSE
            -- Direct : produit fini décrémenté directement
            UPDATE public.sale_items SET unit_cost_snapshot = v_item.catalog_cost WHERE id = v_item.id;

            INSERT INTO public.stock_movements (
                company_id, product_id, user_id, movement_type, quantity_delta,
                source_type, source_id, source_line_id, notes
            )
            VALUES (
                v_sale.company_id, v_item.product_id, v_sale.user_id, 'sale_out',
                -v_item.quantity, 'sale', v_sale.id, v_item.id, 'Sortie produit vente ' || v_sale.invoice_number
            );
        END IF;
    END LOOP;

    -- Finalisation atomique
    UPDATE public.sales
    SET subtotal = v_subtotal,
        tax_amount = v_tax,
        total_amount = v_total,
        status = 'completed',
        completed_at = NOW()
    WHERE id = v_sale.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_sale(p_sale_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_sale public.sales%ROWTYPE;
    v_mov RECORD;
    v_pay RECORD;
    v_open_session_id UUID;
BEGIN
    SELECT * INTO v_sale
    FROM public.sales
    WHERE id = p_sale_id AND company_id = public.app_current_company_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Vente introuvable ou accès refusé';
    END IF;

    IF v_sale.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cette vente est déjà annulée';
    END IF;

    IF v_sale.status = 'completed' THEN
        -- 1. Restitution exacte du stock déduit
        FOR v_mov IN
            SELECT * FROM public.stock_movements
            WHERE company_id = v_sale.company_id
              AND source_type = 'sale'
              AND source_id = v_sale.id
        LOOP
            INSERT INTO public.stock_movements (
                company_id, product_id, user_id, movement_type, quantity_delta,
                source_type, source_id, source_line_id, notes
            )
            VALUES (
                v_sale.company_id, v_mov.product_id, public.app_current_user_id(),
                'sale_reversal', -v_mov.quantity_delta, 'sale_cancellation',
                v_sale.id, v_mov.source_line_id, 'Annulation vente ' || v_sale.invoice_number
            );
        END LOOP;

        -- 2. Traitement des remboursements
        SELECT id INTO v_open_session_id
        FROM public.cash_sessions
        WHERE company_id = v_sale.company_id AND status = 'open'
        FOR UPDATE;

        FOR v_pay IN
            SELECT * FROM public.payments
            WHERE company_id = v_sale.company_id AND sale_id = v_sale.id
            FOR UPDATE
        LOOP
            IF v_pay.payment_method = 'cash' THEN
                IF v_open_session_id IS NULL THEN
                    RAISE EXCEPTION 'Impossible d''annuler une vente payée en espèces sans session de caisse ouverte';
                END IF;

                INSERT INTO public.refunds (
                    company_id, sale_id, payment_id, cash_session_id, amount,
                    refund_method, status, reason, created_by, processed_at
                )
                VALUES (
                    v_sale.company_id, v_sale.id, v_pay.id, v_open_session_id, v_pay.amount,
                    'cash', 'completed', p_reason, public.app_current_user_id(), NOW()
                );
            ELSE
                INSERT INTO public.refunds (
                    company_id, sale_id, payment_id, amount,
                    refund_method, status, reason, created_by
                )
                VALUES (
                    v_sale.company_id, v_sale.id, v_pay.id, v_pay.amount,
                    v_pay.payment_method, 'recorded_accounting_only', p_reason, public.app_current_user_id()
                );
            END IF;
        END LOOP;
    END IF;

    UPDATE public.sales
    SET status = 'cancelled',
        notes = COALESCE(notes, '') || ' [ANNULÉE : ' || COALESCE(p_reason, 'Sans motif') || ']'
    WHERE id = v_sale.id;
END;
$$;

-- ---------------------------------------------------------------------
-- 10. ACHATS, FOURNISSEURS ET CALCUL DU PMP
-- ---------------------------------------------------------------------
CREATE TABLE public.suppliers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    address TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id)
);

CREATE TABLE public.purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    supplier_id UUID,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    reference VARCHAR(100),
    notes TEXT,
    total_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    status VARCHAR(20) NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ordered', 'received', 'cancelled')),
    purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    received_at TIMESTAMPTZ,

    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, supplier_id) REFERENCES public.suppliers(company_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.purchase_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    purchase_id UUID NOT NULL,
    product_id UUID NOT NULL,
    quantity NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
    unit_cost NUMERIC(14,4) NOT NULL CHECK (unit_cost >= 0),
    subtotal NUMERIC(14,2) NOT NULL CHECK (subtotal >= 0),

    CONSTRAINT chk_purchase_items_subtotal CHECK (subtotal = ROUND(quantity * unit_cost, 2)),

    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, purchase_id) REFERENCES public.purchases(company_id, id) ON DELETE CASCADE,
    FOREIGN KEY (company_id, product_id) REFERENCES public.products(company_id, id) ON DELETE RESTRICT
);

-- Triggers de protection des achats et des lignes d'achats
-- 1) Interdiction d'insérer directement un achat au statut received ou cancelled
CREATE OR REPLACE FUNCTION public.trg_purchases_insert_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.status IN ('received', 'cancelled') THEN
        RAISE EXCEPTION 'Un achat ne peut être créé directement au statut %', NEW.status;
    END IF;
    IF NEW.status IS NULL THEN
        NEW.status := 'draft';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_purchases_before_insert
BEFORE INSERT ON public.purchases
FOR EACH ROW EXECUTE FUNCTION public.trg_purchases_insert_guard();

-- 2) Garde d'état UPDATE sur purchases :
--    - Première barrière : restogest_app n'a aucun GRANT UPDATE sur status et received_at.
--    - Deuxième barrière (y compris contre un admin/superuser) : le passage à 'received'
--      exige un jeton SHA-256 à usage unique signé avec app_security_config.hmac_secret
--      par receive_purchase(), sans aucune dépendance fragile à current_user ni GUC booléen.
CREATE OR REPLACE FUNCTION public.trg_purchases_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_secret TEXT;
    v_token TEXT;
    v_expected TEXT;
BEGIN
    IF OLD.status = 'received' THEN
        RAISE EXCEPTION 'Un achat déjà réceptionné est strictement immuable';
    END IF;

    IF OLD.status = 'cancelled' THEN
        RAISE EXCEPTION 'Un achat annulé est définitivement verrouillé';
    END IF;

    IF NEW.status = 'received' AND OLD.status <> 'received' THEN
        IF OLD.status <> 'ordered' THEN
            RAISE EXCEPTION 'Un achat ne peut être réceptionné que depuis le statut ordered';
        END IF;

        v_token := NULLIF(current_setting('app.receive_purchase_token', true), '');
        SELECT hmac_secret INTO v_secret FROM public.app_security_config WHERE id = 1;

        v_expected := encode(
            sha256((
                v_secret || '|RECEIVE_PURCHASE|' || NEW.id::TEXT || '|' ||
                pg_backend_pid()::TEXT || '|' || transaction_timestamp()::TEXT || '|' || v_secret
            )::bytea),
            'hex'
        );

        IF v_token IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'La réception d''un achat doit obligatoirement être effectuée via la fonction receive_purchase()';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_purchases_state_guard
BEFORE UPDATE ON public.purchases
FOR EACH ROW EXECUTE FUNCTION public.trg_purchases_guard();

CREATE OR REPLACE FUNCTION public.trg_lock_purchase_on_item_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_purch_id UUID;
    v_comp_id UUID;
    v_status VARCHAR(20);
BEGIN
    v_purch_id := COALESCE(NEW.purchase_id, OLD.purchase_id);
    v_comp_id := COALESCE(NEW.company_id, OLD.company_id);

    SELECT status INTO v_status
    FROM public.purchases
    WHERE id = v_purch_id AND company_id = v_comp_id
    FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Achat parent introuvable';
    END IF;

    IF v_status IN ('received', 'cancelled') THEN
        RAISE EXCEPTION 'Modification interdite : l''achat % est clôturé (statut: %)', v_purch_id, v_status;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_purchase_items_lock
BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_items
FOR EACH ROW EXECUTE FUNCTION public.trg_lock_purchase_on_item_change();

-- Réception d'achat sérialisée avec calcul exact du PMP
CREATE OR REPLACE FUNCTION public.receive_purchase(p_purchase_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_purchase public.purchases%ROWTYPE;
    v_item RECORD;
    v_cur_qty NUMERIC(14,3);
    v_cur_cost NUMERIC(14,4);
    v_new_cost NUMERIC(14,4);
    v_total_calc NUMERIC(14,2);
    v_secret TEXT;
    v_auth_token TEXT;
BEGIN
    SELECT * INTO v_purchase
    FROM public.purchases
    WHERE id = p_purchase_id AND company_id = public.app_current_company_id()
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Achat introuvable ou accès refusé';
    END IF;

    IF v_purchase.status <> 'ordered' THEN
        RAISE EXCEPTION 'Seuls les achats au statut ordered peuvent être réceptionnés';
    END IF;

    -- Traitement ordonné des lignes (anti-deadlock)
    FOR v_item IN
        SELECT pi.*, p.inventory_tracking
        FROM public.purchase_items pi
        JOIN public.products p ON p.id = pi.product_id AND p.company_id = pi.company_id
        WHERE pi.purchase_id = v_purchase.id AND pi.company_id = v_purchase.company_id
        ORDER BY pi.product_id ASC
    LOOP
        IF v_item.quantity <= 0 THEN
            RAISE EXCEPTION 'Quantité reçue invalide (%)', v_item.quantity;
        END IF;

        IF v_item.inventory_tracking <> 'none' THEN
            SELECT cost_price INTO v_cur_cost
            FROM public.products
            WHERE id = v_item.product_id AND company_id = v_purchase.company_id
            FOR UPDATE;

            INSERT INTO public.stock_levels (company_id, product_id, current_quantity, updated_at)
            VALUES (v_purchase.company_id, v_item.product_id, 0, NOW())
            ON CONFLICT (company_id, product_id) DO NOTHING;

            SELECT current_quantity INTO v_cur_qty
            FROM public.stock_levels
            WHERE company_id = v_purchase.company_id AND product_id = v_item.product_id
            FOR UPDATE;

            v_cur_qty := COALESCE(v_cur_qty, 0);
            v_cur_cost := COALESCE(v_cur_cost, 0);

            -- Formule officielle du Prix Moyen Pondéré (PMP)
            IF v_cur_qty <= 0 THEN
                v_new_cost := v_item.unit_cost;
            ELSE
                v_new_cost := ((v_cur_qty * v_cur_cost) + (v_item.quantity * v_item.unit_cost))
                              / (v_cur_qty + v_item.quantity);
            END IF;

            UPDATE public.products
            SET cost_price = ROUND(v_new_cost, 4), updated_at = NOW()
            WHERE id = v_item.product_id AND company_id = v_purchase.company_id;

            INSERT INTO public.stock_movements (
                company_id, product_id, user_id, movement_type, quantity_delta,
                source_type, source_id, source_line_id, notes
            )
            VALUES (
                v_purchase.company_id, v_item.product_id, v_purchase.user_id, 'purchase_in',
                v_item.quantity, 'purchase', v_purchase.id, v_item.id, 'Réception achat ' || COALESCE(v_purchase.reference, '')
            );
        END IF;
    END LOOP;

    SELECT COALESCE(SUM(subtotal), 0) INTO v_total_calc
    FROM public.purchase_items WHERE purchase_id = v_purchase.id;

    -- Jeton cryptographique à usage unique vérifié par trg_purchases_guard()
    SELECT hmac_secret INTO v_secret FROM public.app_security_config WHERE id = 1;
    v_auth_token := encode(
        sha256((
            v_secret || '|RECEIVE_PURCHASE|' || v_purchase.id::TEXT || '|' ||
            pg_backend_pid()::TEXT || '|' || transaction_timestamp()::TEXT || '|' || v_secret
        )::bytea),
        'hex'
    );
    PERFORM set_config('app.receive_purchase_token', v_auth_token, true);

    UPDATE public.purchases
    SET total_amount = v_total_calc,
        status = 'received',
        received_at = NOW()
    WHERE id = v_purchase.id;

    -- Purge immédiate du jeton après l'UPDATE
    PERFORM set_config('app.receive_purchase_token', '', true);
END;
$$;

-- Annulation sécurisée d'une commande d'achat (non réceptionnée)
CREATE OR REPLACE FUNCTION public.cancel_purchase(
    p_purchase_id UUID,
    p_reason TEXT DEFAULT NULL
)
RETURNS public.purchases
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_comp_id UUID;
    v_purchase public.purchases%ROWTYPE;
BEGIN
    v_comp_id := public.app_current_company_id();
    IF v_comp_id IS NULL THEN
        RAISE EXCEPTION 'Authentification requise';
    END IF;

    SELECT * INTO v_purchase
    FROM public.purchases
    WHERE id = p_purchase_id AND company_id = v_comp_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Achat introuvable ou accès refusé';
    END IF;

    IF v_purchase.status = 'received' THEN
        RAISE EXCEPTION 'Impossible d''annuler un achat déjà réceptionné (stock déjà intégré et PMP calculé)';
    END IF;

    IF v_purchase.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cet achat est déjà annulé';
    END IF;

    UPDATE public.purchases
    SET status = 'cancelled'
    WHERE id = v_purchase.id
    RETURNING * INTO v_purchase;

    RETURN v_purchase;
END;
$$;

-- Ajustement manuel de stock (pertes, casse, inventaire, production interne)
CREATE OR REPLACE FUNCTION public.record_stock_adjustment(
    p_product_id UUID,
    p_movement_type VARCHAR,
    p_quantity_delta NUMERIC,
    p_notes TEXT DEFAULT NULL
)
RETURNS public.stock_movements
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_comp_id UUID;
    v_user_id UUID;
    v_result public.stock_movements%ROWTYPE;
    v_delta NUMERIC(14,3);
BEGIN
    v_comp_id := public.app_current_company_id();
    v_user_id := public.app_current_user_id();

    IF v_comp_id IS NULL THEN
        RAISE EXCEPTION 'Authentification requise pour ajuster le stock';
    END IF;

    IF p_movement_type NOT IN ('loss', 'adjustment', 'production_in') THEN
        RAISE EXCEPTION 'Type de mouvement manuel non autorisé (%) : seuls loss, adjustment et production_in sont permis', p_movement_type;
    END IF;

    IF p_quantity_delta = 0 THEN
        RAISE EXCEPTION 'La variation de stock ne peut pas être nulle';
    END IF;

    -- Pour loss, la quantité doit être négative
    IF p_movement_type = 'loss' AND p_quantity_delta > 0 THEN
        v_delta := -p_quantity_delta;
    ELSE
        v_delta := p_quantity_delta;
    END IF;

    INSERT INTO public.stock_movements (
        company_id, product_id, user_id, movement_type, quantity_delta,
        source_type, notes
    )
    VALUES (
        v_comp_id, p_product_id, v_user_id, p_movement_type, v_delta,
        'manual', p_notes
    )
    RETURNING * INTO v_result;

    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------
-- 11. DÉPENSES ET CLÔTURE DE CAISSE
-- ---------------------------------------------------------------------
CREATE TABLE public.expenses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
    cash_session_id UUID,
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    category VARCHAR(100) NOT NULL,
    amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    description TEXT,
    expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company_id, id),
    FOREIGN KEY (company_id, cash_session_id)
        REFERENCES public.cash_sessions(company_id, id) ON DELETE RESTRICT
);

-- Validation des dépenses sur caisse ouverte
CREATE OR REPLACE FUNCTION public.trg_expense_cash_session()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
    IF NEW.cash_session_id IS NOT NULL THEN
        PERFORM 1 FROM public.cash_sessions
        WHERE id = NEW.cash_session_id AND company_id = NEW.company_id AND status = 'open'
        FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'La session de caisse pour cette dépense est fermée ou invalide';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_expense_cash
BEFORE INSERT OR UPDATE ON public.expenses
FOR EACH ROW EXECUTE FUNCTION public.trg_expense_cash_session();

-- Clôture de caisse avec verrouillage exclusif
CREATE OR REPLACE FUNCTION public.close_cash_session(p_session_id UUID, p_actual_amount NUMERIC(14,2))
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_session public.cash_sessions%ROWTYPE;
    v_cash_in NUMERIC(14,2);
    v_cash_refunds NUMERIC(14,2);
    v_cash_expenses NUMERIC(14,2);
    v_expected NUMERIC(14,2);
BEGIN
    IF p_actual_amount IS NULL OR p_actual_amount < 0 THEN
        RAISE EXCEPTION 'Le montant de clôture réel doit être positif ou nul';
    END IF;

    SELECT * INTO v_session
    FROM public.cash_sessions
    WHERE id = p_session_id AND company_id = public.app_current_company_id()
    FOR UPDATE;

    IF NOT FOUND OR v_session.status <> 'open' THEN
        RAISE EXCEPTION 'Session de caisse introuvable ou déjà fermée';
    END IF;

    SELECT COALESCE(SUM(amount), 0) INTO v_cash_in
    FROM public.payments
    WHERE company_id = v_session.company_id AND cash_session_id = v_session.id AND payment_method = 'cash';

    SELECT COALESCE(SUM(amount), 0) INTO v_cash_refunds
    FROM public.refunds
    WHERE company_id = v_session.company_id AND cash_session_id = v_session.id AND refund_method = 'cash' AND status = 'completed';

    SELECT COALESCE(SUM(amount), 0) INTO v_cash_expenses
    FROM public.expenses
    WHERE company_id = v_session.company_id AND cash_session_id = v_session.id;

    v_expected := v_session.opening_amount + v_cash_in - v_cash_refunds - v_cash_expenses;

    UPDATE public.cash_sessions
    SET status = 'closed',
        closed_by = public.app_current_user_id(),
        closed_at = NOW(),
        expected_closing_amount = v_expected,
        actual_closing_amount = p_actual_amount,
        difference_amount = p_actual_amount - v_expected
    WHERE id = v_session.id;
END;
$$;

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
    ELSE
        -- Environnement cloud managé sans SUPERUSER (ex: Neon / Supabase) :
        -- autoriser le rôle propriétaire courant à exécuter SET LOCAL ROLE restogest_app
        EXECUTE format('GRANT restogest_app TO %I', current_user);

        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolbypassrls = TRUE) THEN
            -- Sans BYPASSRLS disponible, désactiver uniquement FORCE sur le propriétaire DDL
            -- afin que les fonctions SECURITY DEFINER fonctionnent tout en maintenant RLS pour restogest_app
            ALTER TABLE public.companies NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.roles NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.company_users NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.categories NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.products NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.recipes NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.recipe_ingredients NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.stock_levels NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.stock_movements NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.sales NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.sale_items NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.payments NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.refunds NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.suppliers NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.purchases NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.purchase_items NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.expenses NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.cash_sessions NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.customers NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.company_subscriptions NO FORCE ROW LEVEL SECURITY;
            ALTER TABLE public.audit_logs NO FORCE ROW LEVEL SECURITY;
        END IF;
    END IF;
END $$;

COMMIT;
