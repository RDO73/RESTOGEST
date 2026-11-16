-- =====================================================================
-- RESTOGEST V1 - SUITE COMPLÈTE DE TESTS AUTOMATISÉS (40 SCÉNARIOS)
-- Version cible : PostgreSQL 14.0+
-- Prérequis : Exécution sous postgres ou restogest_admin (pour le setup
--             de fixtures et la bascule réelle SET LOCAL ROLE restogest_app)
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- DOMAINE 1 : AUTHENTIFICATION, SESSIONS ET ANTI-USURPATION (T01 - T08)
-- ---------------------------------------------------------------------

-- TEST 01 : Contexte vide ou inexistant (doit renvoyer NULL - Fail-Closed)
DO $$
BEGIN
    PERFORM set_config('app.session_id', '', true);
    PERFORM set_config('app.session_user_id', '', true);
    PERFORM set_config('app.session_company_id', '', true);
    PERFORM set_config('app.session_signature', '', true);

    IF app_current_company_id() IS NOT NULL OR app_current_user_id() IS NOT NULL THEN
        RAISE EXCEPTION 'T01 Échec : Le contexte doit renvoyer NULL sans paramètres vérifiés';
    END IF;
    RAISE NOTICE 'T01 RÉUSSI : Contexte vide renvoie NULL (Fail-closed)';
END $$;

-- TEST 02 : Faux token_hash dans set_session_context (doit échouer)
DO $$
BEGIN
    PERFORM set_session_context('hash_faux_inexistant_999999999999999999999999999999999999999999999', '11111111-1111-1111-1111-111111111111'::UUID);
    RAISE EXCEPTION 'T02 Échec : Faux token_hash aurait dû être rejeté';
EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%Authentification refusée%' THEN RAISE; END IF;
    RAISE NOTICE 'T02 RÉUSSI : Session inexistante rejetée par set_session_context';
END $$;

-- TEST 03 : Anti-usurpation GUC sous restogest_app (modification simple, multiple et révocation de session_id)
DO $$
DECLARE
    v_c1 UUID;
    v_u1 UUID;
    v_c2 UUID := gen_random_uuid();
    v_s1 UUID;
    v_token1 VARCHAR(64) := 'valid_token_t03_s1';
    v_token2 VARCHAR(64) := 'valid_token_t03_s2';
    v_val UUID;
BEGIN
    SELECT company_id, user_id INTO v_c1, v_u1
    FROM register_company_and_owner('Entreprise T03', 'restaurant', 'XOF', 'owner_t03@test.com', 'pwd_hash', 'Bob');

    -- Deux sessions actives simultanées pour le même couple (user, company)
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u1, v_c1, v_token1, NOW() + INTERVAL '1 hour')
    RETURNING id INTO v_s1;

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u1, v_c1, v_token2, NOW() + INTERVAL '1 hour');

    -- 1. Contexte légitime sous restogest_app
    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token1, v_c1);

        IF app_current_company_id() <> v_c1 OR app_current_user_id() <> v_u1 THEN
            RAISE EXCEPTION 'T03 Échec : Session légitime non reconnue sous restogest_app';
        END IF;

        -- 2. Altération simple d'un GUC (company_id)
        PERFORM set_config('app.session_company_id', v_c2::TEXT, true);
        IF app_current_company_id() IS NOT NULL THEN
            RAISE EXCEPTION 'T03 Échec critique : Altération simple de app.session_company_id acceptée';
        END IF;

        -- 3. Tentative d'altération simultanée des 4 GUC avec fausse signature
        PERFORM set_config('app.session_id', gen_random_uuid()::TEXT, true);
        PERFORM set_config('app.session_user_id', gen_random_uuid()::TEXT, true);
        PERFORM set_config('app.session_company_id', v_c2::TEXT, true);
        PERFORM set_config('app.session_signature', repeat('a', 64), true);

        v_val := app_current_company_id();
        IF v_val IS NOT NULL OR app_current_user_id() IS NOT NULL THEN
            RAISE EXCEPTION 'T03 Échec critique : Falsification simultanée des GUC acceptée';
        END IF;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    -- 4. Réactivation légitime de s1 puis révocation ciblée de s1 (s2 restant active !)
    PERFORM set_session_context(v_token1, v_c1);
    UPDATE public.user_sessions SET revoked_at = NOW() WHERE id = v_s1;

    BEGIN
        SET LOCAL ROLE restogest_app;
        -- Même si s2 existe pour le même (user_id, company_id), la révocation de s1 doit couper l'accès
        IF app_current_company_id() IS NOT NULL OR app_current_user_id() IS NOT NULL THEN
            RAISE EXCEPTION 'T03 Échec critique : Session s1 révoquée acceptée car s2 existe';
        END IF;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    RAISE NOTICE 'T03 RÉUSSI : Anti-usurpation GUC et révocation par session_id vérifiées sous restogest_app';
END $$;

-- TEST 04 : Interdiction d'accès direct à user_sessions et app_security_config sous SET ROLE restogest_app
DO $$
BEGIN
    IF has_table_privilege('restogest_app', 'public.user_sessions', 'SELECT') OR
       has_table_privilege('restogest_app', 'public.user_sessions', 'INSERT') OR
       has_table_privilege('restogest_app', 'public.user_sessions', 'UPDATE') OR
       has_table_privilege('restogest_app', 'public.user_sessions', 'DELETE') OR
       has_table_privilege('restogest_app', 'public.app_security_config', 'SELECT') THEN
        RAISE EXCEPTION 'T04 Échec : restogest_app ne doit avoir aucun droit sur user_sessions ni app_security_config';
    END IF;

    -- Tentative réelle de lecture de user_sessions sous SET LOCAL ROLE restogest_app
    BEGIN
        SET LOCAL ROLE restogest_app;
        EXECUTE 'SELECT 1 FROM public.user_sessions LIMIT 1';
        RESET ROLE;
        RAISE EXCEPTION 'T04 Échec critique : restogest_app a pu lire public.user_sessions';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    -- Tentative réelle de lecture du secret HMAC sous SET LOCAL ROLE restogest_app
    BEGIN
        SET LOCAL ROLE restogest_app;
        EXECUTE 'SELECT 1 FROM public.app_security_config LIMIT 1';
        RESET ROLE;
        RAISE EXCEPTION 'T04 Échec critique : restogest_app a pu lire public.app_security_config';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    RAISE NOTICE 'T04 RÉUSSI : Accès direct à user_sessions et app_security_config bloqué sous restogest_app';
END $$;

-- TEST 05 : Interdiction d'accès direct à user_credentials sous SET ROLE restogest_app
DO $$
BEGIN
    IF has_table_privilege('restogest_app', 'public.user_credentials', 'SELECT') OR
       has_table_privilege('restogest_app', 'public.user_credentials', 'INSERT') OR
       has_table_privilege('restogest_app', 'public.user_credentials', 'UPDATE') OR
       has_table_privilege('restogest_app', 'public.user_credentials', 'DELETE') THEN
        RAISE EXCEPTION 'T05 Échec : restogest_app ne doit avoir aucun droit sur user_credentials';
    END IF;

    BEGIN
        SET LOCAL ROLE restogest_app;
        EXECUTE 'SELECT 1 FROM public.user_credentials LIMIT 1';
        RESET ROLE;
        RAISE EXCEPTION 'T05 Échec critique : restogest_app a pu lire public.user_credentials';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    RAISE NOTICE 'T05 RÉUSSI : user_credentials inaccessible sous SET ROLE restogest_app';
END $$;

-- TEST 06 : Inscription autonome réussie via register_company_and_owner() (exécutable par restogest_app)
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_r UUID;
BEGIN
    BEGIN
        SET LOCAL ROLE restogest_app;
        SELECT company_id, user_id, role_id INTO v_c, v_u, v_r
        FROM register_company_and_owner('Boulangerie Test 06', 'pastry_shop', 'XOF', 'owner06@test.com', 'argon2_hash_06', 'Alice Test');
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_c IS NULL OR v_u IS NULL OR v_r IS NULL THEN
        RAISE EXCEPTION 'T06 Échec : Données d''inscription incomplètes';
    END IF;
    RAISE NOTICE 'T06 RÉUSSI : Inscription atomique complète entreprise/utilisateur/rôle sous restogest_app';
END $$;

-- TEST 07 : Inscription avec e-mail déjà existant (anti-usurpation de compte)
DO $$
BEGIN
    SET LOCAL ROLE restogest_app;
    PERFORM register_company_and_owner('Autre Entreprise', 'restaurant', 'XOF', 'owner06@test.com', 'hacker_hash', 'Hacker');
    RESET ROLE;
    RAISE EXCEPTION 'T07 Échec : L''e-mail en doublon aurait dû être bloqué';
EXCEPTION WHEN OTHERS THEN
    RESET ROLE;
    IF SQLERRM NOT LIKE '%Cet e-mail est déjà associé%' THEN RAISE; END IF;
    RAISE NOTICE 'T07 RÉUSSI : Doublon d''e-mail rejeté sans écrasement de compte existant';
END $$;

-- TEST 08 : Session révoquée ou expirée rejetée dans set_session_context
DO $$
DECLARE
    v_u UUID;
    v_c UUID;
    v_token_exp VARCHAR(64) := 'token_expire_t08';
    v_token_rev VARCHAR(64) := 'token_revoque_t08';
BEGIN
    SELECT id INTO v_u FROM public.users WHERE email = 'owner06@test.com';
    SELECT company_id INTO v_c FROM public.company_users WHERE user_id = v_u LIMIT 1;

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at, revoked_at)
    VALUES
        (v_u, v_c, v_token_exp, NOW() - INTERVAL '1 hour', NULL),
        (v_u, v_c, v_token_rev, NOW() + INTERVAL '1 hour', NOW() - INTERVAL '1 minute');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token_exp, v_c);
        RESET ROLE;
        RAISE EXCEPTION 'T08 Échec : Session expirée acceptée';
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        IF SQLERRM NOT LIKE '%session invalide, expirée ou révoquée%' THEN RAISE; END IF;
    END;

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token_rev, v_c);
        RESET ROLE;
        RAISE EXCEPTION 'T08 Échec : Session révoquée acceptée';
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        IF SQLERRM NOT LIKE '%session invalide, expirée ou révoquée%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'T08 RÉUSSI : Sessions expirée et révoquée rejetées sous restogest_app';
END $$;

-- ---------------------------------------------------------------------
-- DOMAINE 2 : ISOLATION MULTI-ENTREPRISES ET RLS (T09 - T13)
-- ---------------------------------------------------------------------

-- TEST 09 : Utilisateur non rattaché à l'entreprise ET jeton lié à une autre entreprise
DO $$
DECLARE
    v_u UUID;
    v_c1 UUID;
    v_c2 UUID := gen_random_uuid();
    v_r2 UUID := gen_random_uuid();
    v_token_c2 VARCHAR(64) := 'token_c2_fraud_t09';
    v_token_c1 VARCHAR(64) := 'token_c1_mismatch_t09';
BEGIN
    SELECT id INTO v_u FROM public.users WHERE email = 'owner06@test.com';
    SELECT company_id INTO v_c1 FROM public.company_users WHERE user_id = v_u LIMIT 1;

    INSERT INTO public.companies (id, name, business_type) VALUES (v_c2, 'Entreprise Inconnue T09', 'restaurant');
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u, v_c2, v_token_c2, NOW() + INTERVAL '1 hour');

    -- Cas A : utilisateur non rattaché à c2
    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token_c2, v_c2);
        RESET ROLE;
        RAISE EXCEPTION 'T09 Échec : Accès à une entreprise non rattachée accepté';
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        IF SQLERRM NOT LIKE '%non rattaché à l''entreprise%' THEN RAISE; END IF;
    END;

    -- Cas B : utilisateur rattaché à c2, mais tente d'utiliser une session émise pour c1 afin d'accéder à c2
    INSERT INTO public.roles (id, company_id, name) VALUES (v_r2, v_c2, 'Staff');
    INSERT INTO public.company_users (company_id, user_id, role_id, is_active) VALUES (v_c2, v_u, v_r2, TRUE);
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u, v_c1, v_token_c1, NOW() + INTERVAL '1 hour');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token_c1, v_c2);
        RESET ROLE;
        RAISE EXCEPTION 'T09 Échec : Jeton de C1 accepté pour C2';
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        IF SQLERRM NOT LIKE '%session non autorisée pour l''entreprise%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'T09 RÉUSSI : Contrôle strict d''appartenance et de liaison session-entreprise';
END $$;

-- TEST 10 : Absence de récursion infinie RLS sur company_users sous restogest_app
DO $$
DECLARE
    v_u UUID;
    v_c UUID;
    v_token VARCHAR(64) := 'token_t10';
    v_count INT;
BEGIN
    SELECT id INTO v_u FROM public.users WHERE email = 'owner06@test.com';
    SELECT company_id INTO v_c FROM public.company_users WHERE user_id = v_u LIMIT 1;

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        SELECT COUNT(*) INTO v_count FROM public.company_users WHERE user_id = v_u;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    RAISE NOTICE 'T10 RÉUSSI : RLS company_users exécutée sans récursion sous restogest_app (total: %)', v_count;
END $$;

-- TEST 11 : RLS étanche entre entreprises sur products sous restogest_app
DO $$
DECLARE
    v_c1 UUID;
    v_u1 UUID;
    v_c2 UUID;
    v_u2 UUID;
    v_token1 VARCHAR(64) := 'token_t11_c1';
    v_count INT;
BEGIN
    SELECT company_id, user_id INTO v_c1, v_u1
    FROM register_company_and_owner('C1 Produits', 'restaurant', 'XOF', 'c1_prod@test.com', 'h1', 'Owner 1');
    SELECT company_id, user_id INTO v_c2, v_u2
    FROM register_company_and_owner('C2 Produits', 'restaurant', 'XOF', 'c2_prod@test.com', 'h2', 'Owner 2');

    INSERT INTO public.products (company_id, name, product_type, unit)
    VALUES (v_c2, 'Recette Secrète C2', 'finished_good', 'u');

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u1, v_c1, v_token1, NOW() + INTERVAL '1 hour');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token1, v_c1);
        SELECT COUNT(*) INTO v_count FROM public.products WHERE company_id = v_c2;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'T11 Échec critique : C1 a pu lire les produits de C2 !';
    END IF;
    RAISE NOTICE 'T11 RÉUSSI : Isolation RLS étanche sur products sous restogest_app';
END $$;

-- TEST 12 : RLS étanche sur les ventes et articles sous restogest_app
DO $$
DECLARE
    v_c1 UUID;
    v_c2 UUID;
    v_s2 UUID := gen_random_uuid();
    v_token1 VARCHAR(64) := 'token_t12_c1';
    v_u1 UUID;
    v_count INT;
BEGIN
    SELECT id INTO v_c1 FROM public.companies WHERE name = 'C1 Produits';
    SELECT id INTO v_c2 FROM public.companies WHERE name = 'C2 Produits';
    SELECT id INTO v_u1 FROM public.users WHERE email = 'c1_prod@test.com';

    INSERT INTO public.sales (id, company_id, invoice_number, status)
    VALUES (v_s2, v_c2, 'FAC-C2-CONFIDENTIELLE', 'pending');

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u1, v_c1, v_token1, NOW() + INTERVAL '1 hour');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token1, v_c1);
        SELECT COUNT(*) INTO v_count FROM public.sales WHERE id = v_s2;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'T12 Échec critique : Vente de C2 visible par C1 !';
    END IF;
    RAISE NOTICE 'T12 RÉUSSI : Isolation RLS étanche sur sales sous restogest_app';
END $$;

-- TEST 13 : RLS étanche sur stock_levels sous restogest_app
DO $$
DECLARE
    v_c1 UUID;
    v_c2 UUID;
    v_u1 UUID;
    v_p2 UUID := gen_random_uuid();
    v_token1 VARCHAR(64) := 'token_t13_c1';
    v_count INT;
BEGIN
    SELECT id INTO v_c1 FROM public.companies WHERE name = 'C1 Produits';
    SELECT id INTO v_c2 FROM public.companies WHERE name = 'C2 Produits';
    SELECT id INTO v_u1 FROM public.users WHERE email = 'c1_prod@test.com';

    INSERT INTO public.products (id, company_id, name, product_type, unit)
    VALUES (v_p2, v_c2, 'Stock Secret C2', 'raw_material', 'kg');
    INSERT INTO public.stock_levels (company_id, product_id, current_quantity)
    VALUES (v_c2, v_p2, 50.000);

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u1, v_c1, v_token1, NOW() + INTERVAL '1 hour');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token1, v_c1);
        SELECT COUNT(*) INTO v_count FROM public.stock_levels WHERE company_id = v_c2;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_count <> 0 THEN
        RAISE EXCEPTION 'T13 Échec critique : Niveaux de stocks de C2 visibles par C1 !';
    END IF;
    RAISE NOTICE 'T13 RÉUSSI : Isolation RLS étanche sur les stocks sous restogest_app';
END $$;

-- ---------------------------------------------------------------------
-- DOMAINE 3 : RECETTES ET DÉTECTION SÉRIALISÉE DES CYCLES (T14 - T18)
-- ---------------------------------------------------------------------

-- TEST 14 : Auto-référence directe dans une recette (doit être refusée)
DO $$
DECLARE
    v_c UUID;
    v_p UUID := gen_random_uuid();
    v_r UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'C1 Produits';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Farine T14', 'raw_material', 'kg');
    INSERT INTO public.recipes (id, company_id, finished_product_id, name) VALUES (v_r, v_c, v_p, 'Recette Farine');

    BEGIN
        INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
        VALUES (v_c, v_r, v_p, 1);
        RAISE EXCEPTION 'T14 Échec : L''auto-référence directe aurait dû échouer';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Auto-référence directe interdite%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T14 RÉUSSI : Auto-référence directe rejetée avec message exact';
END $$;

-- TEST 15 : Cycle indirect A -> B -> C -> A
DO $$
DECLARE
    v_c UUID;
    v_pa UUID := gen_random_uuid();
    v_pb UUID := gen_random_uuid();
    v_pc UUID := gen_random_uuid();
    v_ra UUID := gen_random_uuid();
    v_rb UUID := gen_random_uuid();
    v_rc UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'C1 Produits';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES
    (v_pa, v_c, 'PA-T15', 'semi_finished', 'u'),
    (v_pb, v_c, 'PB-T15', 'semi_finished', 'u'),
    (v_pc, v_c, 'PC-T15', 'semi_finished', 'u');

    INSERT INTO public.recipes (id, company_id, finished_product_id, name) VALUES (v_ra, v_c, v_pa, 'RA');
    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES (v_c, v_ra, v_pb, 1);

    INSERT INTO public.recipes (id, company_id, finished_product_id, name) VALUES (v_rb, v_c, v_pb, 'RB');
    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES (v_c, v_rb, v_pc, 1);

    INSERT INTO public.recipes (id, company_id, finished_product_id, name) VALUES (v_rc, v_c, v_pc, 'RC');
    BEGIN
        INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES (v_c, v_rc, v_pa, 1);
        RAISE EXCEPTION 'T15 Échec : Cycle indirect non détecté';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Cycle de recette interdit détecté%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T15 RÉUSSI : Cycle indirect A -> B -> C -> A intercepté avant insertion';
END $$;

-- TEST 16 : Modification de finished_product_id créant un cycle
DO $$
DECLARE
    v_c UUID;
    v_p1 UUID := gen_random_uuid();
    v_p2 UUID := gen_random_uuid();
    v_r1 UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'C1 Produits';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p1, v_c, 'Prod1-T16', 'semi_finished', 'u'), (v_p2, v_c, 'Prod2-T16', 'semi_finished', 'u');
    INSERT INTO public.recipes (id, company_id, finished_product_id, name) VALUES (v_r1, v_c, v_p1, 'R1');
    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES (v_c, v_r1, v_p2, 1);

    BEGIN
        UPDATE public.recipes SET finished_product_id = v_p2 WHERE id = v_r1;
        RAISE EXCEPTION 'T16 Échec : Modification cyclique de recette non détectée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Cycle de recette interdit%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T16 RÉUSSI : Détection de cycle lors de la modification de la recette parente';
END $$;

-- TEST 17 : Insertion valide de recettes arborescentes sans cycle
DO $$
DECLARE
    v_c UUID;
    v_p_farine UUID := gen_random_uuid();
    v_p_pate UUID := gen_random_uuid();
    v_p_croissant UUID := gen_random_uuid();
    v_r_pate UUID := gen_random_uuid();
    v_r_croissant UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'C1 Produits';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES
    (v_p_farine, v_c, 'Farine T17', 'raw_material', 'kg'),
    (v_p_pate, v_c, 'Pâte Feuilletée', 'semi_finished', 'kg'),
    (v_p_croissant, v_c, 'Croissant Beurre', 'finished_good', 'u');

    INSERT INTO public.recipes (id, company_id, finished_product_id, name) VALUES (v_r_pate, v_c, v_p_pate, 'Recette Pâte');
    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES (v_c, v_r_pate, v_p_farine, 0.5);

    INSERT INTO public.recipes (id, company_id, finished_product_id, name) VALUES (v_r_croissant, v_c, v_p_croissant, 'Recette Croissant');
    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES (v_c, v_r_croissant, v_p_pate, 0.1);

    RAISE NOTICE 'T17 RÉUSSI : Arborescence de sous-recettes valide insérée avec succès';
END $$;

-- TEST 18 : Détection réelle de profondeur excessive (> 50 niveaux)
DO $$
DECLARE
    v_c UUID;
    v_prods UUID[];
    v_recs UUID[];
    i INT;
    v_pid UUID;
    v_rid UUID;
BEGIN
    SELECT company_id INTO v_c
    FROM register_company_and_owner('Entreprise T18 Profondeur', 'pastry_shop', 'XOF', 't18@test.com', 'h', 'Pâtissier');

    -- Créer 53 produits P[1..53] et 52 recettes R[1..52]
    FOR i IN 1..53 LOOP
        v_pid := gen_random_uuid();
        v_prods := array_append(v_prods, v_pid);
        INSERT INTO public.products (id, company_id, name, product_type, unit)
        VALUES (v_pid, v_c, 'Noeud-' || i, 'semi_finished', 'u');
    END LOOP;

    FOR i IN 1..52 LOOP
        v_rid := gen_random_uuid();
        v_recs := array_append(v_recs, v_rid);
        INSERT INTO public.recipes (id, company_id, finished_product_id, name)
        VALUES (v_rid, v_c, v_prods[i], 'Rec-' || i);
    END LOOP;

    -- Chaînage bottom-up : R52->P53, ..., R2->P3 (profondeur = 50 atteinte sur R2->P3)
    FOR i IN REVERSE 52..2 LOOP
        INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
        VALUES (v_c, v_recs[i], v_prods[i + 1], 1);
    END LOOP;

    -- Ajout du niveau 51 (R1 -> P2) : doit dépasser le plafond de 50
    BEGIN
        INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
        VALUES (v_c, v_recs[1], v_prods[2], 1);
        RAISE EXCEPTION 'T18 Échec : Profondeur > 50 niveaux autorisée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Profondeur maximale de sous-recettes (50) dépassée%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T18 RÉUSSI : Garde-fou de profondeur (> 50 niveaux) déclenché sur chaîne réelle';
END $$;

-- ---------------------------------------------------------------------
-- DOMAINE 4 : GESTION DES STOCKS, INVENTAIRE ET PMP (T19 - T24)
-- ---------------------------------------------------------------------

-- TEST 19 : Première sortie négative sans stock initial quand allow_negative_stock = FALSE
DO $$
DECLARE
    v_c UUID;
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'C1 Produits';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Produit Zero Stock', 'finished_good', 'u');

    BEGIN
        INSERT INTO public.stock_movements (company_id, product_id, movement_type, quantity_delta, notes)
        VALUES (v_c, v_p, 'sale_out', -5, 'Sortie sans stock');
        RAISE EXCEPTION 'T19 Échec : Sortie négative acceptée sans stock préalable';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Stock insuffisant%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T19 RÉUSSI : Premier mouvement négatif bloqué avec succès';
END $$;

-- TEST 20 : Interdiction de mouvement de stock si inventory_tracking = 'none'
DO $$
DECLARE
    v_c UUID;
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'C1 Produits';
    INSERT INTO public.products (id, company_id, name, product_type, inventory_tracking, unit)
    VALUES (v_p, v_c, 'Service Ménage', 'service', 'none', 'u');

    BEGIN
        INSERT INTO public.stock_movements (company_id, product_id, movement_type, quantity_delta, notes)
        VALUES (v_c, v_p, 'sale_out', -1, 'Mouvement interdit');
        RAISE EXCEPTION 'T20 Échec : Mouvement de stock autorisé sur produit sans suivi';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%suivi de stock est désactivé%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T20 RÉUSSI : Mouvement de stock bloqué pour produit sans suivi (none)';
END $$;

-- TEST 21 : Deux ajustements manuels successifs d'inventaire autorisés via record_stock_adjustment()
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t21';
    v_p UUID := gen_random_uuid();
    v_qty NUMERIC(14,3);
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'C1 Produits';
    SELECT id INTO v_u FROM public.users WHERE email = 'c1_prod@test.com';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Sucre Roux', 'raw_material', 'kg');

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        PERFORM record_stock_adjustment(v_p, 'adjustment', 10, 'Inventaire 1');
        PERFORM record_stock_adjustment(v_p, 'adjustment', 5, 'Inventaire 2');
        SELECT current_quantity INTO v_qty FROM public.stock_levels WHERE product_id = v_p AND company_id = v_c;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_qty <> 15.000 THEN
        RAISE EXCEPTION 'T21 Échec : Stock calculé % au lieu de 15.000', v_qty;
    END IF;
    RAISE NOTICE 'T21 RÉUSSI : Ajustements manuels multiples autorisés sans blocage d''idempotence';
END $$;

-- TEST 22 : Vente d'un plat recipe_on_sale sous restogest_app : déstockage automatique des ingrédients
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t22';
    v_ing UUID := gen_random_uuid();
    v_plat UUID := gen_random_uuid();
    v_rec UUID := gen_random_uuid();
    v_sale UUID := gen_random_uuid();
    v_ing_qty NUMERIC(14,3);
BEGIN
    SELECT company_id, user_id INTO v_c, v_u
    FROM register_company_and_owner('Resto T22', 'restaurant', 'XOF', 't22@test.com', 'h', 'Chef');

    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    INSERT INTO public.products (id, company_id, name, product_type, unit, cost_price)
    VALUES (v_ing, v_c, 'Steak Haché', 'raw_material', 'kg', 3000);
    INSERT INTO public.stock_levels (company_id, product_id, current_quantity) VALUES (v_c, v_ing, 10.000);

    INSERT INTO public.products (id, company_id, name, product_type, inventory_tracking, unit, selling_price)
    VALUES (v_plat, v_c, 'Burger Maison', 'finished_good', 'recipe_on_sale', 'portion', 5000);

    INSERT INTO public.recipes (id, company_id, finished_product_id, name, output_quantity)
    VALUES (v_rec, v_c, v_plat, 'Recette Burger', 1);
    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
    VALUES (v_c, v_rec, v_ing, 0.200);

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_sale, v_c, 'FAC-BURGER', 'pending');
        INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal)
        VALUES (v_c, v_sale, v_plat, 2, 5000, 10000);
        INSERT INTO public.payments (company_id, sale_id, payment_method, amount) VALUES (v_c, v_sale, 'card', 10000);
        PERFORM complete_sale(v_sale);
        SELECT current_quantity INTO v_ing_qty FROM public.stock_levels WHERE product_id = v_ing;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_ing_qty <> 9.600 THEN
        RAISE EXCEPTION 'T22 Échec : Stock ingrédient restant % au lieu de 9.600', v_ing_qty;
    END IF;
    RAISE NOTICE 'T22 RÉUSSI : Déstockage automatique des ingrédients validé sous restogest_app';
END $$;

-- TEST 23 : Calcul exact du PMP lors de la réception d'achat sous restogest_app
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t23';
    v_p UUID := gen_random_uuid();
    v_purch UUID := gen_random_uuid();
    v_cost NUMERIC(14,4);
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    SELECT id INTO v_u FROM public.users WHERE email = 't22@test.com';
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    INSERT INTO public.products (id, company_id, name, product_type, unit, cost_price)
    VALUES (v_p, v_c, 'Fromage Cheddar', 'raw_material', 'kg', 2000.00);
    INSERT INTO public.stock_levels (company_id, product_id, current_quantity) VALUES (v_c, v_p, 10.000);

    INSERT INTO public.purchases (id, company_id, status) VALUES (v_purch, v_c, 'ordered');
    INSERT INTO public.purchase_items (company_id, purchase_id, product_id, quantity, unit_cost, subtotal)
    VALUES (v_c, v_purch, v_p, 10.000, 4000.00, 40000.00);

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        PERFORM receive_purchase(v_purch);
        SELECT cost_price INTO v_cost FROM public.products WHERE id = v_p;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_cost <> 3000.0000 THEN
        RAISE EXCEPTION 'T23 Échec : PMP calculé % au lieu de 3000.0000', v_cost;
    END IF;
    RAISE NOTICE 'T23 RÉUSSI : Calcul exact du Prix Moyen Pondéré (3000.0000) sous restogest_app';
END $$;

-- TEST 24 : Interdiction réelle d'INSERT ou UPDATE direct sur stock_levels et stock_movements sous restogest_app
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_p UUID := gen_random_uuid();
    v_token VARCHAR(64) := 'token_t24';
BEGIN
    IF has_table_privilege('restogest_app', 'public.stock_levels', 'UPDATE') OR
       has_table_privilege('restogest_app', 'public.stock_movements', 'INSERT') THEN
        RAISE EXCEPTION 'T24 Échec : Privilèges d''écriture directe accordés sur les stocks à restogest_app';
    END IF;

    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    SELECT id INTO v_u FROM public.users WHERE email = 't22@test.com';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Test T24', 'raw_material', 'kg');
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        EXECUTE format('INSERT INTO public.stock_movements (company_id, product_id, movement_type, quantity_delta) VALUES (%L, %L, ''adjustment'', 100)', v_c, v_p);
        RESET ROLE;
        RAISE EXCEPTION 'T24 Échec critique : restogest_app a pu insérer dans stock_movements';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        EXECUTE format('UPDATE public.stock_levels SET current_quantity = 999 WHERE company_id = %L', v_c);
        RESET ROLE;
        RAISE EXCEPTION 'T24 Échec critique : restogest_app a pu modifier stock_levels';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    RAISE NOTICE 'T24 RÉUSSI : Écriture directe sur stock_levels et stock_movements bloquée sous restogest_app';
END $$;

-- ---------------------------------------------------------------------
-- DOMAINE 5 : VENTES, ARTICLES ET PAIEMENTS (T25 - T30)
-- ---------------------------------------------------------------------

-- TEST 25 : Insertion directe d'une vente terminée refusée
DO $$
DECLARE
    v_c UUID;
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    BEGIN
        INSERT INTO public.sales (company_id, invoice_number, status) VALUES (v_c, 'FAC-T25', 'completed');
        RAISE EXCEPTION 'T25 Échec : Insertion directe d''une vente completed autorisée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%ne peut être créée directement au statut completed%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T25 RÉUSSI : Création directe d''une vente au statut completed bloquée';
END $$;

-- TEST 26 : Immuabilité absolue des montants sur une vente validée (sous restogest_app et rôle privilégié)
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t26';
    v_s UUID := gen_random_uuid();
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    SELECT id INTO v_u FROM public.users WHERE email = 't22@test.com';
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    INSERT INTO public.products (id, company_id, name, product_type, inventory_tracking, unit, selling_price)
    VALUES (v_p, v_c, 'Plat T26', 'service', 'none', 'u', 1000);

    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T26', 'pending');
    INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal) VALUES (v_c, v_s, v_p, 1, 1000, 1000);
    INSERT INTO public.payments (company_id, sale_id, payment_method, amount) VALUES (v_c, v_s, 'card', 1000);

    PERFORM set_session_context(v_token, v_c);
    PERFORM complete_sale(v_s);

    -- Sous restogest_app : GRANT bloque total_amount (et even notes/discount est bloqué par trigger)
    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        EXECUTE format('UPDATE public.sales SET total_amount = 999999 WHERE id = %L', v_s);
        RESET ROLE;
        RAISE EXCEPTION 'T26 Échec : restogest_app a pu modifier total_amount';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    -- Sous rôle privilégié : trigger bloque toute altération de vente validée
    BEGIN
        UPDATE public.sales SET total_amount = 999999 WHERE id = v_s;
        RAISE EXCEPTION 'T26 Échec : Altération de montant autorisée sur vente clôturée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Une vente validée ne peut être modifiée%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T26 RÉUSSI : Immuabilité des montants d''une vente validée respectée';
END $$;

-- TEST 27 : Blocage d'ajout d'articles après validation de la vente (sous restogest_app)
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t27';
    v_s UUID := gen_random_uuid();
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    SELECT id INTO v_u FROM public.users WHERE email = 't22@test.com';
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    INSERT INTO public.products (id, company_id, name, product_type, inventory_tracking, unit) VALUES (v_p, v_c, 'Article T27', 'service', 'none', 'u');
    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T27', 'pending');
    INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal) VALUES (v_c, v_s, v_p, 1, 1000, 1000);
    INSERT INTO public.payments (company_id, sale_id, payment_method, amount) VALUES (v_c, v_s, 'card', 1000);

    PERFORM set_session_context(v_token, v_c);
    PERFORM complete_sale(v_s);

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal)
        VALUES (v_c, v_s, v_p, 1, 1000, 1000);
        RESET ROLE;
        RAISE EXCEPTION 'T27 Échec : Ajout d''article sur vente clôturée autorisé';
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        IF SQLERRM NOT LIKE '%Modification interdite : la vente % est clôturée%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T27 RÉUSSI : Modification des articles interdite après clôture sous restogest_app';
END $$;

-- TEST 28 : Cohérence arithmétique subtotal = quantity * unit_price
DO $$
DECLARE
    v_c UUID;
    v_s UUID := gen_random_uuid();
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Article T28', 'finished_good', 'u');
    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T28', 'pending');

    BEGIN
        INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal)
        VALUES (v_c, v_s, v_p, 2, 1000, 1500);
        RAISE EXCEPTION 'T28 Échec : Incohérence arithmétique de ligne acceptée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%chk_sale_items_subtotal%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T28 RÉUSSI : Contrainte arithmétique stricte sur subtotal des articles';
END $$;

-- TEST 29 : Remise supérieure au sous-total rejetée lors de la validation
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t29';
    v_s UUID := gen_random_uuid();
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    SELECT id INTO v_u FROM public.users WHERE email = 't22@test.com';
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');
    PERFORM set_session_context(v_token, v_c);

    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Article T29', 'finished_good', 'u');
    INSERT INTO public.sales (id, company_id, invoice_number, discount_amount, status) VALUES (v_s, v_c, 'FAC-T29', 5000, 'pending');
    INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal) VALUES (v_c, v_s, v_p, 1, 2000, 2000);
    INSERT INTO public.payments (company_id, sale_id, payment_method, amount) VALUES (v_c, v_s, 'card', 2000);

    BEGIN
        PERFORM complete_sale(v_s);
        RAISE EXCEPTION 'T29 Échec : Remise abusive acceptée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Remise supérieure au sous-total%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T29 RÉUSSI : Validation rejetée sur remise excédant le sous-total';
END $$;

-- TEST 30 : Validation d'une vente avec paiement insuffisant ou trop-perçu
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t30';
    v_s UUID := gen_random_uuid();
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    SELECT id INTO v_u FROM public.users WHERE email = 't22@test.com';
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');
    PERFORM set_session_context(v_token, v_c);

    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Article T30', 'finished_good', 'u');
    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T30', 'pending');
    INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal) VALUES (v_c, v_s, v_p, 1, 5000, 5000);
    INSERT INTO public.payments (company_id, sale_id, payment_method, amount) VALUES (v_c, v_s, 'card', 3000);

    BEGIN
        PERFORM complete_sale(v_s);
        RAISE EXCEPTION 'T30 Échec : Vente validée avec paiement insuffisant';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Paiement insuffisant%' THEN RAISE; END IF;
    END;

    -- Ajout de 3000 -> total encaissé = 6000 > 5000 (trop-perçu non régularisé)
    INSERT INTO public.payments (company_id, sale_id, payment_method, amount) VALUES (v_c, v_s, 'card', 3000);
    BEGIN
        PERFORM complete_sale(v_s);
        RAISE EXCEPTION 'T30 Échec : Vente validée avec trop-perçu non régularisé';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Trop-perçu non régularisé%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'T30 RÉUSSI : Paiement partiel et trop-perçu rejetés à la validation';
END $$;

-- ---------------------------------------------------------------------
-- DOMAINE 6 : CAISSE, REMBOURSEMENTS ET DÉPENSES (T31 - T36)
-- ---------------------------------------------------------------------

-- TEST 31 : Paiement en espèces sans session de caisse
DO $$
DECLARE
    v_c UUID;
    v_s UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T31', 'pending');

    BEGIN
        INSERT INTO public.payments (company_id, sale_id, payment_method, amount, cash_session_id)
        VALUES (v_c, v_s, 'cash', 1000, NULL);
        RAISE EXCEPTION 'T31 Échec : Paiement cash accepté sans session de caisse';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%exige obligatoirement une session de caisse%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T31 RÉUSSI : Paiement en espèces sans caisse obligatoirement rejeté';
END $$;

-- TEST 32 : Paiement en espèces associé à une caisse fermée
DO $$
DECLARE
    v_c UUID;
    v_sess UUID := gen_random_uuid();
    v_s UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    INSERT INTO public.cash_sessions (id, company_id, status) VALUES (v_sess, v_c, 'closed');
    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T32', 'pending');

    BEGIN
        INSERT INTO public.payments (company_id, sale_id, payment_method, amount, cash_session_id)
        VALUES (v_c, v_s, 'cash', 1000, v_sess);
        RAISE EXCEPTION 'T32 Échec : Paiement cash accepté sur session fermée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%fermée ou invalide%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T32 RÉUSSI : Paiement cash sur caisse fermée refusé';
END $$;

-- TEST 33 : Dépassement du plafond de remboursement (isolation par entreprise dédiée)
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t33';
    v_sess UUID := gen_random_uuid();
    v_prod UUID := gen_random_uuid();
    v_s UUID := gen_random_uuid();
    v_p UUID := gen_random_uuid();
BEGIN
    SELECT company_id, user_id INTO v_c, v_u
    FROM register_company_and_owner('Entreprise T33 Remb', 'restaurant', 'XOF', 't33@test.com', 'h', 'Caissier');
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');
    PERFORM set_session_context(v_token, v_c);

    INSERT INTO public.cash_sessions (id, company_id, status) VALUES (v_sess, v_c, 'open');
    INSERT INTO public.products (id, company_id, name, product_type, inventory_tracking, unit, selling_price)
    VALUES (v_prod, v_c, 'Menu T33', 'service', 'none', 'u', 5000);

    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T33', 'pending');
    INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal) VALUES (v_c, v_s, v_prod, 1, 5000, 5000);
    INSERT INTO public.payments (id, company_id, sale_id, payment_method, amount, cash_session_id) VALUES (v_p, v_c, v_s, 'cash', 5000, v_sess);
    PERFORM complete_sale(v_s);

    -- Remboursement 1 : 4000 XOF
    INSERT INTO public.refunds (company_id, sale_id, payment_id, cash_session_id, amount, refund_method, reason)
    VALUES (v_c, v_s, v_p, v_sess, 4000, 'cash', 'Defaut produit');

    -- Remboursement 2 : 2000 XOF (Total 6000 > 5000 payé)
    BEGIN
        INSERT INTO public.refunds (company_id, sale_id, payment_id, cash_session_id, amount, refund_method, reason)
        VALUES (v_c, v_s, v_p, v_sess, 2000, 'cash', 'Trop remboursé');
        RAISE EXCEPTION 'T33 Échec : Dépassement de plafond de remboursement autorisé';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Dépassement interdit%' THEN RAISE; END IF;
    END;

    PERFORM close_cash_session(v_sess, 1000);
    RAISE NOTICE 'T33 RÉUSSI : Plafond cumulatif de remboursement strictement garanti';
END $$;

-- TEST 34 : Dépense sur caisse fermée rejetée
DO $$
DECLARE
    v_c UUID;
    v_sess UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Resto T22';
    INSERT INTO public.cash_sessions (id, company_id, status) VALUES (v_sess, v_c, 'closed');

    BEGIN
        INSERT INTO public.expenses (company_id, cash_session_id, category, amount, description)
        VALUES (v_c, v_sess, 'Carburant', 3000, 'Course livreur');
        RAISE EXCEPTION 'T34 Échec : Dépense acceptée sur caisse fermée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%fermée ou invalide%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T34 RÉUSSI : Décaissement de dépense sur caisse fermée bloqué';
END $$;

-- TEST 35 : Clôture de caisse avec calcul exact du solde théorique (isolation par entreprise dédiée)
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t35';
    v_sess UUID := gen_random_uuid();
    v_prod UUID := gen_random_uuid();
    v_s UUID := gen_random_uuid();
    v_p UUID := gen_random_uuid();
    v_expected NUMERIC(14,2);
BEGIN
    SELECT company_id, user_id INTO v_c, v_u
    FROM register_company_and_owner('Entreprise T35 Caisse', 'restaurant', 'XOF', 't35@test.com', 'h', 'Gérant');
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');
    PERFORM set_session_context(v_token, v_c);

    -- Ouverture à 10 000 XOF
    INSERT INTO public.cash_sessions (id, company_id, opening_amount, status) VALUES (v_sess, v_c, 10000, 'open');
    INSERT INTO public.products (id, company_id, name, product_type, inventory_tracking, unit, selling_price)
    VALUES (v_prod, v_c, 'Menu T35', 'service', 'none', 'u', 5000);

    -- Vente validée 5000 en cash
    INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-CASH-T35', 'pending');
    INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal) VALUES (v_c, v_s, v_prod, 1, 5000, 5000);
    INSERT INTO public.payments (id, company_id, sale_id, cash_session_id, payment_method, amount) VALUES (v_p, v_c, v_s, v_sess, 'cash', 5000);
    PERFORM complete_sale(v_s);

    -- Dépense de 2000 en cash
    INSERT INTO public.expenses (company_id, cash_session_id, category, amount, description)
    VALUES (v_c, v_sess, 'Emballages', 2000, 'Cartons pizza');

    -- Solde attendu : 10 000 + 5 000 - 2 000 = 13 000 XOF
    PERFORM close_cash_session(v_sess, 13000);

    SELECT expected_closing_amount INTO v_expected FROM public.cash_sessions WHERE id = v_sess;
    IF v_expected <> 13000.00 THEN
        RAISE EXCEPTION 'T35 Échec : Solde calculé % au lieu de 13000.00', v_expected;
    END IF;
    RAISE NOTICE 'T35 RÉUSSI : Réconciliation exacte de clôture de caisse (13000.00)';
END $$;

-- TEST 36 : Annulation de vente validée avec restitution de stock et remboursement sous restogest_app
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t36';
    v_p UUID := gen_random_uuid();
    v_s UUID := gen_random_uuid();
    v_sess UUID := gen_random_uuid();
    v_stock_apres NUMERIC(14,3);
    v_status VARCHAR(20);
BEGIN
    SELECT company_id, user_id INTO v_c, v_u
    FROM register_company_and_owner('Entreprise T36 Annul', 'pastry_shop', 'XOF', 't36@test.com', 'h', 'Responsable');
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    INSERT INTO public.cash_sessions (id, company_id, status) VALUES (v_sess, v_c, 'open');
    INSERT INTO public.products (id, company_id, name, product_type, unit, selling_price) VALUES (v_p, v_c, 'Tarte Fraise', 'finished_good', 'u', 4000);
    INSERT INTO public.stock_levels (company_id, product_id, current_quantity) VALUES (v_c, v_p, 10.000);

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        INSERT INTO public.sales (id, company_id, invoice_number, status) VALUES (v_s, v_c, 'FAC-T36', 'pending');
        INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal) VALUES (v_c, v_s, v_p, 2, 4000, 8000);
        INSERT INTO public.payments (company_id, sale_id, payment_method, amount, cash_session_id) VALUES (v_c, v_s, 'cash', 8000, v_sess);

        PERFORM complete_sale(v_s);
        PERFORM cancel_sale(v_s, 'Client mécontent');

        SELECT current_quantity INTO v_stock_apres FROM public.stock_levels WHERE product_id = v_p;
        SELECT status INTO v_status FROM public.sales WHERE id = v_s;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    IF v_stock_apres <> 10.000 OR v_status <> 'cancelled' THEN
        RAISE EXCEPTION 'T36 Échec : Restitution incorrecte (stock: %, statut: %)', v_stock_apres, v_status;
    END IF;
    RAISE NOTICE 'T36 RÉUSSI : Annulation, restitution du stock (10.000) et remboursement validés sous restogest_app';
END $$;

-- ---------------------------------------------------------------------
-- DOMAINE 7 : ACHATS, JOURNAL D'AUDIT ET INTÉGRITÉ (T37 - T40)
-- ---------------------------------------------------------------------

-- TEST 37 : Tentative de passage au statut received sans receive_purchase() sous SET ROLE restogest_app et rôle privilégié
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t37';
    v_purch UUID := gen_random_uuid();
BEGIN
    -- Vérification catalogue colonne
    IF has_column_privilege('restogest_app', 'public.purchases', 'status', 'UPDATE') THEN
        RAISE EXCEPTION 'T37 Échec : restogest_app a le droit UPDATE sur purchases.status';
    END IF;

    SELECT id INTO v_c FROM public.companies WHERE name = 'Entreprise T36 Annul';
    SELECT id INTO v_u FROM public.users WHERE email = 't36@test.com';
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');
    INSERT INTO public.purchases (id, company_id, status) VALUES (v_purch, v_c, 'ordered');

    -- 1. Tentative réelle d'UPDATE direct du statut sous SET LOCAL ROLE restogest_app
    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        EXECUTE format('UPDATE public.purchases SET status = ''received'' WHERE id = %L', v_purch);
        RESET ROLE;
        RAISE EXCEPTION 'T37 Échec critique : restogest_app a pu modifier purchases.status';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    -- 2. Tentative réelle d'INSERT direct en statut received sous SET LOCAL ROLE restogest_app
    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        INSERT INTO public.purchases (company_id, status) VALUES (v_c, 'received');
        RESET ROLE;
        RAISE EXCEPTION 'T37 Échec critique : restogest_app a pu insérer un achat directement en statut received';
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        IF SQLERRM NOT LIKE '%ne peut être créé directement au statut received%' THEN RAISE; END IF;
    END;

    -- 3. Tentative sous rôle privilégié avec falsification du GUC app.receive_purchase_token
    BEGIN
        PERFORM set_config('app.receive_purchase_token', 'true', true);
        UPDATE public.purchases SET status = 'received' WHERE id = v_purch;
        RAISE EXCEPTION 'T37 Échec critique : Falsification GUC app.receive_purchase_token acceptée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%doit obligatoirement être effectuée via la fonction receive_purchase()%' THEN RAISE; END IF;
    END;

    RAISE NOTICE 'T37 RÉUSSI : Protection multi-couches des achats vérifiée (GRANT, INSERT guard et jeton SHA-256)';
END $$;

-- TEST 38 : Modification des lignes d'achat interdite après réception
DO $$
DECLARE
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t38';
    v_p UUID := gen_random_uuid();
    v_purch UUID := gen_random_uuid();
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Entreprise T36 Annul';
    SELECT id INTO v_u FROM public.users WHERE email = 't36@test.com';
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    INSERT INTO public.products (id, company_id, name, product_type, unit) VALUES (v_p, v_c, 'Café Grains', 'raw_material', 'kg');
    INSERT INTO public.purchases (id, company_id, status) VALUES (v_purch, v_c, 'ordered');
    INSERT INTO public.purchase_items (company_id, purchase_id, product_id, quantity, unit_cost, subtotal)
    VALUES (v_c, v_purch, v_p, 5, 2000, 10000);

    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        PERFORM receive_purchase(v_purch);

        BEGIN
            UPDATE public.purchase_items SET quantity = 10 WHERE purchase_id = v_purch;
            RESET ROLE;
            RAISE EXCEPTION 'T38 Échec : Modification de lignes d''achat après réception autorisée';
        EXCEPTION WHEN OTHERS THEN
            IF SQLERRM NOT LIKE '%est clôturé%' THEN RAISE; END IF;
        END;
        RESET ROLE;
    EXCEPTION WHEN OTHERS THEN
        RESET ROLE;
        RAISE;
    END;

    RAISE NOTICE 'T38 RÉUSSI : Immuabilité absolue des lignes d''achats réceptionnés sous restogest_app';
END $$;

-- TEST 39 : Alimentation réelle et traçabilité du journal d'audit
DO $$
DECLARE
    v_c UUID;
    v_count INT;
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Entreprise T36 Annul';
    SELECT COUNT(*) INTO v_count FROM public.audit_logs WHERE company_id = v_c;

    IF v_count = 0 THEN
        RAISE EXCEPTION 'T39 Échec : Aucun log d''audit généré par les opérations précédentes';
    END IF;
    RAISE NOTICE 'T39 RÉUSSI : Journal d''audit automatiquement alimenté (total entrées: %)', v_count;
END $$;

-- TEST 40 : Immuabilité absolue du journal d'audit sous SET ROLE restogest_app et rôle privilégié
DO $$
DECLARE
    v_log_id UUID;
    v_c UUID;
    v_u UUID;
    v_token VARCHAR(64) := 'token_t40';
BEGIN
    SELECT id INTO v_c FROM public.companies WHERE name = 'Entreprise T36 Annul';
    SELECT id INTO v_u FROM public.users WHERE email = 't36@test.com';
    SELECT id INTO v_log_id FROM public.audit_logs WHERE company_id = v_c LIMIT 1;
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at) VALUES (v_u, v_c, v_token, NOW() + INTERVAL '1 hour');

    -- 1. Sous SET LOCAL ROLE restogest_app : refusé par GRANT
    BEGIN
        SET LOCAL ROLE restogest_app;
        PERFORM set_session_context(v_token, v_c);
        EXECUTE format('DELETE FROM public.audit_logs WHERE id = %L', v_log_id);
        RESET ROLE;
        RAISE EXCEPTION 'T40 Échec critique : restogest_app a pu supprimer dans audit_logs';
    EXCEPTION WHEN insufficient_privilege THEN
        RESET ROLE;
    END;

    -- 2. Sous rôle privilégié : refusé par trigger trg_audit_logs_no_tamper
    BEGIN
        DELETE FROM public.audit_logs WHERE id = v_log_id;
        RAISE EXCEPTION 'T40 Échec : Suppression dans audit_logs autorisée';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%Le journal d''audit est strictement immuable%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'T40 RÉUSSI : Protection inviolable contre la suppression du journal d''audit';
END $$;

-- ---------------------------------------------------------------------
-- FIN DE LA SUITE DE TESTS (40 SCÉNARIOS)
-- Note : Les tests de concurrence multi-sessions (dblink ou 2 connexions
-- psql parallèles) sont documentés dans docs/ARCHITECTURE_DATABASE.md.
-- ---------------------------------------------------------------------
