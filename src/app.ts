import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config/env.js';
import { adminPool, ensureDatabaseReady } from './db/pool.js';
import { authRouter } from './modules/auth/auth.router.js';
import { catalogRouter } from './modules/catalog/catalog.router.js';
import { salesRouter } from './modules/sales/sales.router.js';
import { purchasesRouter } from './modules/purchases/purchases.router.js';
import { inventoryRouter } from './modules/inventory/inventory.router.js';
import { cashRouter } from './modules/cash/cash.router.js';
import { errorHandler } from './middlewares/error-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

app.use(express.json());

const publicCandidates = [
  path.resolve(__dirname, './public'),
  path.resolve(__dirname, '../src/public'),
  path.resolve(process.cwd(), 'dist/public'),
  path.resolve(process.cwd(), 'src/public'),
];
const publicDir = publicCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')));

if (publicDir) {
  app.use(express.static(publicDir));
}

const databaseMode =
  config.databaseType === 'postgres'
    ? 'postgres'
    : process.env.VERCEL
      ? 'pglite-ephemeral'
      : 'pglite-local';

const apiInfoPayload = () => ({
  service: 'RESTOGEST API V1',
  status: 'ok',
  database: databaseMode,
  health: '/health',
  endpoints: [
    '/api/auth',
    '/api/catalog',
    '/api/sales',
    '/api/purchases',
    '/api/inventory',
    '/api/cash',
  ],
});

// Interface Web principale sur /
app.get('/', (_req, res) => {
  if (publicDir) {
    res.sendFile(path.join(publicDir, 'index.html'));
    return;
  }
  res.json(apiInfoPayload());
});

app.get('/api', (_req, res) => {
  res.json(apiInfoPayload());
});

app.get('/health', async (_req, res, next) => {
  try {
    if (config.databaseType === 'postgres') {
      await ensureDatabaseReady();
      await adminPool.query('SELECT 1');
    }
    res.json({
      status: 'ok',
      service: 'RESTOGEST API V1',
      database: databaseMode,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

// Enregistrement des modules API
app.use('/api/auth', authRouter);
app.use('/api/catalog', catalogRouter);
app.use('/api/sales', salesRouter);
app.use('/api/purchases', purchasesRouter);
app.use('/api/inventory', inventoryRouter);
app.use('/api/cash', cashRouter);

// Gestionnaire global d'erreurs
app.use(errorHandler);

export default app;
