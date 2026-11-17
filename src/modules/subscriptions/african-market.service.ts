import type { IDbClient } from '../../db/pool.js';

export interface ResolvedPeriodPrice {
  billingPeriod: string;
  currencyCode: string;
  hasOfficialLocalPrice: boolean;
  isEstimate: boolean;
  officialLocalPrice: number | null;
  estimatedLocalPrice: number | null;
  referencePriceXof: number;
  setupFee: number;
  exchangeRate: number | null;
  exchangeRateSource: string | null;
  exchangeRateUpdatedAt: string | null;
}

function getReferenceXofPrice(plan: any, billingPeriod: string): {
  refPrice: number;
  refSetup: number;
} {
  let refPrice = Number(plan.monthly_price || 0);
  if (billingPeriod === 'quarterly') {
    refPrice = Number(plan.quarterly_price || refPrice * 3);
  } else if (billingPeriod === 'semiannual') {
    refPrice = Number(plan.semiannual_price || refPrice * 6);
  } else if (billingPeriod === 'yearly') {
    refPrice = Number(plan.yearly_price || refPrice * 10);
  }
  const refSetup = Number(plan.setup_fee || 0);
  return { refPrice, refSetup };
}

export async function getCountryByCode(client: IDbClient, countryCode: string): Promise<any | null> {
  const code = String(countryCode || 'SN').trim().toUpperCase();
  const res = await client.query(
    `SELECT * FROM public.saas_countries WHERE code = $1`,
    [code]
  );
  if (res.rows.length > 0) return res.rows[0];
  const fallback = await client.query(`SELECT * FROM public.saas_countries WHERE code = 'SN'`);
  return fallback.rows[0] || null;
}

export async function resolveCountryPricingMatrix(
  client: IDbClient,
  countryCode: string,
  plans: any[]
): Promise<Record<string, Record<string, ResolvedPeriodPrice>>> {
  const code = String(countryCode || 'SN').trim().toUpperCase();
  const country = await getCountryByCode(client, code);
  const targetCurrency = country?.currency_code || 'XOF';

  const localRes = await client.query(
    `SELECT * FROM public.saas_country_plan_prices
     WHERE country_code = $1 AND is_active = TRUE AND effective_from <= NOW()`,
    [code]
  );
  const localMap = new Map<string, any>();
  for (const row of localRes.rows) {
    localMap.set(`${row.plan_code}::${row.billing_period}`, row);
  }

  const rateRes = await client.query(
    `SELECT rate, source, updated_at
     FROM public.saas_exchange_rates
     WHERE base_currency = 'XOF' AND target_currency = $1`,
    [targetCurrency]
  );
  const rateRow = rateRes.rows[0] || null;

  const matrix: Record<string, Record<string, ResolvedPeriodPrice>> = {};
  const periods = ['monthly', 'quarterly', 'semiannual', 'yearly'];

  for (const plan of plans) {
    const planCode = plan.code;
    matrix[planCode] = {};
    for (const period of periods) {
      const { refPrice, refSetup } = getReferenceXofPrice(plan, period);
      const local = localMap.get(`${planCode}::${period}`);

      if (local) {
        matrix[planCode][period] = {
          billingPeriod: period,
          currencyCode: local.currency_code,
          hasOfficialLocalPrice: true,
          isEstimate: false,
          officialLocalPrice: Number(local.local_price),
          estimatedLocalPrice: null,
          referencePriceXof: Number(local.reference_price || refPrice),
          setupFee: Number(local.setup_fee || 0),
          exchangeRate: null,
          exchangeRateSource: null,
          exchangeRateUpdatedAt: null,
        };
      } else if (rateRow && Number(rateRow.rate) > 0) {
        const rateNum = Number(rateRow.rate);
        matrix[planCode][period] = {
          billingPeriod: period,
          currencyCode: targetCurrency,
          hasOfficialLocalPrice: false,
          isEstimate: true,
          officialLocalPrice: null,
          estimatedLocalPrice: Math.round(refPrice * rateNum),
          referencePriceXof: refPrice,
          setupFee: Math.round(refSetup * rateNum),
          exchangeRate: rateNum,
          exchangeRateSource: rateRow.source,
          exchangeRateUpdatedAt: rateRow.updated_at,
        };
      } else {
        matrix[planCode][period] = {
          billingPeriod: period,
          currencyCode: 'XOF',
          hasOfficialLocalPrice: false,
          isEstimate: false,
          officialLocalPrice: null,
          estimatedLocalPrice: null,
          referencePriceXof: refPrice,
          setupFee: refSetup,
          exchangeRate: null,
          exchangeRateSource: null,
          exchangeRateUpdatedAt: null,
        };
      }
    }
  }

  return matrix;
}

export async function getCountryPaymentContext(client: IDbClient, countryCode: string) {
  const code = String(countryCode || 'SN').trim().toUpperCase();
  const country = await getCountryByCode(client, code);

  const methodsRes = await client.query(
    `SELECT cpm.*, pp.name AS provider_name, pp.adapter_type, pp.default_fee_percent,
            pp.settlement_delay_label, pp.supports_refunds, pp.mode AS provider_mode,
            pp.is_active AS provider_is_active
     FROM public.saas_country_payment_methods cpm
     JOIN public.saas_payment_providers pp ON pp.code = cpm.provider_code
     WHERE cpm.country_code = $1 AND cpm.is_active = TRUE AND pp.is_active = TRUE
     ORDER BY cpm.sort_order ASC, cpm.method_label ASC`,
    [code]
  );

  // Strict country filtering: reception accounts for this country ONLY (never expose +221788979342 outside SN!)
  const receptionRes = await client.query(
    `SELECT id, country_code, provider_code, method_code, account_label,
            merchant_number_or_iban, currency_code, usage_scope, verification_status, instructions
     FROM public.saas_reception_accounts
     WHERE country_code = $1 AND is_active = TRUE
     ORDER BY created_at ASC`,
    [code]
  );

  return {
    country,
    paymentMethods: methodsRes.rows,
    receptionAccounts: receptionRes.rows,
  };
}

export async function computeConsolidatedMultiCurrencyFinances(
  client: IDbClient,
  filters: {
    period?: string;
    countryCode?: string | null;
    currency?: string | null;
    provider?: string | null;
    reportingCurrency?: string;
  }
) {
  const reportingCurrency = (filters.reportingCurrency || 'XOF').toUpperCase();
  const params: any[] = [];
  const where: string[] = ['1=1'];

  if (filters.period === 'today') {
    where.push(`tx.created_at >= CURRENT_DATE`);
  } else if (filters.period === 'week') {
    where.push(`tx.created_at >= NOW() - INTERVAL '7 days'`);
  } else if (filters.period === 'month') {
    where.push(`tx.created_at >= DATE_TRUNC('month', NOW())`);
  } else if (filters.period === 'year') {
    where.push(`tx.created_at >= DATE_TRUNC('year', NOW())`);
  }

  if (filters.countryCode) {
    params.push(filters.countryCode.toUpperCase());
    where.push(`COALESCE(tx.country_code, 'SN') = $${params.length}`);
  }
  if (filters.currency) {
    params.push(filters.currency.toUpperCase());
    where.push(`tx.currency = $${params.length}`);
  }
  if (filters.provider) {
    params.push(filters.provider.toLowerCase());
    where.push(`LOWER(tx.payment_provider) = $${params.length}`);
  }

  const whereSql = where.join(' AND ');

  // 1. Totaux strictement séparés par devise (jamais d'addition XOF + GNF + NGN brute)
  const byCurrencyRes = await client.query(
    `SELECT tx.currency,
            COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS gross_confirmed,
            COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status IN ('pending', 'initiated')), 0) AS pending_amount,
            COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status IN ('failed', 'abandoned')), 0) AS failed_amount,
            COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status = 'refunded'), 0) AS refunded_amount,
            COALESCE(SUM(tx.provider_fee_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS provider_fees,
            COALESCE(SUM(tx.net_expected_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS net_expected,
            COUNT(tx.id) FILTER (WHERE tx.status = 'confirmed')::INT AS confirmed_count,
            COUNT(tx.id) FILTER (WHERE tx.status IN ('pending', 'initiated'))::INT AS pending_count,
            COUNT(tx.id) FILTER (WHERE tx.status IN ('failed', 'abandoned'))::INT AS failed_count,
            COUNT(tx.id) FILTER (WHERE tx.status = 'refunded')::INT AS refunded_count
     FROM public.saas_subscription_transactions tx
     WHERE ${whereSql}
     GROUP BY tx.currency
     ORDER BY gross_confirmed DESC`,
    params
  );

  // Payouts par devise
  const payoutsByCurRes = await client.query(
    `SELECT currency,
            COALESCE(SUM(net_settled_amount) FILTER (WHERE status = 'settled'), 0) AS settled_amount,
            COALESCE(SUM(net_settled_amount) FILTER (WHERE status IN ('pending', 'in_transit')), 0) AS in_transit_amount
     FROM public.saas_payouts
     GROUP BY currency`
  );
  const payoutsMap = new Map<string, { settled: number; inTransit: number }>();
  for (const r of payoutsByCurRes.rows) {
    payoutsMap.set(r.currency, {
      settled: Number(r.settled_amount || 0),
      inTransit: Number(r.in_transit_amount || 0),
    });
  }

  // Taux de change XOF -> autres devises pour reporting consolidé indicatif
  const ratesRes = await client.query(
    `SELECT base_currency, target_currency, rate, source, updated_at
     FROM public.saas_exchange_rates
     WHERE base_currency = 'XOF'`
  );
  const rateFromXof = new Map<string, { rate: number; source: string; updatedAt: string }>();
  for (const r of ratesRes.rows) {
    rateFromXof.set(r.target_currency, {
      rate: Number(r.rate),
      source: r.source,
      updatedAt: r.updated_at,
    });
  }

  const targetRateInfo = rateFromXof.get(reportingCurrency) || { rate: 1, source: 'Parité XOF', updatedAt: new Date().toISOString() };

  let consolidatedGross = 0;
  let consolidatedNetExpected = 0;
  let consolidatedSettled = 0;
  let consolidatedUnsettled = 0;
  const ratesUsed: any[] = [];

  const totalsByCurrency = byCurrencyRes.rows.map((row: any) => {
    const cur = row.currency;
    const pInfo = payoutsMap.get(cur) || { settled: 0, inTransit: 0 };
    const netExp = Number(row.net_expected || 0);
    const unsettled = Math.max(0, netExp - pInfo.settled);

    // Conversion indicative vers reportingCurrency via XOF
    const curRateFromXof = rateFromXof.get(cur)?.rate || (cur === 'XOF' ? 1 : null);
    let convertedGross: number | null = null;
    if (curRateFromXof && curRateFromXof > 0) {
      const factorToReporting = targetRateInfo.rate / curRateFromXof;
      convertedGross = Math.round(Number(row.gross_confirmed || 0) * factorToReporting);
      consolidatedGross += convertedGross;
      consolidatedNetExpected += Math.round(netExp * factorToReporting);
      consolidatedSettled += Math.round(pInfo.settled * factorToReporting);
      consolidatedUnsettled += Math.round(unsettled * factorToReporting);

      ratesUsed.push({
        from: cur,
        to: reportingCurrency,
        rate: Number(factorToReporting.toFixed(6)),
        source: rateFromXof.get(cur)?.source || 'Référentiel',
        updatedAt: rateFromXof.get(cur)?.updatedAt || null,
      });
    }

    return {
      currency: cur,
      grossConfirmed: Number(row.gross_confirmed || 0),
      pendingAmount: Number(row.pending_amount || 0),
      failedAmount: Number(row.failed_amount || 0),
      refundedAmount: Number(row.refunded_amount || 0),
      providerFees: Number(row.provider_fees || 0),
      netExpected: netExp,
      settledPayouts: pInfo.settled,
      inTransitPayouts: pInfo.inTransit,
      unsettledBalance: unsettled,
      confirmedCount: Number(row.confirmed_count || 0),
      pendingCount: Number(row.pending_count || 0),
      failedCount: Number(row.failed_count || 0),
      refundedCount: Number(row.refunded_count || 0),
      indicativeReportingAmount: convertedGross,
    };
  });

  // 2. Revenus par pays
  const byCountryRes = await client.query(
    `SELECT COALESCE(tx.country_code, 'SN') AS country_code,
            COALESCE(sc.name, COALESCE(tx.country_code, 'SN')) AS country_name,
            tx.currency,
            COUNT(tx.id) FILTER (WHERE tx.status = 'confirmed')::INT AS confirmed_count,
            COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS gross_confirmed,
            COALESCE(SUM(tx.net_expected_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS net_expected
     FROM public.saas_subscription_transactions tx
     LEFT JOIN public.saas_countries sc ON sc.code = COALESCE(tx.country_code, 'SN')
     WHERE ${whereSql}
     GROUP BY COALESCE(tx.country_code, 'SN'), sc.name, tx.currency
     ORDER BY gross_confirmed DESC`,
    params
  );

  // 3. Revenus par prestataire
  const byProviderRes = await client.query(
    `SELECT tx.payment_provider, tx.currency,
            COUNT(tx.id) FILTER (WHERE tx.status = 'confirmed')::INT AS confirmed_count,
            COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS gross_confirmed,
            COALESCE(SUM(tx.provider_fee_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS provider_fees,
            COALESCE(SUM(tx.net_expected_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS net_expected
     FROM public.saas_subscription_transactions tx
     WHERE ${whereSql}
     GROUP BY tx.payment_provider, tx.currency
     ORDER BY gross_confirmed DESC`,
    params
  );

  // 4. Revenus par plan & devise
  const byPlanRes = await client.query(
    `SELECT tx.plan_code, tx.currency,
            COUNT(tx.id) FILTER (WHERE tx.status = 'confirmed')::INT AS confirmed_count,
            COALESCE(SUM(tx.gross_amount) FILTER (WHERE tx.status = 'confirmed'), 0) AS gross_confirmed
     FROM public.saas_subscription_transactions tx
     WHERE ${whereSql}
     GROUP BY tx.plan_code, tx.currency
     ORDER BY gross_confirmed DESC`,
    params
  );

  return {
    reportingEstimate: {
      reportingCurrency,
      isIndicativeEstimate: true,
      consolidatedGross,
      consolidatedNetExpected,
      consolidatedSettled,
      consolidatedUnsettled,
      ratesUsed,
    },
    totalsByCurrency,
    revenueByCountry: byCountryRes.rows,
    revenueByProvider: byProviderRes.rows,
    revenueByPlan: byPlanRes.rows,
  };
}
