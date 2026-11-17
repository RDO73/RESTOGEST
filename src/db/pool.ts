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
  private mutexChain: Promise<void> = Promise.resolve();
  private readonly dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = path.resolve(dataDir);
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
  }

  private acquireMutex(): Promise<() => void> {
    let releaseNext!: () => void;
    const nextPromise = new Promise<void>((resolve) => {
      releaseNext = resolve;
    });
    const prev = this.mutexChain;
    this.mutexChain = prev.then(() => nextPromise);
    return prev.then(() => {
      let released = false;
      return () => {
        if (!released) {
          released = true;
          releaseNext();
        }
      };
    });
  }

  private async getInstance(): Promise<PGlite> {
    if (this.pgliteInstance) {
      return this.pgliteInstance;
    }
    if (!this.initPromise) {
      this.initPromise = (async () => {
        if (!fs.existsSync(this.dataDir)) {
          fs.mkdirSync(this.dataDir, { recursive: true });
        }
        const db = new PGlite(this.dataDir);
        await db.waitReady;

        const reg = await db.query<{ mig: string | null; comp: string | null; dt: string | null; sc: string | null }>(
          "SELECT to_regclass('public.schema_migrations') AS mig, to_regclass('public.companies') AS comp, to_regclass('public.dining_tables') AS dt, to_regclass('public.saas_countries') AS sc"
        );
        let has011 = false;
        if (reg.rows[0]?.mig) {
          const m011 = await db.query(
            "SELECT 1 FROM public.schema_migrations WHERE filename = '011_sn_gn_focus_and_superadmin.sql' LIMIT 1"
          );
          has011 = m011.rows.length > 0;
        }
        if (!reg.rows[0]?.mig || !reg.rows[0]?.comp || !reg.rows[0]?.dt || !reg.rows[0]?.sc || !has011) {
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

        this.pgliteInstance = db;
        return db;
      })();
    }
    return this.initPromise;
  }

  async query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number }> {
    const db = await this.getInstance();
    const release = await this.acquireMutex();
    try {
      const res = await db.query(text, params);
      return {
        rows: res.rows,
        rowCount: res.rows.length,
      };
    } finally {
      release();
    }
  }

  async exec(sql: string): Promise<void> {
    const db = await this.getInstance();
    const release = await this.acquireMutex();
    try {
      await db.exec(sql);
    } finally {
      release();
    }
  }

  async connect(): Promise<IDbClient> {
    const db = await this.getInstance();
    const release = await this.acquireMutex();
    return {
      query: async (text: string, params?: any[]) => {
        const res = await db.query(text, params);
        return {
          rows: res.rows,
          rowCount: res.rows.length,
        };
      },
      release,
    };
  }

  async end(): Promise<void> {
    this.initPromise = null;
    if (this.pgliteInstance) {
      await this.pgliteInstance.close();
      this.pgliteInstance = null;
    }
  }

  async resetColdStart(): Promise<void> {
    await this.end();
    if (fs.existsSync(this.dataDir)) {
      fs.rmSync(this.dataDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.dataDir, { recursive: true });
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
  const buildPgConfig = (connectionString: string, max: number) => {
    const isLocal = /@(localhost|127\.0\.0\.1)(:|\/|$)/i.test(connectionString);
    const disableSsl = /sslmode=disable/i.test(connectionString);
    return {
      connectionString,
      max,
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 8000,
      ...(isLocal || disableSsl ? {} : { ssl: { rejectUnauthorized: false } }),
    };
  };

  appPoolInstance = new Pool(buildPgConfig(config.databaseUrl, 12));
  adminPoolInstance = new Pool(buildPgConfig(config.databaseAdminUrl, 5));

  (appPoolInstance as any).on('error', (err: any) => {
    console.error('[DATABASE APP POOL ERROR]', err);
  });

  (adminPoolInstance as any).on('error', (err: any) => {
    console.error('[DATABASE ADMIN POOL ERROR]', err);
  });
}

let pgReadyPromise: Promise<void> | null = null;

/**
 * Vérifie et applique automatiquement les 8 migrations SQL sur une base PostgreSQL
 * distante vierge (ex: Neon / Supabase via Vercel Marketplace), avec verrou consultatif.
 */
export async function ensureDatabaseReady(): Promise<void> {
  if (config.databaseType !== 'postgres') {
    await appPoolInstance.query('SELECT 1');
    return;
  }
  if (!pgReadyPromise) {
    pgReadyPromise = (async () => {
      try {
        const probe = await adminPoolInstance.query(
          "SELECT to_regclass('public.schema_migrations') AS mig, to_regclass('public.companies') AS comp, to_regclass('public.dining_tables') AS dt, to_regclass('public.saas_countries') AS sc"
        );
        if (probe.rows[0]?.mig && probe.rows[0]?.comp && probe.rows[0]?.dt && probe.rows[0]?.sc) {
          const m011 = await adminPoolInstance.query(
            "SELECT 1 FROM public.schema_migrations WHERE filename = '011_sn_gn_focus_and_superadmin.sql' LIMIT 1"
          );
          if (m011.rows.length > 0) {
            return;
          }
        }

        const lockClient = await adminPoolInstance.connect();
        try {
          await lockClient.query('SELECT pg_advisory_lock(73910421)');
          try {
            const { applyMigrations } = await import('./migrate.js');
            await applyMigrations(adminPoolInstance);
          } finally {
            await lockClient.query('SELECT pg_advisory_unlock(73910421)').catch(() => {});
          }
        } finally {
          lockClient.release();
        }
      } catch (err) {
        pgReadyPromise = null;
        throw err;
      }
    })();
  }
  return pgReadyPromise;
}

export async function resetEmbeddedDatabaseForColdStartSimulation(): Promise<void> {
  pgReadyPromise = null;
  if (appPoolInstance instanceof PGlitePoolAdapter) {
    await appPoolInstance.resetColdStart();
  }
}

export const appPool = appPoolInstance;
export const adminPool = adminPoolInstance;
