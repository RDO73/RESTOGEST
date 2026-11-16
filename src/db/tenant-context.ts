import type { IDbClient } from './pool.js';
import { appPool } from './pool.js';
import { config } from '../config/env.js';

export interface TenantContext {
  tokenHash: string;
  companyId: string;
}

/**
 * Exécute une opération métier dans une transaction hermétique,
 * avec initialisation stricte des variables de session via set_session_context()
 * et exécution forcée sous le rôle non privilégié restogest_app.
 */
export async function withTenantContext<T>(
  context: TenantContext,
  operation: (client: IDbClient) => Promise<T>
): Promise<T> {
  const client = await appPool.connect();

  try {
    await client.query('BEGIN');

    // En mode PGlite embarqué (mono-connexion), forcer l'abaissement des privilèges vers restogest_app
    if (config.databaseType === 'embedded') {
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
