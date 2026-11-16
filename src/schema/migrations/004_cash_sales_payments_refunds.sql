-- =====================================================================
-- RESTOGEST V1 - Migration 004 : Sessions de Caisse, Clients, Ventes, Paiements, Remboursements, Depenses & Triggers
-- =====================================================================

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
