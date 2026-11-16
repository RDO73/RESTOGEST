# ARCHITECTURE TECHNIQUE BACKEND & API RESTOGEST V1

Ce document décrit l'intégration entre la couche applicative Node.js/TypeScript et le moteur de base de données PostgreSQL 14+ défini dans [ARCHITECTURE_DATABASE.md](./ARCHITECTURE_DATABASE.md).

---

## 1. Modèle de Session & RLS Transactionnelle

La couche applicative garantit qu'aucune requête métier n'est exécutée en dehors d'une transaction isolée signée.

```
Client HTTP (Bearer JWT)
     │
     ▼
requireAuth Middleware
     │ 1. Vérifie la signature JWT
     │ 2. Extrait le payload { userId, companyId, jti }
     │ 3. Calcule tokenHash = SHA-256(jti)
     ▼
withTenantContext(context, callback)
     │ 1. Client dédié depuis appPool (rôle NOBYPASSRLS restogest_app)
     │ 2. BEGIN;
     │ 3. SELECT public.set_session_context(tokenHash, companyId);
     │ 4. Exécution du callback (RLS active sur toutes les tables)
     │ 5. COMMIT; (ou ROLLBACK en cas d'erreur)
     │ 6. Libération du client au pool
     ▼
PostgreSQL 14+
```

---

## 2. Modules API Implémentés

| Module | Préfixe Route | Responsabilités | Fonctions SQL appelées |
|---|---|---|---|
| **Auth** | `/api/auth` | Register, Login, Me, Logout | `register_company_and_owner()`, `set_session_context()` |
| **Catalogue** | `/api/catalog` | Catégories, Produits, Recettes | Détection anti-cycle (`trg_recipe_ingredients_cycle`) |
| **Ventes** | `/api/sales` | Ventes, Items, Paiements, Clôture, Annulation | `complete_sale()`, `cancel_sale()` |
| **Achats** | `/api/purchases` | Fournisseurs, Commandes, Réception | `receive_purchase()` (mise à jour PMP & stocks) |
| **Stocks** | `/api/inventory` | Niveaux actuels, Alertes stock bas, Mouvements | `record_stock_adjustment()`, RLS sur `stock_levels` et `stock_movements` |
| **Caisse** | `/api/cash` | Sessions de caisse, Clôture, Dépenses | `close_cash_session()`, validation dépenses |

---

## 3. Scripts d'exploitation

- `npm run dev` : Démarrage du serveur en mode surveillance (`tsx watch src/index.ts`)
- `npm run build` : Compilation TypeScript vers `dist/`
- `npm test` : Exécution des suites de tests Vitest (`auth`, `sales.logic`, `modules.integration`)
- `npm run test:schema` : Validation statique, SQLite, PGlite (40/40), migrations `001..008` et seed
- `npm run test:concurrency` : Suite de concurrence multi-sessions TCP (`tests/concurrency_pg.mjs`)
- `npm run db:migrate` : Application idempotente des 8 migrations ordonnées PostgreSQL V1
- `npm run db:seed` : Injection du jeu de données de démonstration (Restaurant & Pâtisserie)
