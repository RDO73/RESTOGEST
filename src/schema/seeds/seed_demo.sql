-- =====================================================================
-- RESTOGEST V1 - JEU DE DONNÉES DE DÉMONSTRATION (SEED)
-- Entreprise type : Restaurant & Pâtisserie ("both")
-- =====================================================================

BEGIN;

DO $$
DECLARE
    v_company_id UUID;
    v_owner_id UUID;
    v_token VARCHAR(64) := 'demo_session_token_seed_v1';
    
    -- Catégories
    v_cat_raw UUID := gen_random_uuid();
    v_cat_patisserie UUID := gen_random_uuid();
    v_cat_plats UUID := gen_random_uuid();
    v_cat_boissons UUID := gen_random_uuid();
    v_cat_services UUID := gen_random_uuid();

    -- Ingrédients / Matières premières (tracking: direct)
    v_p_farine UUID := gen_random_uuid();
    v_p_beurre UUID := gen_random_uuid();
    v_p_sucre UUID := gen_random_uuid();
    v_p_pommes UUID := gen_random_uuid();
    v_p_cafe UUID := gen_random_uuid();
    v_p_lait UUID := gen_random_uuid();

    -- Produits finis / Recettes (tracking: recipe_on_sale)
    v_p_tarte UUID := gen_random_uuid();
    v_p_cappuccino UUID := gen_random_uuid();

    -- Produits finis vendus en direct (tracking: direct)
    v_p_croissant UUID := gen_random_uuid();

    -- Services (tracking: none)
    v_p_livraison UUID := gen_random_uuid();

    -- Recettes
    v_recipe_tarte UUID := gen_random_uuid();
    v_recipe_cappuccino UUID := gen_random_uuid();

    -- Fournisseur & Achat initial
    v_supplier_id UUID := gen_random_uuid();
    v_purchase_id UUID := gen_random_uuid();

    -- Client
    v_customer_id UUID := gen_random_uuid();
BEGIN
    -- 1. Inscription de l'entreprise et de son propriétaire
    SELECT company_id, user_id INTO v_company_id, v_owner_id
    FROM public.register_company_and_owner(
        'Le Palais Gourmand & Fournil',
        'both',
        'XOF',
        'direction@palaisgourmand.sn',
        '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$abcdefghijklmnopqrstuvwxyz1234567890',
        'Cheikh Tidiane Ndiaye'
    );

    -- 2. Création d'une session de seed pour bypasser la RLS sous restogest_owner
    INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
    VALUES (v_owner_id, v_company_id, v_token, NOW() + INTERVAL '2 hours');

    PERFORM public.set_session_context(v_token, v_company_id);

    -- 3. Catégories
    INSERT INTO public.categories (id, company_id, name, description) VALUES
    (v_cat_raw, v_company_id, 'Matières Premières', 'Ingrédients de base pour cuisine et pâtisserie'),
    (v_cat_patisserie, v_company_id, 'Pâtisseries & Desserts', 'Gâteaux, tartes et viennoiseries'),
    (v_cat_plats, v_company_id, 'Cuisine & Plats Chauds', 'Plats préparés à la commande'),
    (v_cat_boissons, v_company_id, 'Boissons & Cafés', 'Cafeterie et rafraîchissements'),
    (v_cat_services, v_company_id, 'Prestations & Services', 'Frais de livraison et services traiteur');

    -- 4. Produits
    -- Ingrédients (tracking: direct, PMP initial 0 mis à jour par achats)
    INSERT INTO public.products (id, company_id, category_id, name, product_type, unit, selling_price, cost_price, inventory_tracking, min_stock_alert) VALUES
    (v_p_farine, v_company_id, v_cat_raw, 'Farine T55', 'raw_material', 'kg', 0, 500, 'direct', 20),
    (v_p_beurre, v_company_id, v_cat_raw, 'Beurre Gastronomique 82%', 'raw_material', 'kg', 0, 4500, 'direct', 10),
    (v_p_sucre, v_company_id, v_cat_raw, 'Sucre Cristallisé', 'raw_material', 'kg', 0, 650, 'direct', 15),
    (v_p_pommes, v_company_id, v_cat_raw, 'Pommes Golden', 'raw_material', 'kg', 0, 1200, 'direct', 10),
    (v_p_cafe, v_company_id, v_cat_raw, 'Café Grains Arabica', 'raw_material', 'kg', 0, 9000, 'direct', 5),
    (v_p_lait, v_company_id, v_cat_raw, 'Lait Entier Pasteurisé', 'raw_material', 'liter', 0, 950, 'direct', 15);

    -- Produits avec recette déstockée à la commande (tracking: recipe_on_sale)
    INSERT INTO public.products (id, company_id, category_id, name, product_type, unit, selling_price, cost_price, inventory_tracking) VALUES
    (v_p_tarte, v_company_id, v_cat_patisserie, 'Part Tarte aux Pommes Caramélisées', 'finished_good', 'portion', 2500, 750, 'recipe_on_sale'),
    (v_p_cappuccino, v_company_id, v_cat_boissons, 'Cappuccino Mousse Légère', 'finished_good', 'cup', 1800, 320, 'recipe_on_sale');

    -- Produits finis avec stock direct (tracking: direct)
    INSERT INTO public.products (id, company_id, category_id, name, product_type, unit, selling_price, cost_price, inventory_tracking, min_stock_alert) VALUES
    (v_p_croissant, v_company_id, v_cat_patisserie, 'Croissant au Beurre AOP', 'finished_good', 'piece', 800, 350, 'direct', 25);

    -- Service (tracking: none)
    INSERT INTO public.products (id, company_id, category_id, name, product_type, unit, selling_price, cost_price, inventory_tracking) VALUES
    (v_p_livraison, v_company_id, v_cat_services, 'Livraison à Domicile Zone 1', 'service', 'unit', 1500, 0, 'none');

    -- 5. Fiches techniques (Recettes)
    -- Recette Tarte aux Pommes
    INSERT INTO public.recipes (id, company_id, finished_product_id, name, output_quantity, instructions, is_active)
    VALUES (v_recipe_tarte, v_company_id, v_p_tarte, 'Recette Tarte aux Pommes', 8, 'Fiche technique pour une tarte de 8 parts', TRUE);

    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES
    (v_company_id, v_recipe_tarte, v_p_farine, 0.400),
    (v_company_id, v_recipe_tarte, v_p_beurre, 0.250),
    (v_company_id, v_recipe_tarte, v_p_sucre, 0.150),
    (v_company_id, v_recipe_tarte, v_p_pommes, 0.800);

    -- Recette Cappuccino
    INSERT INTO public.recipes (id, company_id, finished_product_id, name, output_quantity, instructions, is_active)
    VALUES (v_recipe_cappuccino, v_company_id, v_p_cappuccino, 'Recette Cappuccino Mousse', 1, '1 tasse standard', TRUE);

    INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required) VALUES
    (v_company_id, v_recipe_cappuccino, v_p_cafe, 0.018),
    (v_company_id, v_recipe_cappuccino, v_p_lait, 0.120);

    -- 6. Fournisseur et approvisionnement initial (Achats reçus -> alimente stock_levels et PMP)
    INSERT INTO public.suppliers (id, company_id, name, email, phone, address)
    VALUES (v_supplier_id, v_company_id, 'Centrale Alimentaire Dakar', 'contact@centraledakar.sn', '+221338000000', 'Zone Industrielle Dakar');

    INSERT INTO public.purchases (id, company_id, supplier_id, reference, status, total_amount)
    VALUES (v_purchase_id, v_company_id, v_supplier_id, 'ACHAT-INIT-2026-001', 'ordered', 380000);

    INSERT INTO public.purchase_items (company_id, purchase_id, product_id, quantity, unit_cost, subtotal) VALUES
    (v_company_id, v_purchase_id, v_p_farine, 100, 500, 50000),
    (v_company_id, v_purchase_id, v_p_beurre, 30, 4500, 135000),
    (v_company_id, v_purchase_id, v_p_sucre, 50, 650, 32500),
    (v_company_id, v_purchase_id, v_p_pommes, 40, 1200, 48000),
    (v_company_id, v_purchase_id, v_p_cafe, 10, 9000, 90000),
    (v_company_id, v_purchase_id, v_p_lait, 25, 980, 24500);

    -- Réception officielle via procédure stockée (calcule PMP et met à jour stocks)
    PERFORM public.receive_purchase(v_purchase_id);

    -- Stock initial pour les croissants (produit direct fabriqué sur place)
    PERFORM public.record_stock_adjustment(
        v_p_croissant,
        'production_in',
        50,
        'Production de viennoiseries du matin'
    );

    -- 7. Client de démonstration
    INSERT INTO public.customers (id, company_id, full_name, email, phone)
    VALUES (v_customer_id, v_company_id, 'Société Générale Sénégal (Compte Entreprise)', 'cse@socgen.sn', '+221770000000');

    RAISE NOTICE 'Seed RESTOGEST V1 injecté avec succès pour l''entreprise : % (ID: %)', 'Le Palais Gourmand & Fournil', v_company_id;
END $$;

COMMIT;
