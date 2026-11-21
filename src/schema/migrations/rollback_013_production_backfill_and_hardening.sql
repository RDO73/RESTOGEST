-- =====================================================================
-- Rollback Migration 013 : Backfill Production Sûr & Nettoyage Coordonnées
-- =====================================================================
-- NOTE DE SÉCURITÉ :
-- La migration 013 réalise uniquement des mises à jour non destructives
-- (complétion d'abonnements manquants, remplissage de plan_code/plan_id NULL
-- et nettoyage de coordonnées placeholder dans saas_merchant_settings).
-- Elle ne crée ni ne supprime aucune structure SQL et ne détruit aucune donnée.
--
-- Pour un retour exact à l'état antérieur en production, restaurez le
-- snapshot Neon créé juste avant le déploiement.
-- Si vous souhaitez uniquement autoriser une ré-exécution de 013 :
DELETE FROM public.schema_migrations
WHERE filename = '013_production_backfill_and_hardening.sql';
