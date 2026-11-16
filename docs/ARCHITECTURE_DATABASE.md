# ARCHITECTURE TECHNIQUE & GUIDE DE SÉCURITÉ RESTOGEST V1

> [!IMPORTANT]
> Ce document décrit l'architecture exacte implémentée dans `src/schema/restogest_v1_consolidated.sql`.
> Toute divergence entre ce document et le SQL est une erreur de documentation, pas une liberté de conception.

---

## 1. Vue d'ensemble

RestoGest V1 est une plateforme SaaS multi-entreprises pour la gestion des restaurants et pâtisseries.

| Critère | Valeur |
|---|---|
| Moteur | PostgreSQL 14.0+ |
| Multi-tenant | Row-Level Security **FORCÉE** (`FORCE ROW LEVEL SECURITY`) sur toutes les tables métier |
| Rôle applicatif | `restogest_app` (`NOBYPASSRLS`) |
| Rôle propriétaire DDL | `restogest_owner` (`NOBYPASSRLS`, propriétaire des tables métier) |
| Rôle d'exécution privilégiée / maintenance | `restogest_admin` (`BYPASSRLS`, propriétaire des tables de sécurité et fonctions `SECURITY DEFINER`) |

---

## 2. Modèle de sécurité et frontière de confiance

### 2.1 Pourquoi les GUC ne sont pas une preuve d'identité

Les variables de configuration PostgreSQL (`set_config`, `current_setting`) sont **modifiables par tout rôle** autorisé à exécuter du SQL. Nommer une variable `verified_*` ne la protège pas : un rôle malveillant ou compromis peut écraser sa valeur via `SELECT set_config(...)`.

### 2.2 Solution retenue : Signature SHA-256 liée à la session, au PID et à la transaction + Révocation en temps réel

L'architecture combine quatre barrières complémentaires autour d'un secret interne stocké dans `app_security_config`, **totalement inaccessible à `restogest_app` et `restogest_owner`** :

```
app_security_config (id=1, hmac_secret)   <- REVOKE ALL FROM PUBLIC, restogest_app, restogest_owner
         |
         v
set_session_context(token_hash, company_id)   <- SECURITY DEFINER (OWNER restogest_admin)
  1. Vérifie user_sessions (s.id, token_hash, expires_at > NOW(), revoked_at IS NULL)
  2. Vérifie s.company_id = p_company_id (liaison session <-> entreprise)
  3. Vérifie l'état actif de l'utilisateur, de l'entreprise et de company_users
  4. Calcule v_sig = sha256(secret || '|' || s.id || '|' || s.user_id || '|' || p_company_id
                            || '|' || pg_backend_pid() || '|' || transaction_timestamp() || '|' || secret)
  5. SET LOCAL app.session_id, app.session_user_id, app.session_company_id, app.session_signature
         |
         v
app_current_company_id() / app_current_user_id()   <- SECURITY DEFINER (OWNER restogest_admin)
  1. Lit les 4 GUC de session
  2. Recalcule le SHA-256 attendu avec secret + PID + transaction_timestamp()
  3. Si signature absente ou divergente -> RETURN NULL (bloque falsification et rejeu inter-transactions)
  4. Vérifie en temps réel l'existence active de s.id dans user_sessions
     JOIN users, companies, company_users (expires_at > clock_timestamp(), revoked_at IS NULL)
  5. Si révoqué/expiré/incohérent -> RETURN NULL (Fail-Closed)
```

**Garanties obtenues :**
1. **Falsification directe impossible :** `restogest_app` n'a aucun accès à `app_security_config` ni à `user_sessions`. Toute modification d'un ou plusieurs GUC via `set_config()` invalide la signature SHA-256 → `NULL`.
2. **Rejeu inter-transactions bloqué :** Le condensat inclut `pg_backend_pid()` et `transaction_timestamp()`, ce qui lie la signature à la transaction courante.
3. **Révocation granulaire en temps réel :** La vérification s'appuie sur l'identifiant réel de session (`s.id`) et croise `(s.id, s.user_id, s.company_id)`. La révocation d'une session coupe immédiatement son accès, même si le même utilisateur possède une autre session active sur la même entreprise.

> [!WARNING]
> Cette protection **ne se substitue pas** à la validation JWT côté backend. Le backend doit vérifier le JWT avant d'appeler `set_session_context()`. PostgreSQL est la **deuxième ligne de défense**, non la première.

### 2.3 Flux d'authentification complet

```
Client HTTP
    |
    | JWT (signé RS256/HS256)
    v
Backend applicatif
    | 1. Vérifie la signature JWT
    | 2. Extrait le JTI (identifiant unique du jeton)
    | 3. Calcule SHA-256(JTI) = token_hash
    |
    v
Pool PgBouncer (mode Transaction Pooling)
    |
    | BEGIN;
    | SELECT set_session_context('sha256_jti', 'company_uuid');
    | -- Requêtes applicatives sécurisées par RLS --
    | COMMIT;
    v
PostgreSQL 14+
    | Vérifie session + liaison entreprise + signature SHA-256 dans set_session_context
    | Toutes les politiques RLS appellent app_current_company_id() / app_current_user_id()
```

> [!NOTE]
> `is_local = true` dans `set_config` garantit la purge des 4 variables de session à la fin de chaque transaction, évitant toute fuite entre connexions réutilisées par PgBouncer.

### 2.4 Tables inaccessibles à `restogest_app`

| Table | Raison |
|---|---|
| `user_credentials` | Contient les hash Argon2id des mots de passe |
| `user_sessions` | Contient les `token_hash` servant à l'authentification |
| `app_security_config` | Contient le secret interne de signature SHA-256 |

---

## 3. Gestion des stocks — 3 modes opératoires

| Mode `inventory_tracking` | Comportement lors de la vente | Exemple |
|---|---|---|
| `direct` | Le stock du **produit fini** est décrémenté directement (`sale_out`) | Tarte fabriquée le matin, vendue en fin de journée |
| `recipe_on_sale` | Les **ingrédients** de la fiche technique active sont consommés (`recipe_out`) à la validation | Plat cuisiné à la commande |
| `none` | **Aucun mouvement de stock** généré. Le `unit_cost_snapshot` est fixé à 0 | Prestation de service, livraison |

> [!IMPORTANT]
> Un mouvement de stock vers un produit dont `inventory_tracking = 'none'` est **strictement interdit** par le trigger `trg_stock_movement_tracking_guard` (`BEFORE INSERT`). Aucun ingrédient en mode `none` ne génère de déstockage lors d'une recette.

### 3.1 Idempotence des mouvements de stock

L'index unique partiel `uq_stock_movements_traceable` protège contre les doublons **uniquement** pour les pièces comptables traçables (`source_type IS NOT NULL AND source_line_id IS NOT NULL`). Les ajustements manuels via `record_stock_adjustment()` (`source_type = 'manual'`, sans `source_line_id`) restent librement cumulables.

---

## 4. Machine à états des ventes

```
INSERT  -->  [pending]  -->  [completed]  -->  [cancelled]
                |                                   ^
                +-----------------------------------+
                   (cancel_sale autorisée depuis pending)
```

| Transition | Autorisée par | Mécanisme |
|---|---|---|
| `pending → completed` | `complete_sale()` | `SECURITY DEFINER`, recalcul des totaux, vérif paiement exact |
| `pending → cancelled` | `cancel_sale()` | `SECURITY DEFINER`, sans restitution de stock |
| `completed → cancelled` | `cancel_sale()` | `SECURITY DEFINER`, restitution stock + remboursements |
| Toute autre | — | Bloquée par `trg_sales_state_machine` et `trg_sales_before_insert` |

> [!NOTE]
> `trg_sales_state_machine` autorise les mises à jour de colonnes **tant que le statut reste `pending`** (et que le rôle possède le `GRANT UPDATE` sur ces colonnes : `customer_id`, `cash_session_id`, `notes`, `discount_amount`). Les transitions de statut et les montants finaux sur ventes `completed` ou `cancelled` sont verrouillés.

### 4.1 Garanties arithmétiques des lignes de vente

La contrainte `CHECK (subtotal = ROUND(quantity * unit_price, 2))` (`chk_sale_items_subtotal`) sur `sale_items` empêche toute incohérence arithmétique de ligne, indépendamment de l'application.

### 4.2 Validation d'une vente (`complete_sale`)

1. Verrou `FOR UPDATE` sur la vente → empêche les validations concurrentes
2. Recalcul strict : `subtotal = SUM(sale_items.subtotal)`
3. Contrôle de remise : `discount_amount ≤ subtotal`
4. Calcul de la taxe : `tax = ROUND((subtotal - discount) * tax_rate / 100, 2)`
5. Verrou `FOR UPDATE` sur tous les paiements → sérialisation des paiements concurrents
6. Contrôle de paiement : `SUM(payments.amount) = total_amount` (ni insuffisant, ni trop-perçu)
7. Déstockage ordonné par `product_id ASC` (anti-deadlock)
8. Mise à jour atomique finale : `status = 'completed'`, totaux figés

---

## 5. Protection et réception des achats (`receive_purchase`)

La réception d'un achat est protégée par trois barrières complémentaires :

1. **Matrice GRANT colonne par colonne :** `restogest_app` n'a `UPDATE` que sur `(supplier_id, reference, notes, total_amount, purchased_at)`. Les colonnes `status`, `received_at` et `cancelled_at` sont **exclues** : tout `UPDATE purchases SET status = ...` par `restogest_app` échoue au niveau des privilèges PostgreSQL avant même les triggers.
2. **Garde INSERT (`trg_purchases_before_insert`) :** Interdit la création directe d'un achat au statut `'received'` ou `'cancelled'`.
3. **Garde UPDATE (`trg_purchases_state_guard` / `trg_purchases_guard()`) :** `receive_purchase()` génère un jeton SHA-256 à usage unique signé avec `app_security_config.hmac_secret` (lié à `purchase.id`, `pg_backend_pid()` et `transaction_timestamp()`), place ce jeton dans `app.receive_purchase_token`, exécute l'`UPDATE`, puis purge immédiatement le jeton. Le trigger `SECURITY DEFINER` vérifie ce jeton cryptographique sans dépendre d'hypothèses fragiles sur `current_user`. Une fois `received` ou `cancelled`, toute modification sur `purchases` et `purchase_items` (`trg_purchase_items_lock`) est bloquée.

### Formule PMP

$$PMP_{nouveau} = \frac{(Q_{actuel} \times PMP_{actuel}) + (Q_{reçu} \times P_{achat})}{Q_{actuel} + Q_{reçu}}$$

Le résultat est arrondi à 4 décimales et mis à jour dans `products.cost_price`.

---

## 6. Journal d'audit automatisé

Le trigger `trg_audit_log_change()` (`SECURITY DEFINER`, propriétaire `restogest_admin` avec `BYPASSRLS`, `AFTER INSERT/UPDATE/DELETE`) alimente automatiquement `audit_logs` pour les tables suivantes :

- `sales`, `purchases`, `payments`, `refunds`, `expenses`, `roles`, `company_users`

**Protections :**
- `restogest_app` a uniquement `SELECT` sur `audit_logs` — pas d'INSERT, UPDATE ou DELETE
- Le trigger `trg_audit_logs_no_tamper` (`BEFORE UPDATE/DELETE`) lève une exception inconditionnelle
- Les hash de mots de passe sont expurgés des logs (`password_hash` supprimé du JSON)

---

## 7. Détection des cycles dans les recettes

Le trigger `trg_lock_and_detect_recipe_cycle` (`BEFORE INSERT/UPDATE`) sur `recipe_ingredients` et `recipes` :

1. Acquiert `pg_advisory_xact_lock(hashtext('recipe_graph_' || company_id))` → sérialise les modifications du graphe de recettes **par entreprise**
2. Vérifie l'auto-référence directe (`finished_product_id = ingredient_id`)
3. Évalue le graphe **futur** (incluant la nouvelle relation `NEW`) par CTE récursive
4. Remonte depuis l'ingrédient ciblé pour détecter si un chemin mène au produit fini parent
5. Lève une exception si un cycle ou une profondeur > 50 est détecté

---

## 8. Matrice des privilèges `restogest_app`

| Table / Objet | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `categories`, `products`, `recipes`, `recipe_ingredients`, `customers` | ✅ | ✅ | ✅ | ✅ |
| `sales` | ✅ | ✅ | `customer_id`, `cash_session_id`, `notes`, `discount_amount` | ❌ |
| `sale_items`, `purchase_items` | ✅ | ✅ | ✅ | ✅ |
| `purchases` | ✅ | ✅ | `supplier_id`, `reference`, `notes`, `total_amount`, `purchased_at` | ❌ |
| `suppliers` | ✅ | ✅ | ✅ | ❌ |
| `payments` | ✅ | ✅ | ❌ | ❌ |
| `refunds` | ✅ | ✅ | `reason`, `gateway_transaction_id`, `gateway_response` | ❌ |
| `cash_sessions`, `expenses` | ✅ | ✅ | ❌ | ❌ |
| `companies`, `subscription_plans`, `company_subscriptions` | ✅ | ❌ | ❌ | ❌ |
| `stock_levels`, `stock_movements`, `audit_logs` | ✅ | ❌ | ❌ | ❌ |
| `roles`, `company_users`, `users` | ✅ | ❌ | ❌ | ❌ |
| `user_credentials`, `user_sessions`, `app_security_config` | ❌ | ❌ | ❌ | ❌ |

**Fonctions exécutables par `restogest_app` :**
`register_company_and_owner()`, `set_session_context()`, `app_current_user_id()`, `app_current_company_id()`, `complete_sale()`, `cancel_sale()`, `receive_purchase()`, `cancel_purchase()`, `record_stock_adjustment()`, `close_cash_session()`

---

## 9. Validation automatisée, migrations ordonnées et déploiement PostgreSQL

### 9.1 Migrations SQL ordonnées (`src/schema/migrations/` & `src/db/migrate.ts`)

Le schéma consolidé (`src/schema/restogest_v1_consolidated.sql`) est découpé à l'identique en **8 migrations SQL ordonnées** gérées de façon idempotente via la table `public.schema_migrations` (avec contrôle de somme SHA-256) :

1. `001_roles_security_and_auth.sql` — Rôles PostgreSQL (`restogest_owner`, `restogest_admin`, `restogest_app`), `app_security_config`, tenants, utilisateurs, sessions & contexte signé SHA-256
2. `002_catalog_and_recipes.sql` — Catégories, produits, fiches recettes & détection de cycles (`trg_lock_and_detect_recipe_cycle`)
3. `003_inventory_and_stock.sql` — Niveaux de stock, mouvements traçables & triggers de contrôle
4. `004_cash_sales_payments_refunds.sql` — Sessions de caisse, clients, ventes, lignes de vente, paiements, remboursements, dépenses & verrous d'immuabilité
5. `005_suppliers_purchases_and_guards.sql` — Fournisseurs, achats, lignes d'achat & guards anti-contournement
6. `006_business_procedures.sql` — Procédures `SECURITY DEFINER` (`complete_sale`, `cancel_sale`, `receive_purchase`, `cancel_purchase`, `record_stock_adjustment`, `close_cash_session`)
7. `007_subscriptions_and_audit.sql` — Abonnements & journal d'audit immuable automatisé
8. `008_rls_policies_and_privileges.sql` — `ENABLE/FORCE ROW LEVEL SECURITY` (22 tables), politiques d'isolation, matrice `GRANT`/`REVOKE` & propriétaires des rôles

### 9.2 Suite de validation automatisée (`tests/validate_restogest.mjs`)

L'outil autonome **Node.js (`tests/validate_restogest.mjs`)** valide l'architecture en quatre phases :

```bash
node tests/validate_restogest.mjs
```

1. **Phase 1 — Analyse lexicale et structurelle statique (7 contrôles) :** équilibre syntaxique des blocs `$$` et parenthèses, présence des 26 tables, `FORCE ROW LEVEL SECURITY` sur les 22 tables métier, matrice `GRANT`/`REVOKE`, ségrégation des propriétaires, absence de vecteurs obsolètes et correspondance exacte des 40 scénarios et messages `SQLERRM`.
2. **Phase 2 — Simulation unitaire SQLite + SHA-256 (40/40 scénarios) :** validation algorithmique et relationnelle avec triggers SQLite d'immuabilité et cryptographie SHA-256 réelle.
3. **Phase 3 — Exécution réelle sur moteur PostgreSQL embarqué en mémoire (`@electric-sql/pglite` WASM) :** exécution réelle complète de `src/schema/restogest_v1_consolidated.sql` et des **40 scénarios de `tests/test_suite_v1.sql`** avec vérifications PL/pgSQL, `FORCE ROW LEVEL SECURITY` (y compris sur `restogest_owner`), `SECURITY DEFINER`, `sha256()`, `SET LOCAL ROLE restogest_app` et `restogest_admin`.
4. **Phase 4 — Parité des 8 migrations ordonnées + Seed Démo (`@electric-sql/pglite`) :** application séquentielle de `001` à `008`, exécution de `40/40` tests sur la base migrée puis exécution complète de `src/schema/seeds/seed_demo.sql`.

### 9.3 Prérequis et exécution sur serveur PostgreSQL 14+ dédié (validé sur PostgreSQL 17.4)

- PostgreSQL 14.0 ou supérieur (validé sur **PostgreSQL 17.4 x64**)
- Rôles `restogest_owner`, `restogest_admin`, `restogest_app` créés par la migration `001`
- Base de test **vierge et dédiée** (ne pas utiliser une base de production)

```bash
# 1. Création d'une base de test vierge
createdb -U postgres restogest_test

# 2. Application des 8 migrations ordonnées (ou du schéma consolidé)
npm run db:migrate

# 3. Exécution de la suite de tests SQL (40 scénarios sous restogest_admin)
psql -U restogest_admin -d restogest_test -v ON_ERROR_STOP=1 -f tests/test_suite_v1.sql

# 4. Exécution des tests de concurrence parallèles (6 scénarios TCP sous restogest_app)
node tests/concurrency_pg.mjs
```

> [!CAUTION]
> La suite SQL `tests/test_suite_v1.sql` doit être lancée sous `postgres` ou `restogest_admin` (`BYPASSRLS`) afin de préparer les fixtures multi-entreprises et d'exécuter les bascules réelles `SET LOCAL ROLE restogest_app`.

### 9.4 Tests de concurrence multi-sessions parallèles (`tests/concurrency_pg.mjs`)

Exécutée par **de vraies connexions TCP parallèles** (`pg.Client` sous `restogest_app`, `NOBYPASSRLS`) contre PostgreSQL 17.4, la suite valide :

- **C1 :** Double `complete_sale()` concurrent -> 1 seul succès, stock déduit 1 fois (`FOR UPDATE`)
- **C2A :** Paiement espèces ouvert (`FOR SHARE` sur `cash_sessions`) bloque `close_cash_session()` (`FOR UPDATE`) puis son montant est inclus après `COMMIT`
- **C2B :** `close_cash_session()` actif puis `COMMIT` rejette un paiement espèces concurrent en attente
- **C3 :** Double remboursement partiel concurrent excédant le paiement (`60 + 60 > 100`) -> 1 seul succès (`FOR UPDATE` sur `payments`)
- **C4 :** Double `receive_purchase()` parallèle -> 1 seul succès, stock & PMP mis à jour 1 fois
- **C5 :** Insertions concurrentes réciproques `A -> B` et `B -> A` dans `recipe_ingredients` -> sérialisées par `pg_advisory_xact_lock`, cycle détecté sans deadlock

---

## 10. Statut et portée de validation

| Niveau de vérification | Statut | Portée exacte et preuves observées |
|---|---|---|
| **Analyse statique + Simulation SQLite/SHA-256 (`tests/validate_restogest.mjs`)** | **`VALIDÉ`** | 7 contrôles structurels + 40/40 scénarios simulés réussis sous Node.js v24 + `node:sqlite`. |
| **PostgreSQL embarqué (`@electric-sql/pglite` — PostgreSQL 18.6 WASM)** | **`VALIDÉ`** | Schéma consolidé (40/40) + 8 migrations ordonnées `001..008` (40/40) + `seed_demo.sql` exécutés avec succès (`FORCE RLS`, `SET LOCAL ROLE restogest_app`, `restogest_admin`). |
| **Serveur PostgreSQL 17.4 réel (TCP multi-sessions)** | **`VALIDÉ`** | `migrate.ts` (8/8 appliquées + idempotence 0/8 au 2e run), `psql` `test_suite_v1.sql` (40/40 sous `restogest_admin`) et `seed_demo.sql` réussis. |
| **Concurrence multi-sessions parallèles (`tests/concurrency_pg.mjs`)** | **`VALIDÉ`** | **6/6** scénarios concurrents réussis sous `restogest_app` TCP contre PostgreSQL 17.4 (`C1`, `C2A`, `C2B`, `C3`, `C4`, `C5`). |
| **API TypeScript & Tests Vitest (`tsc --noEmit`, `tests/*.test.ts`)** | **`VALIDÉ`** | Compilation `tsc --noEmit` & `tsc` sans erreur ; tests unitaires (`sales.logic` 4/4, `auth` 3/3) et intégration HTTP (`modules.integration.test.ts` 7/7 incluant multi-tenant & révocation `/logout`) réussis sur PGlite et PostgreSQL 17.4 externe. |
