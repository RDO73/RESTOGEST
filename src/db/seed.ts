import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminPool } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runSeed() {
  console.log('[SEED] Injection des données de démonstration...');
  const seedCandidates = [
    path.resolve(__dirname, '../schema/seeds/seed_demo.sql'),
    path.resolve(__dirname, '../../src/schema/seeds/seed_demo.sql'),
  ];
  const seedPath = seedCandidates.find((p) => fs.existsSync(p));

  if (!seedPath) {
    throw new Error(`Fichier de seed introuvable : ${seedCandidates.join(' | ')}`);
  }

  const sql = fs.readFileSync(seedPath, 'utf-8');

  try {
    if ('exec' in adminPool && typeof (adminPool as any).exec === 'function') {
      await (adminPool as any).exec(sql);
    } else {
      const client = await adminPool.connect();
      try {
        await client.query(sql);
      } finally {
        client.release();
      }
    }
    console.log('[SEED] Données de démonstration injectées avec succès !');
  } catch (error) {
    console.error('[SEED ERROR]', error);
    process.exit(1);
  } finally {
    await adminPool.end();
  }
}

runSeed();
