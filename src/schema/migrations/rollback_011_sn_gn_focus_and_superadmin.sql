-- Rollback Migration 011
UPDATE public.saas_countries
SET is_active = TRUE,
    updated_at = NOW();
