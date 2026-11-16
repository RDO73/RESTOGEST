import type { IDbClient } from './pool.js';
import { appPool, ensureDatabaseReady } from './pool.js';
import { config } from '../config/env.js';
import { ensureSessionHydrated, type StatelessHydrationContext } from './demo-seed.js';

export type TenantContext = StatelessHydrationContext;

let cachedDropToAppRole: boolean | null = config.databaseType === 'embedded' ? true : null;

export function resetTenantRoleCache(): void {
  cachedDropToAppRole = config.databaseType === 'embedded' ? true : null;
}

/**
 * Exécute une opération métier dans une transaction hermétique,
 * avec réhydratation stateless (cold-start démo / cookie JWT), initialisation stricte
 * des variables de session via set_session_context() et exécution forcée sous restogest_app.
 */
export async function withTenantContext<T>(
  context: TenantContext,
  operation: (client: IDbClient) => Promise<T>
): Promise<T> {
  await ensureDatabaseReady();
  await ensureSessionHydrated(context);

  const client = await appPool.connect();

  try {
    await client.query('BEGIN');

    if (cachedDropToAppRole === null) {
      const roleCheck = await client.query(
        `SELECT (
           current_user <> 'restogest_app'
           AND EXISTS (
             SELECT 1 FROM pg_catalog.pg_roles
             WHERE rolname = 'restogest_app'
               AND pg_has_role(current_user, oid, 'MEMBER')
           )
         ) AS should_drop`
      );
      cachedDropToAppRole = Boolean(roleCheck.rows[0]?.should_drop);
    }

    // Abaissement des privilèges vers restogest_app (PGlite ou connexion cloud neondb_owner)
    if (cachedDropToAppRole) {
      await client.query('SET LOCAL ROLE restogest_app');
    }

    // Initialisation cryptographique de la session applicative
    await client.query(
      'SELECT public.set_session_context($1::VARCHAR, $2::UUID)',
      [context.tokenHash, context.companyId]
    );

    // Exécution du code applicatif sous RLS
    const result = await operation(client);

    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      console.error('[TRANSACTION ROLLBACK ERROR]', rollbackError);
    }
    throw error;
  } finally {
    client.release();
  }
}
