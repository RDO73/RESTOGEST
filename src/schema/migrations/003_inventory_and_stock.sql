-- =====================================================================
-- RESTOGEST V1 - Migration 003 : Niveaux de Stock, Mouvements Tracables & Guards d'Integrite
-- =====================================================================

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
