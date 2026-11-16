import express from 'express';
import { authRouter } from './modules/auth/auth.router.js';
import { catalogRouter } from './modules/catalog/catalog.router.js';
import { salesRouter } from './modules/sales/sales.router.js';
import { purchasesRouter } from './modules/purchases/purchases.router.js';
import { inventoryRouter } from './modules/inventory/inventory.router.js';
import { cashRouter } from './modules/cash/cash.router.js';
import { errorHandler } from './middlewares/error-handler.js';

export const app = express();

app.use(express.json());

// Endpoint de santé
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'RESTOGEST API V1',
    timestamp: new Date().toISOString(),
  });
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
