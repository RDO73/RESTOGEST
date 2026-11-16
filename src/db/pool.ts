import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { config } from '../config/env.js';

const { Pool } = pg;

export interface IDbClient {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
  release: () => void;
}

export interface IDbPool {
  query: (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount?: number }>;
  connect: () => Promise<IDbClient>;
  end: () => Promise<void>;
  on?: (event: any, handler: any) => any;
}

// Classe adaptatrice pour PGlite respectant l'interface Pool de pg
class PGlitePoolAdapter implements IDbPool {
  private pgliteInstance: PGlite | null = null;
  private initPromise: Promise<PGlite> | null = null;
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private async getInstance(): Promise<PGlite> {
    if (this.pgliteInstance) {
      return this.pgliteInstance;
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const db = new PGlite(this.dataDir);
        await db.waitReady;

        if (process.env.VERCEL) {
          const reg = await db.query<{ reg: string | null }>(
            "SELECT to_regclass('public.schema_migrations') AS reg"
          );
          if (!reg.rows[0]?.reg) {
            const bootstrapPool: IDbPool & { exec: (sql: string) => Promise<void> } = {
              query: async (text: string, params?: any[]) => {
                const res = await db.query(text, params);
                return { rows: res.rows, rowCount: res.rows.length };
              },
              exec: async (sql: string) => {
                await db.exec(sql);
              },
              connect: async () => ({
                query: async (text: string, params?: any[]) => {
                  const res = await db.query(text, params);
                  return { rows: res.rows, rowCount: res.rows.length };
                },
                release: () => {},
              }),
              end: async () => {},
            };
            const { applyMigrations } = await import('./migrate.js');
            await applyMigrations(bootstrapPool);
          }
        }

        this.pgliteInstance = db;
        return db;
      })();
    }
    return this.initPromise;
  }

  async query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number }> {
    const db = await this.getInstance();
    const res = await db.query(text, params);
    return {
      rows: res.rows,
      rowCount: res.rows.length,
    };
  }

  async exec(sql: string): Promise<void> {
    const db = await this.getInstance();
    await db.exec(sql);
  }

  async connect(): Promise<IDbClient> {
    const db = await this.getInstance();
    return {
      query: async (text: string, params?: any[]) => {
        const res = await db.query(text, params);
        return {
          rows: res.rows,
          rowCount: res.rows.length,
        };
      },
      release: () => {
        // En mode embarqué, pas de déconnexion physique nécessaire
      },
    };
  }

  async end(): Promise<void> {
    this.initPromise = null;
    if (this.pgliteInstance) {
      await this.pgliteInstance.close();
      this.pgliteInstance = null;
    }
  }

  on(_event: string, _handler: (err: any) => void): void {
    // Événements d'erreur de pool simulés
  }
}

let appPoolInstance: IDbPool;
let adminPoolInstance: IDbPool;

if (config.databaseType === 'embedded') {
  console.log(`[DATABASE] Mode base de données locale intégrée (PGlite) actif sur : ${config.pgliteDir}`);
  const embeddedPool = new PGlitePoolAdapter(config.pgliteDir);
  appPoolInstance = embeddedPool;
  adminPoolInstance = embeddedPool;
} else {
  console.log(`[DATABASE] Mode PostgreSQL externe actif`);
  appPoolInstance = new Pool({
    connectionString: config.databaseUrl,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  adminPoolInstance = new Pool({
    connectionString: config.databaseAdminUrl,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  (appPoolInstance as any).on('error', (err: any) => {
    console.error('[DATABASE APP POOL ERROR]', err);
  });

  (adminPoolInstance as any).on('error', (err: any) => {
    console.error('[DATABASE ADMIN POOL ERROR]', err);
  });
}

export const appPool = appPoolInstance;
export const adminPool = adminPoolInstance;
