-- =====================================================================
-- RESTOGEST V1 - Migration 001 : Roles PostgreSQL, Configuration Securite, Entreprises, Utilisateurs & Contexte Signe
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. CRÉATION EXPLICITE DES RÔLES ET GESTION DES PRIVILÈGES (FAIL-CLOSED)
-- ---------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'restogest_owner') THEN
        CREATE ROLE restogest_owner WITH LOGIN CREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'restogest_admin') THEN
        CREATE ROLE restogest_admin WITH LOGIN BYPASSRLS;
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
