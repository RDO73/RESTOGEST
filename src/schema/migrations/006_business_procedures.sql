-- =====================================================================
-- RESTOGEST V1 - Migration 006 : Procedures Metier Securisees (complete_sale, cancel_sale, receive_purchase, cancel_purchase, record_stock_adjustment, close_cash_session)
-- =====================================================================

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
-- 9B. PROCEDURES D'ACHATS, STOCK & CLOTURE DE CAISSE
-- ---------------------------------------------------------------------
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
