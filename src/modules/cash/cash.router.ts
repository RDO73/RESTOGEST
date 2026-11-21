import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requirePermission } from '../../middlewares/auth-middleware.js';
import { withTenantContext } from '../../db/tenant-context.js';
import type { IDbClient } from '../../db/pool.js';
import { requireActiveSubscriptionWriteAccess } from '../subscriptions/subscription-guard.service.js';

export const cashRouter = Router();

function createHttpError(statusCode: number, message: string, code: string): Error & { statusCode: number; code: string } {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function parsePagination(rawLimit: unknown, rawOffset: unknown, defaultLimit = 50): { limit: number; offset: number } {
  const parsedLimit = Number.parseInt(String(rawLimit ?? ''), 10);
  const parsedOffset = Number.parseInt(String(rawOffset ?? ''), 10);
  return {
    limit: Math.min(200, Math.max(1, Number.isFinite(parsedLimit) ? parsedLimit : defaultLimit)),
    offset: Math.max(0, Number.isFinite(parsedOffset) ? parsedOffset : 0),
  };
}

cashRouter.use(requireAuth);
cashRouter.use(requireActiveSubscriptionWriteAccess);
cashRouter.use((req, res, next) => {
  if (req.method.toUpperCase() === 'GET') {
    requirePermission('cash:read', 'reports:read')(req, res, next);
  } else {
    requirePermission('cash:write')(req, res, next);
  }
});

async function buildZReportForSession(client: IDbClient, sessionRow: any) {
  const paymentsRes = await client.query(
    `SELECT payment_method, COALESCE(reference, '') AS reference, COALESCE(amount, 0) AS amount
     FROM public.payments
     WHERE cash_session_id = $1`,
    [sessionRow.id]
  );

  const paymentMap: Record<string, number> = {
    cash: 0,
    card: 0,
    mobile_money: 0,
    transfer: 0,
    check: 0,
    other: 0,
  };

  let wave = 0;
  let orangeMoney = 0;
  let otherMobileMoney = 0;

  for (const row of paymentsRes.rows) {
    const amt = parseFloat(row.amount || 0);
    const method = String(row.payment_method || 'other');
    const ref = String(row.reference || '').toLowerCase();

    paymentMap[method] = (paymentMap[method] || 0) + amt;

    if (method === 'mobile_money') {
      if (ref.includes('wave')) {
        wave += amt;
      } else if (ref.includes('orange') || ref.includes('om')) {
        orangeMoney += amt;
      } else {
        otherMobileMoney += amt;
      }
    }
  }

  const refRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) as total_cash_refunds
     FROM public.refunds
     WHERE cash_session_id = $1 AND refund_method = 'cash' AND status = 'completed'`,
    [sessionRow.id]
  );
  const totalCashRefunds = parseFloat(refRes.rows[0].total_cash_refunds);

  const expRes = await client.query(
    `SELECT COALESCE(SUM(amount), 0) as total_expenses
     FROM public.expenses
     WHERE cash_session_id = $1`,
    [sessionRow.id]
  );
  const totalExpenses = parseFloat(expRes.rows[0].total_expenses);

  const salesRes = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'completed')::INT AS tickets_count,
       COUNT(*) FILTER (WHERE status = 'cancelled')::INT AS cancelled_count,
       COALESCE(SUM(subtotal) FILTER (WHERE status = 'completed'), 0) AS gross_sales,
       COALESCE(SUM(discount_amount) FILTER (WHERE status = 'completed'), 0) AS total_discounts,
       COALESCE(SUM(tax_amount) FILTER (WHERE status = 'completed'), 0) AS total_tax,
       COALESCE(SUM(total_amount) FILTER (WHERE status = 'completed'), 0) AS net_sales
     FROM public.sales
     WHERE cash_session_id = $1`,
    [sessionRow.id]
  );
  const sStats = salesRes.rows[0] || {};

  const openingAmount = parseFloat(sessionRow.opening_amount || 0);
  const theoreticalCash = openingAmount + paymentMap.cash - totalCashRefunds - totalExpenses;
  const totalCollected =
    paymentMap.cash +
    paymentMap.card +
    paymentMap.mobile_money +
    paymentMap.transfer +
    paymentMap.check +
    paymentMap.other;

  const actualClosingAmount =
    sessionRow.actual_closing_amount !== null && sessionRow.actual_closing_amount !== undefined
      ? parseFloat(sessionRow.actual_closing_amount)
      : null;
  const differenceAmount =
    sessionRow.difference_amount !== null && sessionRow.difference_amount !== undefined
      ? parseFloat(sessionRow.difference_amount)
      : null;

  return {
    openingAmount,
    metrics: {
      cashIn: paymentMap.cash,
      cardIn: paymentMap.card,
      mobileMoneyIn: paymentMap.mobile_money,
      transferIn: paymentMap.transfer,
      checkIn: paymentMap.check,
      cashRefunds: totalCashRefunds,
      totalExpenses,
      theoreticalCashInDrawer: theoreticalCash,
    },
    zReport: {
      sessionId: sessionRow.id,
      status: sessionRow.status,
      openedAt: sessionRow.opened_at,
      closedAt: sessionRow.closed_at || null,
      openingAmount,
      expectedCashInDrawer: theoreticalCash,
      actualClosingAmount,
      differenceAmount,
      ticketsCount: Number(sStats.tickets_count || 0),
      cancelledCount: Number(sStats.cancelled_count || 0),
      grossSales: parseFloat(sStats.gross_sales || 0),
      totalDiscounts: parseFloat(sStats.total_discounts || 0),
      totalTax: parseFloat(sStats.total_tax || 0),
      netSales: parseFloat(sStats.net_sales || 0),
      totalCollected,
      cashRefunds: totalCashRefunds,
      totalExpenses,
      paymentBreakdown: {
        especes: paymentMap.cash,
        wave,
        orangeMoney,
        otherMobileMoney,
        mobileMoneyTotal: paymentMap.mobile_money,
        carteBancaire: paymentMap.card,
        virementChequeAutres: paymentMap.transfer + paymentMap.check + paymentMap.other,
      },
    },
  };
}

// -------------------------------------------------------------
// 1. SESSION ACTIVE AVEC CALCULS EN TEMPS RÉEL
// -------------------------------------------------------------
cashRouter.get('/sessions/current', async (req, res, next) => {
  try {
    const session = await withTenantContext(req.auth!, async (client) => {
      const sRes = await client.query(
        `SELECT cs.*, u.full_name as opened_by_name
         FROM public.cash_sessions cs
         LEFT JOIN public.users u ON u.id = cs.opened_by
         WHERE cs.company_id = $1 AND cs.status = 'open'
         ORDER BY cs.opened_at DESC LIMIT 1`,
        [req.auth!.companyId]
      );

      if (sRes.rows.length === 0) {
        return null;
      }

      const activeSession = sRes.rows[0];
      const computed = await buildZReportForSession(client, activeSession);

      return {
        ...activeSession,
        ...computed,
      };
    });

    res.json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 2. HISTORIQUE DES SESSIONS DE CAISSE
// -------------------------------------------------------------
cashRouter.get('/sessions', async (req, res, next) => {
  try {
    const { status, startDate, endDate, limit = '50', offset = '0' } = req.query;

    const sessions = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT cs.*,
               u_open.full_name as opened_by_name,
               u_close.full_name as closed_by_name,
               COALESCE((SELECT SUM(amount) FROM public.payments WHERE cash_session_id = cs.id), 0) as total_collected,
               COALESCE((SELECT SUM(amount) FROM public.expenses WHERE cash_session_id = cs.id), 0) as total_expenses
        FROM public.cash_sessions cs
        LEFT JOIN public.users u_open ON u_open.id = cs.opened_by
        LEFT JOIN public.users u_close ON u_close.id = cs.closed_by
        WHERE 1=1
      `;
      const params: any[] = [];

      if (status) {
        params.push(status);
        query += ` AND cs.status = $${params.length}`;
      }

      if (startDate) {
        params.push(startDate);
        query += ` AND cs.opened_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        query += ` AND cs.opened_at <= $${params.length}`;
      }

      query += ` ORDER BY cs.opened_at DESC`;

      const page = parsePagination(limit, offset, 50);
      params.push(page.limit);
      query += ` LIMIT $${params.length}`;

      params.push(page.offset);
      query += ` OFFSET $${params.length}`;

      const result = await client.query(query, params);
      return result.rows;
    });

    res.json({ success: true, data: sessions });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 3. DÉTAIL D'UNE SESSION DE CAISSE
// -------------------------------------------------------------
cashRouter.get('/sessions/:id', async (req, res, next) => {
  try {
    const sessionId = req.params.id;

    const session = await withTenantContext(req.auth!, async (client) => {
      const sRes = await client.query(
        `SELECT cs.*,
                u_open.full_name as opened_by_name,
                u_close.full_name as closed_by_name
         FROM public.cash_sessions cs
         LEFT JOIN public.users u_open ON u_open.id = cs.opened_by
         LEFT JOIN public.users u_close ON u_close.id = cs.closed_by
         WHERE cs.id = $1`,
        [sessionId]
      );

      if (sRes.rows.length === 0) return null;

      const paymentsRes = await client.query(
        `SELECT p.*, s.invoice_number
         FROM public.payments p
         LEFT JOIN public.sales s ON s.id = p.sale_id
         WHERE p.cash_session_id = $1
         ORDER BY p.paid_at ASC`,
        [sessionId]
      );

      const expensesRes = await client.query(
        `SELECT e.*, u.full_name as author_name
         FROM public.expenses e
         LEFT JOIN public.users u ON u.id = e.user_id
         WHERE e.cash_session_id = $1
         ORDER BY e.created_at ASC`,
        [sessionId]
      );

      const computed = await buildZReportForSession(client, sRes.rows[0]);

      return {
        ...sRes.rows[0],
        ...computed,
        payments: paymentsRes.rows,
        expenses: expensesRes.rows,
      };
    });

    if (!session) {
      res.status(404).json({ success: false, error: 'Session de caisse introuvable' });
      return;
    }

    res.json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 4. OUVERTURE D'UNE NOUVELLE SESSION DE CAISSE
// -------------------------------------------------------------
cashRouter.post('/sessions/open', async (req, res, next) => {
  try {
    const schema = z.object({
      openingAmount: z.number().min(0, { message: 'Le montant du fond de caisse initial doit être positif ou nul' }).default(0),
    });
    const data = schema.parse(req.body);

    const session = await withTenantContext(req.auth!, async (client) => {
      // Vérifier si une session n'est pas déjà ouverte dans l'entreprise
      const existing = await client.query(
        `SELECT id FROM public.cash_sessions WHERE company_id = $1 AND status = 'open'`,
        [req.auth!.companyId]
      );
      if (existing.rows.length > 0) {
        throw createHttpError(
          409,
          "Une session de caisse est déjà active pour cette entreprise. Clôturez-la avant d'en ouvrir une nouvelle.",
          'CASH_SESSION_ALREADY_OPEN'
        );
      }

      const result = await client.query(
        `INSERT INTO public.cash_sessions (company_id, opened_by, opening_amount, status)
         VALUES ($1, $2, $3, 'open')
         RETURNING *`,
        [req.auth!.companyId, req.auth!.userId, data.openingAmount]
      );
      return result.rows[0];
    });

    res.status(201).json({
      success: true,
      message: 'Session de caisse ouverte avec succès',
      data: session,
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 5. CLÔTURE D'UNE SESSION DE CAISSE (Procédure SECURITY DEFINER close_cash_session)
// -------------------------------------------------------------
cashRouter.post('/sessions/:id/close', async (req, res, next) => {
  try {
    const sessionId = req.params.id;
    const schema = z.object({
      actualAmount: z.number().min(0, { message: 'Le montant d\'espèces compté doit être positif ou nul' }),
    });
    const data = schema.parse(req.body);

    const closedSession = await withTenantContext(req.auth!, async (client) => {
      await client.query(
        `SELECT public.close_cash_session($1::UUID, $2::NUMERIC)`,
        [sessionId, data.actualAmount]
      );

      const sRes = await client.query(
        `SELECT * FROM public.cash_sessions WHERE id = $1`,
        [sessionId]
      );
      const computed = await buildZReportForSession(client, sRes.rows[0]);
      return {
        ...sRes.rows[0],
        ...computed,
      };
    });

    res.json({
      success: true,
      message: "Session de caisse clôturée avec calcul automatique du solde théorique et de l'écart",
      data: closedSession,
    });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 6. LISTE DES DÉPENSES DE CAISSE
// -------------------------------------------------------------
cashRouter.get('/expenses', async (req, res, next) => {
  try {
    const { cashSessionId, category, startDate, endDate, limit = '50', offset = '0' } = req.query;

    const expenses = await withTenantContext(req.auth!, async (client) => {
      let query = `
        SELECT e.*, u.full_name as author_name, cs.status as cash_session_status
        FROM public.expenses e
        LEFT JOIN public.users u ON u.id = e.user_id
        LEFT JOIN public.cash_sessions cs ON cs.id = e.cash_session_id
        WHERE 1=1
      `;
      const params: any[] = [];

      if (cashSessionId) {
        params.push(cashSessionId);
        query += ` AND e.cash_session_id = $${params.length}`;
      }

      if (category) {
        params.push(category);
        query += ` AND e.category = $${params.length}`;
      }

      if (startDate) {
        params.push(startDate);
        query += ` AND e.created_at >= $${params.length}`;
      }

      if (endDate) {
        params.push(endDate);
        query += ` AND e.created_at <= $${params.length}`;
      }

      query += ` ORDER BY e.created_at DESC`;

      const page = parsePagination(limit, offset, 50);
      params.push(page.limit);
      query += ` LIMIT $${params.length}`;

      params.push(page.offset);
      query += ` OFFSET $${params.length}`;

      const result = await client.query(query, params);
      return result.rows;
    });

    res.json({ success: true, data: expenses });
  } catch (error) {
    next(error);
  }
});

// -------------------------------------------------------------
// 7. ENREGISTREMENT D'UNE DÉPENSE SORTIE DE CAISSE
// -------------------------------------------------------------
cashRouter.post('/expenses', async (req, res, next) => {
  try {
    const schema = z.object({
      cashSessionId: z.string().uuid().optional(),
      category: z.string().min(1).max(100),
      amount: z.number().positive({ message: 'Le montant de la dépense doit être strictement positif' }),
      description: z.string().min(1, { message: 'Une description ou motif de la dépense est requis' }),
    });
    const data = schema.parse(req.body);

    const expense = await withTenantContext(req.auth!, async (client) => {
      // Déterminer la session de caisse
      let sessionId = data.cashSessionId;
      if (!sessionId) {
        const active = await client.query(
          `SELECT id FROM public.cash_sessions WHERE company_id = $1 AND status = 'open' LIMIT 1`,
          [req.auth!.companyId]
        );
        if (active.rows.length > 0) {
          sessionId = active.rows[0].id;
        }
      }

      const result = await client.query(
        `INSERT INTO public.expenses (company_id, user_id, cash_session_id, category, amount, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          req.auth!.companyId,
          req.auth!.userId,
          sessionId || null,
          data.category,
          data.amount,
          data.description,
        ]
      );
      return result.rows[0];
    });

    res.status(201).json({
      success: true,
      message: 'Dépense enregistrée avec succès',
      data: expense,
    });
  } catch (error) {
    next(error);
  }
});
