import crypto from 'node:crypto';
import { adminPool } from './pool.js';
import { config } from '../config/env.js';
import { isTokenRevoked } from '../auth/jwt.js';

export const DEMO_TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DEMO_USER_ID = '00000000-0000-4000-8000-000000000002';
export const DEMO_ROLE_ID = '00000000-0000-4000-8000-000000000003';
export const DEMO_EMAIL = 'demo@restogest.sn';
export const DEMO_FULL_NAME = 'Chef Amadou';
export const DEMO_COMPANY_NAME = 'Le Palais Gourmand (Démo)';

export const DEMO_CAT_BOISSONS = '00000000-0000-4000-8000-000000000011';
export const DEMO_CAT_PATISSERIE = '00000000-0000-4000-8000-000000000012';
export const DEMO_CAT_ING = '00000000-0000-4000-8000-000000000013';

export const DEMO_PROD_GRAIN = '00000000-0000-4000-8000-000000000021';
export const DEMO_PROD_FARINE = '00000000-0000-4000-8000-000000000022';
export const DEMO_PROD_SUCRE = '00000000-0000-4000-8000-000000000023';
export const DEMO_PROD_ESPRESSO = '00000000-0000-4000-8000-000000000024';
export const DEMO_PROD_CROISSANT = '00000000-0000-4000-8000-000000000025';

export const DEMO_RECIPE_ESPRESSO = '00000000-0000-4000-8000-000000000031';
export const DEMO_SUPPLIER_ID = '00000000-0000-4000-8000-000000000041';
export const DEMO_PURCHASE_ID = '00000000-0000-4000-8000-000000000042';
export const DEMO_CASH_SESSION_ID = '00000000-0000-4000-8000-000000000051';

const DEMO_PASSWORD_HASH_PLACEHOLDER =
  '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$abcdefghijklmnopqrstuvwxyz1234567890';

export interface StatelessHydrationContext {
  tokenHash: string;
  companyId: string;
  tenantId?: string;
  userId?: string;
  role?: string;
  email?: string;
  fullName?: string;
  companyName?: string;
  businessType?: 'restaurant' | 'pastry_shop' | 'both';
  currency?: string;
  isDemo?: boolean;
}

function createSessionAuthError(message: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = 'P0001';
  return err;
}

let demoSeedMutex: Promise<void> = Promise.resolve();
let standardHydrateMutex: Promise<void> = Promise.resolve();

// Cache mémoire court des sessions déjà présentes en base (évite la sérialisation sur adminPool lors de requêtes parallèles)
const hydratedSessions = new Map<string, number>();
const HYDRATION_CACHE_TTL_MS = 60_000;
let demoEnvironmentSeeded = false;

export function clearHydrationCaches(): void {
  hydratedSessions.clear();
  demoEnvironmentSeeded = false;
}

export function evictHydratedSession(tokenHash: string): void {
  hydratedSessions.delete(tokenHash);
}

function isSessionCachedAsHydrated(tokenHash?: string): boolean {
  if (!tokenHash) return false;
  const ts = hydratedSessions.get(tokenHash);
  if (!ts) return false;
  if (Date.now() - ts > HYDRATION_CACHE_TTL_MS) {
    hydratedSessions.delete(tokenHash);
    return false;
  }
  return true;
}

function markSessionHydrated(tokenHash?: string): void {
  if (!tokenHash) return;
  hydratedSessions.set(tokenHash, Date.now());
  if (hydratedSessions.size > 500) {
    const oldest = hydratedSessions.keys().next().value;
    if (oldest) hydratedSessions.delete(oldest);
  }
}

function runSerialized(mutex: 'demo' | 'standard', task: () => Promise<void>): Promise<void> {
  const prev = mutex === 'demo' ? demoSeedMutex : standardHydrateMutex;
  const next = prev.then(task, task);
  if (mutex === 'demo') {
    demoSeedMutex = next.catch(() => {});
  } else {
    standardHydrateMutex = next.catch(() => {});
  }
  return next;
}

/**
 * Initialise de façon déterministe et idempotente l'établissement démo,
 * ses produits, sa recette Espresso, son achat reçu PMP, sa caisse ouverte et sa session.
 */
export async function ensureDemoEnvironment(tokenHash?: string): Promise<void> {
  if (tokenHash && isTokenRevoked(tokenHash)) {
    throw createSessionAuthError('Authentification refusée : session invalide, expirée ou révoquée');
  }
  if (demoEnvironmentSeeded && isSessionCachedAsHydrated(tokenHash)) {
    return;
  }

  return runSerialized('demo', async () => {
    if (tokenHash && isTokenRevoked(tokenHash)) {
      throw createSessionAuthError('Authentification refusée : session invalide, expirée ou révoquée');
    }

    if (demoEnvironmentSeeded && isSessionCachedAsHydrated(tokenHash)) {
      return;
    }

    if (tokenHash) {
      const tokRes = await adminPool.query(
        'SELECT revoked_at FROM public.user_sessions WHERE token_hash = $1',
        [tokenHash]
      );
      if (tokRes.rows[0]?.revoked_at) {
        evictHydratedSession(tokenHash);
        throw createSessionAuthError('Authentification refusée : session invalide, expirée ou révoquée');
      }
      if (demoEnvironmentSeeded && tokRes.rows.length > 0) {
        markSessionHydrated(tokenHash);
        return;
      }
    }

    const probe = await adminPool.query(
      `SELECT
         EXISTS (SELECT 1 FROM public.companies WHERE id = $1) AS has_company,
         EXISTS (SELECT 1 FROM public.products WHERE id = $2 AND company_id = $1) AS has_espresso`,
      [DEMO_TENANT_ID, DEMO_PROD_ESPRESSO]
    );

    const hasCompany = Boolean(probe.rows[0]?.has_company);
    const hasEspresso = Boolean(probe.rows[0]?.has_espresso);

    if (hasCompany && hasEspresso) {
      demoEnvironmentSeeded = true;
      if (tokenHash) {
        await adminPool.query(
          `INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
           ON CONFLICT DO NOTHING`,
          [DEMO_USER_ID, DEMO_TENANT_ID, tokenHash]
        );
        markSessionHydrated(tokenHash);
      }
      return;
    }

    const effectiveTokenHash =
      tokenHash || `demo_bootstrap_${crypto.randomUUID().replace(/-/g, '')}`.slice(0, 64);

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO public.companies (id, name, business_type, currency, default_tax_rate, allow_negative_stock, is_active)
         VALUES ($1, $2, 'both', 'XOF', 0, FALSE, TRUE)
         ON CONFLICT DO NOTHING`,
        [DEMO_TENANT_ID, DEMO_COMPANY_NAME]
      );

      await client.query(
        `INSERT INTO public.users (id, email, full_name, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [DEMO_USER_ID, DEMO_EMAIL, DEMO_FULL_NAME]
      );

      await client.query(
        `INSERT INTO public.user_credentials (user_id, password_hash, algo)
         VALUES ($1, $2, 'argon2id')
         ON CONFLICT DO NOTHING`,
        [DEMO_USER_ID, DEMO_PASSWORD_HASH_PLACEHOLDER]
      );

      await client.query(
        `INSERT INTO public.roles (id, company_id, name, permissions)
         VALUES ($1, $2, 'Propriétaire', '{"all": true}'::jsonb)
         ON CONFLICT DO NOTHING`,
        [DEMO_ROLE_ID, DEMO_TENANT_ID]
      );

      await client.query(
        `INSERT INTO public.company_users (company_id, user_id, role_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [DEMO_TENANT_ID, DEMO_USER_ID, DEMO_ROLE_ID]
      );

      await client.query(
        `INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')
         ON CONFLICT DO NOTHING`,
        [DEMO_USER_ID, DEMO_TENANT_ID, effectiveTokenHash]
      );

      await client.query(
        'SELECT public.set_session_context($1::VARCHAR, $2::UUID)',
        [effectiveTokenHash, DEMO_TENANT_ID]
      );

      // 1. Catégories
      await client.query(
        `INSERT INTO public.categories (id, company_id, name, description)
         VALUES
           ($1, $4, 'Boissons', 'Cafés, thés et rafraîchissements'),
           ($2, $4, 'Pâtisseries', 'Viennoiseries et gâteaux maison'),
           ($3, $4, 'Matières Premières', 'Ingrédients de torréfaction et laboratoire')
         ON CONFLICT DO NOTHING`,
        [DEMO_CAT_BOISSONS, DEMO_CAT_PATISSERIE, DEMO_CAT_ING, DEMO_TENANT_ID]
      );

      // 2. Produits (ingrédients + produits finis)
      await client.query(
        `INSERT INTO public.products (id, company_id, category_id, name, product_type, unit, selling_price, cost_price, inventory_tracking, min_stock_alert)
         VALUES
           ($1, $6, $7, 'Grains Café Arabica', 'raw_material', 'kg', 0, 8000, 'direct', 2),
           ($2, $6, $7, 'Farine Pâtissière T55', 'raw_material', 'kg', 0, 600, 'direct', 5),
           ($3, $6, $7, 'Sucre Fin', 'raw_material', 'kg', 0, 750, 'direct', 5),
           ($4, $6, $8, 'Café Espresso', 'finished_good', 'tasse', 1500, 170, 'recipe_on_sale', 0),
           ($5, $6, $9, 'Croissant Pur Beurre', 'finished_good', 'pièce', 900, 350, 'direct', 10)
         ON CONFLICT DO NOTHING`,
        [
          DEMO_PROD_GRAIN,
          DEMO_PROD_FARINE,
          DEMO_PROD_SUCRE,
          DEMO_PROD_ESPRESSO,
          DEMO_PROD_CROISSANT,
          DEMO_TENANT_ID,
          DEMO_CAT_ING,
          DEMO_CAT_BOISSONS,
          DEMO_CAT_PATISSERIE,
        ]
      );

      // 3. Fiche recette Espresso (20g de Grains Café Arabica par tasse)
      await client.query(
        `INSERT INTO public.recipes (id, company_id, finished_product_id, name, output_quantity, instructions, is_active)
         VALUES ($1, $2, $3, 'Extraction Espresso 20g', 1, '1 tasse espresso standard (20g de café moulu)', TRUE)
         ON CONFLICT DO NOTHING`,
        [DEMO_RECIPE_ESPRESSO, DEMO_TENANT_ID, DEMO_PROD_ESPRESSO]
      );

      await client.query(
        `INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
         VALUES ($1, $2, $3, 0.020)
         ON CONFLICT DO NOTHING`,
        [DEMO_TENANT_ID, DEMO_RECIPE_ESPRESSO, DEMO_PROD_GRAIN]
      );

      // 4. Fournisseur & Achat initial avec réception PMP
      await client.query(
        `INSERT INTO public.suppliers (id, company_id, name, phone)
         VALUES ($1, $2, 'Grands Moulins & Torréfaction', '+221 77 000 00 00')
         ON CONFLICT DO NOTHING`,
        [DEMO_SUPPLIER_ID, DEMO_TENANT_ID]
      );

      await client.query(
        `INSERT INTO public.purchases (id, company_id, supplier_id, user_id, reference, notes, total_amount, status)
         VALUES ($1, $2, $3, $4, 'ACH-DEMO-INIT-001', 'Dotation initiale démo', 118000, 'ordered')
         ON CONFLICT DO NOTHING`,
        [DEMO_PURCHASE_ID, DEMO_TENANT_ID, DEMO_SUPPLIER_ID, DEMO_USER_ID]
      );

      const purchaseStatusRes = await client.query(
        'SELECT status FROM public.purchases WHERE id = $1 AND company_id = $2',
        [DEMO_PURCHASE_ID, DEMO_TENANT_ID]
      );

      if (purchaseStatusRes.rows[0]?.status === 'ordered') {
        await client.query(
          `INSERT INTO public.purchase_items (company_id, purchase_id, product_id, quantity, unit_cost, subtotal)
           SELECT $1::UUID, $2::UUID, v.product_id, v.qty, v.cost, v.sub
           FROM (
             VALUES
               ($3::UUID, 10::NUMERIC(14,3), 8500::NUMERIC(14,4), 85000::NUMERIC(14,2)),
               ($4::UUID, 50::NUMERIC(14,3), 600::NUMERIC(14,4), 30000::NUMERIC(14,2)),
               ($5::UUID, 4::NUMERIC(14,3), 750::NUMERIC(14,4), 3000::NUMERIC(14,2))
           ) AS v(product_id, qty, cost, sub)
           WHERE NOT EXISTS (
             SELECT 1 FROM public.purchase_items pi WHERE pi.purchase_id = $2::UUID
           )`,
          [DEMO_TENANT_ID, DEMO_PURCHASE_ID, DEMO_PROD_GRAIN, DEMO_PROD_FARINE, DEMO_PROD_SUCRE]
        );

        await client.query('SELECT public.receive_purchase($1::UUID)', [DEMO_PURCHASE_ID]);
      }

      // 5. Fournée initiale de Croissants si aucun mouvement encore enregistré
      const croissantMovRes = await client.query(
        'SELECT 1 FROM public.stock_movements WHERE company_id = $1::UUID AND product_id = $2::UUID LIMIT 1',
        [DEMO_TENANT_ID, DEMO_PROD_CROISSANT]
      );
      if (croissantMovRes.rows.length === 0) {
        await client.query(
          `SELECT public.record_stock_adjustment($1::UUID, 'production_in', 30, 'Fournée démo du matin')`,
          [DEMO_PROD_CROISSANT]
        );
      }

      // 6. Caisse ouverte (50 000 XOF)
      await client.query(
        `INSERT INTO public.cash_sessions (id, company_id, opened_by, opening_amount, status)
         SELECT $1::UUID, $2::UUID, $3::UUID, 50000, 'open'
         WHERE NOT EXISTS (
           SELECT 1 FROM public.cash_sessions WHERE company_id = $2::UUID AND status = 'open'
         )
         ON CONFLICT DO NOTHING`,
        [DEMO_CASH_SESSION_ID, DEMO_TENANT_ID, DEMO_USER_ID]
      );

      // 7. Abonnement d'essai 14 jours pour l'environnement de démo
      await client.query(
        `INSERT INTO public.company_subscriptions (
           company_id, plan_code, status, billing_period,
           starts_at, ends_at, trial_ends_at, current_period_start, current_period_end, updated_at
         )
         VALUES (
           $1, 'PRO', 'trial', 'monthly',
           NOW(), NOW() + INTERVAL '14 days', NOW() + INTERVAL '14 days', NOW(), NOW() + INTERVAL '14 days', NOW()
         )
         ON CONFLICT (company_id) DO NOTHING`,
        [DEMO_TENANT_ID]
      );

      await client.query('COMMIT');
      demoEnvironmentSeeded = true;
      if (tokenHash) {
        markSessionHydrated(tokenHash);
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}

/**
 * Réhydrate de façon stateless une session signée HMAC-SHA256 lorsque la base
 * en mémoire (pglite-ephemeral) a redémarré sur cold start Serverless.
 */
export async function ensureSessionHydrated(context: StatelessHydrationContext): Promise<void> {
  if (isTokenRevoked(context.tokenHash)) {
    throw createSessionAuthError('Authentification refusée : session invalide, expirée ou révoquée');
  }

  const targetCompanyId = context.companyId || context.tenantId;
  if (
    context.isDemo ||
    targetCompanyId === DEMO_TENANT_ID ||
    context.tenantId === DEMO_TENANT_ID
  ) {
    await ensureDemoEnvironment(context.tokenHash);
    return;
  }

  if (isSessionCachedAsHydrated(context.tokenHash)) {
    return;
  }

  return runSerialized('standard', async () => {
    if (isSessionCachedAsHydrated(context.tokenHash)) {
      return;
    }

    const existingRes = await adminPool.query(
      'SELECT revoked_at, expires_at FROM public.user_sessions WHERE token_hash = $1',
      [context.tokenHash]
    );

    if (existingRes.rows.length > 0) {
      const row = existingRes.rows[0];
      if (row.revoked_at) {
        evictHydratedSession(context.tokenHash);
        throw createSessionAuthError('Authentification refusée : session invalide, expirée ou révoquée');
      }
      markSessionHydrated(context.tokenHash);
      return;
    }

    // En mode PostgreSQL persistant (Neon), ne jamais recréer une session absente
    if (config.databaseType === 'postgres') {
      return;
    }

    if (!context.userId || !targetCompanyId) {
      return;
    }

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO public.companies (id, name, business_type, currency, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT DO NOTHING`,
        [
          targetCompanyId,
          context.companyName || 'Mon Établissement',
          context.businessType || 'both',
          context.currency || 'XOF',
        ]
      );

      const fallbackEmail = (context.email || `user_${context.userId.slice(0, 8)}@restogest.sn`).toLowerCase();
      await client.query(
        `INSERT INTO public.users (id, email, full_name, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [context.userId, fallbackEmail, context.fullName || 'Responsable']
      );

      await client.query(
        `INSERT INTO public.user_credentials (user_id, password_hash, algo)
         VALUES ($1, $2, 'argon2id')
         ON CONFLICT DO NOTHING`,
        [context.userId, DEMO_PASSWORD_HASH_PLACEHOLDER]
      );

      const roleRes = await client.query(
        `SELECT id FROM public.roles WHERE company_id = $1 AND name = 'Propriétaire' LIMIT 1`,
        [targetCompanyId]
      );
      let roleId: string;
      if (roleRes.rows.length > 0) {
        roleId = roleRes.rows[0].id;
      } else {
        roleId = crypto.randomUUID();
        await client.query(
          `INSERT INTO public.roles (id, company_id, name, permissions)
           VALUES ($1, $2, 'Propriétaire', '{"all": true}'::jsonb)
           ON CONFLICT DO NOTHING`,
          [roleId, targetCompanyId]
        );
      }

      await client.query(
        `INSERT INTO public.company_users (company_id, user_id, role_id, is_active)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [targetCompanyId, context.userId, roleId]
      );

      await client.query(
        `INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '24 hours')
         ON CONFLICT DO NOTHING`,
        [context.userId, targetCompanyId, context.tokenHash]
      );

      await client.query(
        `INSERT INTO public.company_subscriptions (
           company_id, plan_code, status, billing_period,
           starts_at, ends_at, trial_ends_at, current_period_start, current_period_end, updated_at
         )
         VALUES (
           $1, 'PRO', 'trial', 'monthly',
           NOW(), NOW() + INTERVAL '14 days', NOW() + INTERVAL '14 days', NOW(), NOW() + INTERVAL '14 days', NOW()
         )
         ON CONFLICT (company_id) DO NOTHING`,
        [targetCompanyId]
      );

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  });
}
