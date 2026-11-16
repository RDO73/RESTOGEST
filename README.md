# RestoGest V1 — Backend API & Moteur PostgreSQL Multi-Tenant

Plateforme SaaS multi-entreprises pour la gestion de restaurants, pâtisseries et points de vente (POS), construite sur **Node.js / TypeScript / Express** et **PostgreSQL 14+** avec isolation stricte par **Row-Level Security forcée (`FORCE ROW LEVEL SECURITY`)**.

---

## Architecture & Sécurité

- **Isolation multi-tenant (`FORCE RLS`)** sur 22 tables métier avec séparation de rôles :
  - `restogest_app` (`NOBYPASSRLS`) : rôle applicatif utilisé dans chaque transaction via `withTenantContext()` (`BEGIN` -> `SET LOCAL` -> `set_session_context()`).
  - `restogest_owner` (`NOBYPASSRLS`) : propriétaire DDL des tables métier (soumis au `FORCE RLS`).
  - `restogest_admin` (`BYPASSRLS`) : propriétaire des tables techniques de sécurité (`app_security_config`, `user_sessions`, `user_credentials`) et des fonctions `SECURITY DEFINER`.
- **Contexte de session signé SHA-256 :** `set_session_context()` vérifie `user_sessions` (non expirée, non révoquée, entreprise liée), génère une signature SHA-256 liée au secret serveur, au PID et à `transaction_timestamp()`, empêchant toute falsification GUC via `set_config()`.
- **Intégrité métier en base :**
  - Recettes sans cycle (`trg_lock_and_detect_recipe_cycle` + `pg_advisory_xact_lock`, profondeur max 50).
  - Stocks 3 modes (`direct`, `recipe_on_sale`, `none`), mouvements traçables et PMP calculé atomiquement dans `receive_purchase()`.
  - Ventes et caisses sérialisées (`FOR UPDATE` / `FOR SHARE`, machine à états stricte, réconciliation théorique/réelle, plafond cumulatif de remboursements).
  - Journal d'audit (`audit_logs`) alimenté par triggers et protégé en lecture seule.

Documentation SQL détaillée : [docs/ARCHITECTURE_DATABASE.md](docs/ARCHITECTURE_DATABASE.md).

---

## Démarrage rapide

### 1. Prérequis

- **Node.js 22+** (validé sur Node.js v24.19.0)
- **PostgreSQL 14+** (production) — ou mode embarqué `@electric-sql/pglite` (développement/tests locaux sans serveur PostgreSQL externe)

### 2. Installation & Configuration

```bash
npm install
cp .env.example .env
```

Configurer `.env` selon le mode choisi :

- **Mode embarqué (`PGlite`)** : `DATABASE_TYPE=embedded` et `PGLITE_DATA_DIR=./data/pglite`
- **Mode PostgreSQL externe (production / multi-connexions)** :
  - `DATABASE_TYPE=postgres`
  - `DATABASE_URL=postgresql://restogest_app:<mot_de_passe>@<hote>:5432/restogest`
  - `DATABASE_ADMIN_URL=postgresql://restogest_admin:<mot_de_passe>@<hote>:5432/restogest`
  - `JWT_SECRET=<clé secrète longue aléatoire>`

> **Note sur les migrations initiales PostgreSQL :** sur une base PostgreSQL vierge, exécuter le premier `npm run db:migrate` avec un rôle habilité à créer les rôles et la table `public.schema_migrations` (ex. `postgres`), puis définir les mots de passe de `restogest_admin` et `restogest_app` avant de démarrer l'API.

### 3. Migrations & Seed

```bash
# Appliquer les 8 migrations ordonnées (src/schema/migrations/001..008)
npm run db:migrate

# Injecter le jeu de données de démonstration (optionnel)
npm run db:seed
```

### 4. Développement & Production

```bash
# Mode développement
npm run dev

# Build TypeScript et exécution production
npm run build
npm start
```

---

## Endpoints API Principaux

- `GET /` — Interface Web complète RestoGest (POS, Catalogue, Stocks, Achats, Caisse)
- `GET /api` & `GET /health` — Index JSON de l'API & état du moteur PostgreSQL/PGlite
- `/api/auth` — `POST /register`, `POST /login`, `GET /me`, `POST /logout` (révocation immédiate en base)
- `/api/catalog` — Catégories, produits et recettes (`GET`/`POST`)
- `/api/inventory` — Niveaux, alertes, valorisation (`GET /summary`), mouvements et ajustements (`POST /adjustments`)
- `/api/purchases` — Fournisseurs, commandes d'achat, articles, réception (`POST /:id/receive`) et annulation (`POST /:id/cancel`)
- `/api/sales` — Commandes, articles, paiements, validation atomique (`POST /:id/complete`), annulation (`POST /:id/cancel`) et ticket (`GET /:id/receipt`)
- `/api/cash` — Ouverture (`POST /sessions/open`), suivi, dépenses (`/expenses`) et clôture réconciliée (`POST /sessions/:id/close`)

---

## Validation & Tests

```bash
# Typecheck + Build
npx tsc --noEmit
npm run build

# Tests unitaires & intégration HTTP Express (Vitest)
npm test

# Validation statique + simulation SQLite + PGlite (40/40) + migrations 001..008 + seed
npm run test:schema

# Suite SQL complète sur serveur PostgreSQL réel (40 scénarios)
psql -U restogest_admin -d restogest_test -v ON_ERROR_STOP=1 -f tests/test_suite_v1.sql

# Tests de concurrence parallèles sur PostgreSQL TCP (6 scénarios multi-sessions)
npm run test:concurrency
```

---

## Déploiement Vercel (`.vercel.app`)

Le dépôt est configuré pour le support natif Express sur Vercel ([src/index.ts](src/index.ts) et [vercel.json](vercel.json)) :

1. Configurer une base **PostgreSQL 14+ managée** (Neon, Supabase, RDS...) et y appliquer `npm run db:migrate`.
2. Définir les variables d'environnement dans le projet Vercel (Production & Preview) :
   - `NODE_ENV=production`
   - `DATABASE_TYPE=postgres`
   - `DATABASE_URL` (`restogest_app`)
   - `DATABASE_ADMIN_URL` (`restogest_admin`)
   - `JWT_SECRET` (secret aléatoire robuste)
3. Connecter le CLI et déployer en production :

```bash
vercel login
vercel --prod
```
