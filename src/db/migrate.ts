import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminPool, type IDbPool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveMigrationsDir(customDir?: string): string {
  if (customDir) {
    return path.resolve(customDir);
  }
  const candidates = [
    path.resolve(__dirname, '../schema/migrations'),
    path.resolve(__dirname, '../../src/schema/migrations'),
    path.resolve(process.cwd(), 'dist/schema/migrations'),
    path.resolve(process.cwd(), 'src/schema/migrations'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      return dir;
    }
  }
  throw new Error(`Répertoire des migrations introuvable : ${candidates.join(' | ')}`);
}

async function execSql(pool: IDbPool, sql: string): Promise<void> {
  if ('exec' in pool && typeof (pool as any).exec === 'function') {
    await (pool as any).exec(sql);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

export function getLatestMigrationFilename(migrationsDir?: string): string {
  const dir = resolveMigrationsDir(migrationsDir);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (files.length === 0) {
    throw new Error(`Aucun fichier de migration trouvé dans : ${dir}`);
  }
  return files[files.length - 1];
}

export async function applyMigrations(
  pool: IDbPool = adminPool,
  migrationsDir?: string
): Promise<{ applied: string[]; skipped: string[] }> {
  const dir = resolveMigrationsDir(migrationsDir);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/i.test(f))
    .sort((a, b) => a.localeCompare(b, 'en'));

  if (files.length === 0) {
    throw new Error(`Aucun fichier de migration trouvé dans : ${dir}`);
  }

  const regRes = await pool.query("SELECT to_regclass('public.schema_migrations') AS reg");
  if (!regRes.rows[0]?.reg) {
    await execSql(
      pool,
      `CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        checksum_sha256 CHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );`
    );
  }

  const existingRes = await pool.query(
    'SELECT filename, checksum_sha256 FROM public.schema_migrations'
  );
  const existing = new Map<string, string>(
    existingRes.rows.map((r: any) => [String(r.filename), String(r.checksum_sha256)])
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const fullPath = path.join(dir, file);
    const sql = fs.readFileSync(fullPath, 'utf-8');
    const checksum = crypto.createHash('sha256').update(sql).digest('hex');

    if (existing.has(file)) {
      const recordedChecksum = existing.get(file);
      if (recordedChecksum !== checksum) {
        throw new Error(
          `Somme de contrôle modifiée pour la migration déjà appliquée "${file}" (attendu ${recordedChecksum}, trouvé ${checksum}).`
        );
      }
      skipped.push(file);
      continue;
    }

    if ('exec' in pool && typeof (pool as any).exec === 'function') {
      await (pool as any).exec('BEGIN;');
      try {
        await (pool as any).exec(sql);
        await pool.query(
          'INSERT INTO public.schema_migrations (filename, checksum_sha256) VALUES ($1, $2)',
          [file, checksum]
        );
        await (pool as any).exec('COMMIT;');
      } catch (err) {
        await (pool as any).exec('ROLLBACK;').catch(() => {});
        throw new Error(`Échec de la migration "${file}": ${(err as Error).message}`);
      }
    } else {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO public.schema_migrations (filename, checksum_sha256) VALUES ($1, $2)',
          [file, checksum]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Échec de la migration "${file}": ${(err as Error).message}`);
      } finally {
        client.release();
      }
    }

    applied.push(file);
  }

  return { applied, skipped };
}

async function runMigration() {
  console.log('[MIGRATION] Application des migrations ordonnées V1...');
  const { applied, skipped } = await applyMigrations(adminPool);
  console.log(
    `[MIGRATION] Terminé : ${applied.length} appliquée(s) [${applied.join(', ') || 'aucune'}], ${skipped.length} déjà à jour.`
  );
}

const isMain =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMain) {
  runMigration()
    .catch((error) => {
      console.error('[MIGRATION ERROR]', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await adminPool.end();
    });
}
