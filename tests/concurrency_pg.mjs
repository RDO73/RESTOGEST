/**
 * RESTOGEST V1 - SUITE DE TESTS DE CONCURRENCE MULTI-SESSIONS RÉELLE (PostgreSQL 14+ TCP)
 *
 * Ce script prouve le comportement sous charge concurrente avec de vraies connexions TCP
 * parallèles (pg.Client) connectées en tant que `restogest_app` (NOBYPASSRLS) :
 *   C1 : Double appel parallèle à complete_sale() -> 1 seul succès, stock déduit 1 fois
 *   C2A: Paiement espèces en cours (FOR SHARE) vs close_cash_session() (FOR UPDATE) -> montant inclus
 *   C2B: close_cash_session() (FOR UPDATE) vs paiement espèces concurrent -> paiement rejeté après clôture
 *   C3 : Deux remboursements partiels parallèles dépassant le paiement (60 + 60 > 100) -> 1 seul succès
 *   C4 : Double appel parallèle à receive_purchase() -> 1 seul succès, PMP & stock appliqués 1 fois
 *   C5 : Deux créations concurrentes d'arêtes réciproques A->B et B->A dans recipe_ingredients
 *        (pg_advisory_xact_lock sérialise -> B->A détecte le cycle et échoue sans deadlock)
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const { Client } = pg;

const ADMIN_URL =
  process.env.DATABASE_ADMIN_URL ||
  'postgresql://restogest_admin:restogest_admin_pass@127.0.0.1:55432/restogest';
const APP_URL =
  process.env.DATABASE_URL ||
  'postgresql://restogest_app:restogest_app_pass@127.0.0.1:55432/restogest';

function sha256(val) {
  return crypto.createHash('sha256').update(val, 'utf8').digest('hex');
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function createTenantContext(adminClient, label) {
  const email = `concurrency_${label}_${Date.now()}_${Math.random().toString(16).slice(2)}@resto.test`;
  const res = await adminClient.query(
    `SELECT company_id, user_id FROM public.register_company_and_owner($1, $2, $3, $4, $5, $6)`,
    [`Resto Concurrency ${label}`, 'both', 'XOF', email, '$scrypt$dummy$hash', `Owner ${label}`]
  );
  const { company_id: companyId, user_id: userId } = res.rows[0];
  const rawToken = `tok_${label}_${crypto.randomUUID()}`;
  const tokenHash = sha256(rawToken);
  await adminClient.query(
    `INSERT INTO public.user_sessions (user_id, company_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + INTERVAL '2 hours')`,
    [userId, companyId, tokenHash]
  );
  return { companyId, userId, tokenHash };
}

async function openAppClient(tokenHash, companyId) {
  const client = new Client({ connectionString: APP_URL });
  await client.connect();
  await client.query('BEGIN');
  await client.query('SELECT public.set_session_context($1, $2)', [tokenHash, companyId]);
  return client;
}

async function runConcurrencySuite() {
  console.log('\n=== CONCURRENCE MULTI-SESSIONS RÉELLE (PostgreSQL TCP / restogest_app) ===');
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  let passed = 0;
  let failed = 0;

  async function runCase(id, label, fn) {
    try {
      await fn();
      passed++;
      console.log(`  [${id} OK] ${label}`);
    } catch (err) {
      failed++;
      process.exitCode = 1;
      console.error(`  [${id} ÉCHEC] ${label} -> ${err.message}`);
    }
  }

  try {
    const verRes = await admin.query('SELECT version() AS v');
    console.log(`  [PG SERVEUR] ${verRes.rows[0].v.split(',')[0]}`);

    // ------------------------------------------------------------------
    // C1 : Deux appels concurrents à complete_sale() sur la même vente
    // ------------------------------------------------------------------
    await runCase('C1', 'Double complete_sale() parallèle -> 1 seul succès & stock déduit 1 seule fois', async () => {
      const ctx = await createTenantContext(admin, 'c1');
      const setup = await openAppClient(ctx.tokenHash, ctx.companyId);
      let prodId, saleId, cashId;
      try {
        const p = await setup.query(
          `INSERT INTO public.products (company_id, name, product_type, unit, selling_price, inventory_tracking)
           VALUES ($1, 'Burger C1', 'finished_good', 'unit', 2500, 'direct') RETURNING id`,
          [ctx.companyId]
        );
        prodId = p.rows[0].id;
        await setup.query(`SELECT public.record_stock_adjustment($1, 'adjustment', 10, 'Stock init C1')`, [prodId]);

        const cs = await setup.query(
          `INSERT INTO public.cash_sessions (company_id, opened_by, opening_amount)
           VALUES ($1, $2, 10000) RETURNING id`,
          [ctx.companyId, ctx.userId]
        );
        cashId = cs.rows[0].id;

        const s = await setup.query(
          `INSERT INTO public.sales (company_id, user_id, cash_session_id, invoice_number) VALUES ($1, $2, $3, 'FAC-C1-01') RETURNING id`,
          [ctx.companyId, ctx.userId, cashId]
        );
        saleId = s.rows[0].id;

        await setup.query(
          `INSERT INTO public.sale_items (company_id, sale_id, product_id, quantity, unit_price, subtotal)
           VALUES ($1, $2, $3, 3, 2500, 7500)`,
          [ctx.companyId, saleId, prodId]
        );
        await setup.query(
          `INSERT INTO public.payments (company_id, sale_id, cash_session_id, payment_method, amount)
           VALUES ($1, $2, $3, 'cash', 7500)`,
          [ctx.companyId, saleId, cashId]
        );
        await setup.query('COMMIT');
      } finally {
        await setup.end();
      }

      const worker = async () => {
        const c = await openAppClient(ctx.tokenHash, ctx.companyId);
        try {
          await c.query('SELECT public.complete_sale($1)', [saleId]);
          await c.query('COMMIT');
          return { ok: true };
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          return { ok: false, message: err.message };
        } finally {
          await c.end();
        }
      };

      const [r1, r2] = await Promise.all([worker(), worker()]);
      const successes = [r1, r2].filter((r) => r.ok).length;
      const failures = [r1, r2].filter((r) => !r.ok);
      assert.equal(successes, 1, `Attendu 1 succès exact, reçu ${successes}`);
      assert.equal(failures.length, 1);
      assert.match(failures[0].message, /en attente/i);

      const check = await openAppClient(ctx.tokenHash, ctx.companyId);
      try {
        const qtyRes = await check.query(
          `SELECT current_quantity FROM public.stock_levels WHERE product_id = $1`,
          [prodId]
        );
        assert.equal(parseFloat(qtyRes.rows[0].current_quantity), 7);
        await check.query('COMMIT');
      } finally {
        await check.end();
      }
    });

    // ------------------------------------------------------------------
    // C2A : Paiement espèces ouvert (FOR SHARE) vs close_cash_session() (FOR UPDATE)
    // ------------------------------------------------------------------
    await runCase('C2A', 'Paiement espèces en cours bloque close_cash_session() et est inclus au solde', async () => {
      const ctx = await createTenantContext(admin, 'c2a');
      const setup = await openAppClient(ctx.tokenHash, ctx.companyId);
      let cashId, saleId;
      try {
        const cs = await setup.query(
          `INSERT INTO public.cash_sessions (company_id, opened_by, opening_amount)
           VALUES ($1, $2, 10000) RETURNING id`,
          [ctx.companyId, ctx.userId]
        );
        cashId = cs.rows[0].id;
        const s = await setup.query(
          `INSERT INTO public.sales (company_id, user_id, cash_session_id, invoice_number) VALUES ($1, $2, $3, 'FAC-C2A-01') RETURNING id`,
          [ctx.companyId, ctx.userId, cashId]
        );
        saleId = s.rows[0].id;
        await setup.query('COMMIT');
      } finally {
        await setup.end();
      }

      const cPay = await openAppClient(ctx.tokenHash, ctx.companyId);
      const cClose = await openAppClient(ctx.tokenHash, ctx.companyId);
      try {
        // Session 1 insère un paiement cash mais ne COMMIT pas encore (détient FOR SHARE sur cash_sessions)
        await cPay.query(
          `INSERT INTO public.payments (company_id, sale_id, cash_session_id, payment_method, amount)
           VALUES ($1, $2, $3, 'cash', 4000)`,
          [ctx.companyId, saleId, cashId]
        );

        let closeResolvedEarly = false;
        const closePromise = cClose
          .query(`SELECT public.close_cash_session($1, 14000.00)`, [cashId])
          .then(async () => {
            await cClose.query('COMMIT');
            closeResolvedEarly = true;
          });

        // Vérifier que close_cash_session attend bien la fin de cPay (lock contention réel)
        await delay(250);
        assert.equal(closeResolvedEarly, false, 'close_cash_session aurait dû attendre FOR SHARE');

        // Session 1 commit le paiement cash -> Session 2 se réveille et doit voir les +4000
        await cPay.query('COMMIT');
        await closePromise;
      } finally {
        await cPay.end().catch(() => {});
        await cClose.end().catch(() => {});
      }

      const verify = await openAppClient(ctx.tokenHash, ctx.companyId);
      try {
        const res = await verify.query(
          `SELECT status, expected_closing_amount, difference_amount FROM public.cash_sessions WHERE id = $1`,
          [cashId]
        );
        assert.equal(res.rows[0].status, 'closed');
        assert.equal(parseFloat(res.rows[0].expected_closing_amount), 14000);
        assert.equal(parseFloat(res.rows[0].difference_amount), 0);
        await verify.query('COMMIT');
      } finally {
        await verify.end();
      }
    });

    // ------------------------------------------------------------------
    // C2B : close_cash_session() en cours (FOR UPDATE) vs paiement espèces concurrent
    // ------------------------------------------------------------------
    await runCase('C2B', 'close_cash_session() actif puis COMMIT rejette le paiement espèces en attente', async () => {
      const ctx = await createTenantContext(admin, 'c2b');
      const setup = await openAppClient(ctx.tokenHash, ctx.companyId);
      let cashId, saleId;
      try {
        const cs = await setup.query(
          `INSERT INTO public.cash_sessions (company_id, opened_by, opening_amount)
           VALUES ($1, $2, 10000) RETURNING id`,
          [ctx.companyId, ctx.userId]
        );
        cashId = cs.rows[0].id;
        const s = await setup.query(
          `INSERT INTO public.sales (company_id, user_id, cash_session_id, invoice_number) VALUES ($1, $2, $3, 'FAC-C2B-01') RETURNING id`,
          [ctx.companyId, ctx.userId, cashId]
        );
        saleId = s.rows[0].id;
        await setup.query('COMMIT');
      } finally {
        await setup.end();
      }

      const cClose = await openAppClient(ctx.tokenHash, ctx.companyId);
      const cPay = await openAppClient(ctx.tokenHash, ctx.companyId);
      try {
        await cClose.query(`SELECT public.close_cash_session($1, 10000.00)`, [cashId]);

        let payResolvedEarly = false;
        const payPromise = cPay
          .query(
            `INSERT INTO public.payments (company_id, sale_id, cash_session_id, payment_method, amount)
             VALUES ($1, $2, $3, 'cash', 2000)`,
            [ctx.companyId, saleId, cashId]
          )
          .then(
            () => {
              payResolvedEarly = true;
              return { ok: true };
            },
            (err) => {
              payResolvedEarly = true;
              return { ok: false, message: err.message };
            }
          );

        await delay(250);
        assert.equal(payResolvedEarly, false, 'INSERT payment aurait dû attendre FOR UPDATE de close_cash_session');

        await cClose.query('COMMIT');
        const payResult = await payPromise;
        await cPay.query('ROLLBACK').catch(() => {});

        assert.equal(payResult.ok, false, 'Le paiement sur caisse fermée aurait dû échouer');
        assert.match(payResult.message, /fermée ou invalide/i);
      } finally {
        await cClose.end().catch(() => {});
        await cPay.end().catch(() => {});
      }
    });

    // ------------------------------------------------------------------
    // C3 : Deux remboursements concurrents dépassant le montant payé (60+60 > 100)
    // ------------------------------------------------------------------
    await runCase('C3', 'Double remboursement concurrent (60 + 60 sur 100 payé) -> 1 seul autorisé', async () => {
      const ctx = await createTenantContext(admin, 'c3');
      const setup = await openAppClient(ctx.tokenHash, ctx.companyId);
      let saleId, payId;
      try {
        const s = await setup.query(
          `INSERT INTO public.sales (company_id, user_id, invoice_number) VALUES ($1, $2, 'FAC-C3-01') RETURNING id`,
          [ctx.companyId, ctx.userId]
        );
        saleId = s.rows[0].id;
        const p = await setup.query(
          `INSERT INTO public.payments (company_id, sale_id, payment_method, amount)
           VALUES ($1, $2, 'card', 100.00) RETURNING id`,
          [ctx.companyId, saleId]
        );
        payId = p.rows[0].id;
        await setup.query('COMMIT');
      } finally {
        await setup.end();
      }

      const refundWorker = async (idx) => {
        const c = await openAppClient(ctx.tokenHash, ctx.companyId);
        try {
          await c.query(
            `INSERT INTO public.refunds (company_id, sale_id, payment_id, refund_method, amount, reason, status)
             VALUES ($1, $2, $3, 'card', 60.00, $4, 'completed')`,
            [ctx.companyId, saleId, payId, `Concurrent refund ${idx}`]
          );
          await c.query('COMMIT');
          return { ok: true };
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          return { ok: false, message: err.message };
        } finally {
          await c.end();
        }
      };

      const [r1, r2] = await Promise.all([refundWorker(1), refundWorker(2)]);
      const successes = [r1, r2].filter((r) => r.ok).length;
      const failures = [r1, r2].filter((r) => !r.ok);
      assert.equal(successes, 1, `Attendu 1 remboursement exact, reçu ${successes}`);
      assert.equal(failures.length, 1);
      assert.match(failures[0].message, /Dépassement interdit/i);
    });

    // ------------------------------------------------------------------
    // C4 : Double appel parallèle à receive_purchase() sur le même achat
    // ------------------------------------------------------------------
    await runCase('C4', 'Double receive_purchase() parallèle -> 1 seul succès & stock incrémenté 1 fois', async () => {
      const ctx = await createTenantContext(admin, 'c4');
      const setup = await openAppClient(ctx.tokenHash, ctx.companyId);
      let prodId, purchId;
      try {
        const p = await setup.query(
          `INSERT INTO public.products (company_id, name, product_type, unit, inventory_tracking)
           VALUES ($1, 'Farine C4', 'raw_material', 'kg', 'direct') RETURNING id`,
          [ctx.companyId]
        );
        prodId = p.rows[0].id;

        const pu = await setup.query(
          `INSERT INTO public.purchases (company_id, user_id, reference, status, total_amount)
           VALUES ($1, $2, 'ACH-CONC-4', 'ordered', 10000) RETURNING id`,
          [ctx.companyId, ctx.userId]
        );
        purchId = pu.rows[0].id;

        await setup.query(
          `INSERT INTO public.purchase_items (company_id, purchase_id, product_id, quantity, unit_cost, subtotal)
           VALUES ($1, $2, $3, 10, 1000, 10000)`,
          [ctx.companyId, purchId, prodId]
        );
        await setup.query('COMMIT');
      } finally {
        await setup.end();
      }

      const worker = async () => {
        const c = await openAppClient(ctx.tokenHash, ctx.companyId);
        try {
          await c.query(`SELECT public.receive_purchase($1)`, [purchId]);
          await c.query('COMMIT');
          return { ok: true };
        } catch (err) {
          await c.query('ROLLBACK').catch(() => {});
          return { ok: false, message: err.message };
        } finally {
          await c.end();
        }
      };

      const [r1, r2] = await Promise.all([worker(), worker()]);
      const successes = [r1, r2].filter((r) => r.ok).length;
      const failures = [r1, r2].filter((r) => !r.ok);
      assert.equal(successes, 1, `Attendu 1 réception exacte, reçu ${successes}`);
      assert.equal(failures.length, 1);

      const verify = await openAppClient(ctx.tokenHash, ctx.companyId);
      try {
        const qtyRes = await verify.query(
          `SELECT current_quantity FROM public.stock_levels WHERE product_id = $1`,
          [prodId]
        );
        assert.equal(parseFloat(qtyRes.rows[0].current_quantity), 10);
        await verify.query('COMMIT');
      } finally {
        await verify.end();
      }
    });

    // ------------------------------------------------------------------
    // C5 : Insertion concurrente A->B et B->A dans recipe_ingredients
    // ------------------------------------------------------------------
    await runCase('C5', 'Cycles réciproques concurrents A->B et B->A sérialisés par pg_advisory_xact_lock', async () => {
      const ctx = await createTenantContext(admin, 'c5');
      const setup = await openAppClient(ctx.tokenHash, ctx.companyId);
      let prodA, prodB, recA, recB;
      try {
        const pA = await setup.query(
          `INSERT INTO public.products (company_id, name, product_type, unit, inventory_tracking)
           VALUES ($1, 'Recette A C5', 'semi_finished', 'unit', 'recipe_on_sale') RETURNING id`,
          [ctx.companyId]
        );
        prodA = pA.rows[0].id;
        const pB = await setup.query(
          `INSERT INTO public.products (company_id, name, product_type, unit, inventory_tracking)
           VALUES ($1, 'Recette B C5', 'semi_finished', 'unit', 'recipe_on_sale') RETURNING id`,
          [ctx.companyId]
        );
        prodB = pB.rows[0].id;

        const rA = await setup.query(
          `INSERT INTO public.recipes (company_id, finished_product_id, name)
           VALUES ($1, $2, 'Recette A v1') RETURNING id`,
          [ctx.companyId, prodA]
        );
        recA = rA.rows[0].id;
        const rB = await setup.query(
          `INSERT INTO public.recipes (company_id, finished_product_id, name)
           VALUES ($1, $2, 'Recette B v1') RETURNING id`,
          [ctx.companyId, prodB]
        );
        recB = rB.rows[0].id;
        await setup.query('COMMIT');
      } finally {
        await setup.end();
      }

      const c1 = await openAppClient(ctx.tokenHash, ctx.companyId);
      const c2 = await openAppClient(ctx.tokenHash, ctx.companyId);
      try {
        // Session 1 insère A -> B sans COMMIT (détient pg_advisory_xact_lock)
        await c1.query(
          `INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
           VALUES ($1, $2, $3, 1)`,
          [ctx.companyId, recA, prodB]
        );

        let c2FinishedEarly = false;
        const p2 = c2
          .query(
            `INSERT INTO public.recipe_ingredients (company_id, recipe_id, ingredient_id, quantity_required)
             VALUES ($1, $2, $3, 1)`,
            [ctx.companyId, recB, prodA]
          )
          .then(
            () => {
              c2FinishedEarly = true;
              return { ok: true };
            },
            (err) => {
              c2FinishedEarly = true;
              return { ok: false, message: err.message };
            }
          );

        await delay(250);
        assert.equal(c2FinishedEarly, false, 'Session 2 aurait dû attendre pg_advisory_xact_lock');

        await c1.query('COMMIT');
        const res2 = await p2;
        await c2.query('ROLLBACK').catch(() => {});

        assert.equal(res2.ok, false, 'Session 2 aurait dû détecter le cycle B -> A -> B');
        assert.match(res2.message, /cycle/i);
      } finally {
        await c1.end().catch(() => {});
        await c2.end().catch(() => {});
      }
    });
  } finally {
    await admin.end();
  }

  console.log(`\nConcurrence PostgreSQL réelle : ${passed} / 6 réussis, ${failed} échoué(s)`);
}

runConcurrencySuite().catch((err) => {
  console.error('[CONCURRENCY FATAL]', err);
  process.exit(1);
});
