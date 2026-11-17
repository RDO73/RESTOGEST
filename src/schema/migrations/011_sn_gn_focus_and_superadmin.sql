-- =====================================================================
-- RESTOGEST V1.4 - Migration 011 : Ciblage Exclusif Senegal (XOF) & Guinee (GNF) + Paiements Locaux
-- Migration 100 % incrementale et non destructive
-- =====================================================================

-- 1. Restreindre les pays actifs exclusivement au Senegal (SN / XOF) et a la Guinee (GN / GNF)
UPDATE public.saas_countries
SET is_active = CASE WHEN code IN ('SN', 'GN') THEN TRUE ELSE FALSE END,
    commercial_status = CASE WHEN code IN ('SN', 'GN') THEN 'active' ELSE 'coming_soon' END,
    updated_at = NOW();

-- 2. Configurer les moyens de paiement locaux exacts pour Senegal & Guinee (Section 2)
-- Desactiver d'abord les methodes hors SN/GN ou non retenues
UPDATE public.saas_country_payment_methods
SET is_active = FALSE;

-- Activer les prestataires necessaires pour SN et GN
UPDATE public.saas_payment_providers
SET is_active = TRUE
WHERE code IN ('manual_wave_sn', 'bank_transfer', 'paydunya', 'cinetpay');

-- SÉNÉGAL (XOF) : Wave, Orange Money, Carte UBA
INSERT INTO public.saas_country_payment_methods (
    country_code, method_code, method_label, provider_code, currency_code,
    requires_manual_verification, is_active, sort_order
)
VALUES
    ('SN', 'wave', 'Wave Sénégal (Compte +221 78 897 93 42)', 'manual_wave_sn', 'XOF', TRUE, TRUE, 1),
    ('SN', 'orange_money', 'Orange Money Sénégal', 'paydunya', 'XOF', TRUE, TRUE, 2),
    ('SN', 'card_visa_uba', 'Carte Bancaire UBA / Visa', 'paydunya', 'XOF', FALSE, TRUE, 3),
    ('GN', 'orange_money', 'Orange Money Guinée', 'cinetpay', 'GNF', TRUE, TRUE, 1),
    ('GN', 'bank_transfer', 'Virement / Solution Mobile Locale Guinée', 'bank_transfer', 'GNF', TRUE, TRUE, 2),
    ('GN', 'card_visa_uba', 'Carte Bancaire UBA / Visa', 'cinetpay', 'GNF', FALSE, TRUE, 3)
ON CONFLICT (country_code, method_code, provider_code) DO UPDATE
SET method_label = EXCLUDED.method_label,
    currency_code = EXCLUDED.currency_code,
    requires_manual_verification = EXCLUDED.requires_manual_verification,
    is_active = TRUE,
    sort_order = EXCLUDED.sort_order;
