-- =====================================================================
-- RESTOGEST V1 - Migration 002 : Catalogue (Categories, Produits) & Recettes avec Detection de Cycles
-- =====================================================================

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
