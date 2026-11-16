-- =====================================================================
-- RESTOGEST V1 - Migration 005 : Fournisseurs, Achats, Lignes d'Achat & Guards Anti-Contournement
-- =====================================================================

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
