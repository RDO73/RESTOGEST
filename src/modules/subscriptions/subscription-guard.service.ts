import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { adminPool, type IDbClient, type IDbPool } from '../../db/pool.js';
import { DEMO_TENANT_ID } from '../../db/demo-seed.js';

export type QuotaResourceType = 'locations' | 'users' | 'tables' | 'products';

export interface PlanQuotas {
  maxLocations: number;
  maxUsers: number;
  maxTables: number;
  maxProducts: number;
}

export const PLAN_QUOTA_DEFAULTS: Record<string, PlanQuotas> = {
  ESSENTIEL: {
    maxLocations: 1,
    maxUsers: 3,
    maxTables: 15,
    maxProducts: 100,
  },
  PRO: {
    maxLocations: 1,
    maxUsers: 10,
    maxTables: 50,
    maxProducts: 500,
  },
  ENTREPRISE: {
    maxLocations: 10,
    maxUsers: 999,
    maxTables: 999,
    maxProducts: 9999,
  },
};

export interface LegalVersionsConfig {
  cguVersion: string;
  cgvVersion: string;
  privacyPolicyVersion: string;
}

export const DEFAULT_LEGAL_VERSIONS: LegalVersionsConfig = {
  cguVersion: '2026-11-21',
  cgvVersion: '2026-11-21',
  privacyPolicyVersion: '2026-11-21',
};

let activeLegalVersions: LegalVersionsConfig = { ...DEFAULT_LEGAL_VERSIONS };

export function getRequiredLegalVersions(): LegalVersionsConfig {
  return { ...activeLegalVersions };
}

export function setRequiredLegalVersions(partial: Partial<LegalVersionsConfig>): LegalVersionsConfig {
  activeLegalVersions = {
    cguVersion: partial.cguVersion?.trim() || activeLegalVersions.cguVersion,
    cgvVersion: partial.cgvVersion?.trim() || activeLegalVersions.cgvVersion,
    privacyPolicyVersion: partial.privacyPolicyVersion?.trim() || activeLegalVersions.privacyPolicyVersion,
  };
  return getRequiredLegalVersions();
}

export function resetRequiredLegalVersions(): LegalVersionsConfig {
  activeLegalVersions = { ...DEFAULT_LEGAL_VERSIONS };
  return getRequiredLegalVersions();
}

type DbExecutor = IDbClient | IDbPool;

// Mutex par entreprise pour sérialiser strictement les créations concurrentes soumises aux quotas
const companyQuotaMutexMap = new Map<string, Promise<void>>();

export async function withCompanyQuotaLock<T>(companyKey: string, task: () => Promise<T>): Promise<T> {
  const prev = companyQuotaMutexMap.get(companyKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => current, () => current);
  companyQuotaMutexMap.set(companyKey, chained);

  await prev.catch(() => { });
  try {
    return await task();
  } finally {
    release();
    if (companyQuotaMutexMap.get(companyKey) === chained) {
      companyQuotaMutexMap.delete(companyKey);
    }
  }
}

export class SubscriptionQuotaError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'SUBSCRIPTION_QUOTA_EXCEEDED';
  public readonly resourceType: QuotaResourceType;
  public readonly planCode: string;
  public readonly currentCount: number;
  public readonly maxAllowed: number;

  constructor(opts: {
    resourceType: QuotaResourceType;
    planCode: string;
    currentCount: number;
    maxAllowed: number;
    message: string;
  }) {
    super(opts.message);
    this.name = 'SubscriptionQuotaError';
    this.resourceType = opts.resourceType;
    this.planCode = opts.planCode;
    this.currentCount = opts.currentCount;
    this.maxAllowed = opts.maxAllowed;
  }
}

export class SubscriptionReadOnlyError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'SUBSCRIPTION_EXPIRED_READ_ONLY';

  constructor(
    message = "Votre période d'essai de 14 jours ou votre abonnement est arrivé à échéance. Votre établissement est actuellement en mode lecture seule : vos données restent intégralement consultables et exportables. Régularisez votre abonnement pour reprendre les créations et modifications."
  ) {
    super(message);
    this.name = 'SubscriptionReadOnlyError';
  }
}

export class TermsReacceptanceRequiredError extends Error {
  public readonly statusCode = 403;
  public readonly code = 'TERMS_REACCEPTANCE_REQUIRED';
  public readonly requiresReacceptance = true;
  public readonly currentRequiredCguVersion: string;
  public readonly currentRequiredCgvVersion: string;

  constructor(opts: {
    currentRequiredCguVersion: string;
    currentRequiredCgvVersion: string;
    message?: string;
  }) {
    super(
      opts.message ||
      `Une nouvelle version obligatoire des Conditions Générales d'Utilisation (${opts.currentRequiredCguVersion}) et des Conditions Générales de Vente (${opts.currentRequiredCgvVersion}) doit être acceptée avant toute opération d'écriture.`
    );
    this.name = 'TermsReacceptanceRequiredError';
    this.currentRequiredCguVersion = opts.currentRequiredCguVersion;
    this.currentRequiredCgvVersion = opts.currentRequiredCgvVersion;
  }
}

/**
 * Enregistre de manière immuable (append-only) l'acceptation explicite des CGU et CGV
 * ainsi que la prise de connaissance de la Politique de confidentialité.
 * La date d'acceptation est générée exclusivement côté serveur (NOW()).
 */
export async function recordUserTermsAcceptance(
  db: DbExecutor,
  opts: {
    companyId: string;
    userId: string;
    cguVersion?: string | null;
    cgvVersion?: string | null;
    privacyPolicyVersion?: string | null;
    source: 'register' | 'reacceptance' | 'admin_demo';
    userAgent?: string | null;
  }
): Promise<{
  id: string;
  companyId: string;
  userId: string;
  cguVersion: string;
  cgvVersion: string;
  privacyPolicyVersion: string;
  acceptedAt: string;
  proofHash: string;
  source: string;
}> {
  const required = getRequiredLegalVersions();
  const cguVersion = (opts.cguVersion || required.cguVersion).trim();
  const cgvVersion = (opts.cgvVersion || required.cgvVersion).trim();
  const privacyPolicyVersion = (opts.privacyPolicyVersion || required.privacyPolicyVersion).trim();

  if (cguVersion !== required.cguVersion || cgvVersion !== required.cgvVersion) {
    const err = new Error(
      `Version des conditions contractuelles obsolète ou invalide (attendu CGU=${required.cguVersion}, CGV=${required.cgvVersion}).`
    ) as Error & { statusCode?: number; code?: string };
    err.statusCode = 400;
    err.code = 'TERMS_VERSION_MISMATCH';
    throw err;
  }

  // Horodatage serveur fiable issu de PostgreSQL (impossible à falsifier depuis le navigateur)
  const nowRes = await db.query(`SELECT NOW() AS server_now`);
  const serverNowIso = new Date(nowRes.rows[0].server_now).toISOString();

  const proofPayload = [
    opts.companyId,
    opts.userId,
    cguVersion,
    cgvVersion,
    privacyPolicyVersion,
    serverNowIso,
    opts.source,
  ].join('|');
  const proofHash = crypto.createHash('sha256').update(proofPayload).digest('hex');

  const insRes = await db.query(
    `INSERT INTO public.user_terms_acceptances (
       company_id, user_id, cgu_version, cgv_version, privacy_policy_version,
       privacy_policy_acknowledged, accepted_at, acceptance_source, proof_hash, user_agent
     )
     VALUES ($1, $2, $3, $4, $5, TRUE, $6::timestamptz, $7, $8, $9)
     RETURNING id, company_id, user_id, cgu_version, cgv_version, privacy_policy_version, accepted_at, proof_hash, acceptance_source`,
    [
      opts.companyId,
      opts.userId,
      cguVersion,
      cgvVersion,
      privacyPolicyVersion,
      serverNowIso,
      opts.source,
      proofHash,
      opts.userAgent ? String(opts.userAgent).slice(0, 300) : null,
    ]
  );

  const row = insRes.rows[0];

  try {
    await db.query(
      `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
       VALUES ($1, $2, $3, 'user_terms_acceptances', $4, $5::jsonb)`,
      [
        opts.companyId,
        opts.userId,
        opts.source === 'reacceptance' ? 'TERMS_REACCEPTED' : 'TERMS_ACCEPTED_ON_REGISTER',
        row.id,
        JSON.stringify({
          cguVersion,
          cgvVersion,
          privacyPolicyVersion,
          acceptedAt: new Date(row.accepted_at).toISOString(),
          proofHash,
          source: opts.source,
        }),
      ]
    );
  } catch {
    // non-blocking if audit_logs trigger already ran
  }

  return {
    id: row.id,
    companyId: row.company_id,
    userId: row.user_id,
    cguVersion: row.cgu_version,
    cgvVersion: row.cgv_version,
    privacyPolicyVersion: row.privacy_policy_version,
    acceptedAt: new Date(row.accepted_at).toISOString(),
    proofHash: row.proof_hash,
    source: row.acceptance_source,
  };
}

export async function getUserTermsAcceptanceStatus(
  db: DbExecutor,
  companyId: string,
  userId?: string | null
): Promise<{
  accepted: boolean;
  requiresReacceptance: boolean;
  currentRequiredCguVersion: string;
  currentRequiredCgvVersion: string;
  currentRequiredPrivacyVersion: string;
  latestAcceptance: {
    id: string;
    cguVersion: string;
    cgvVersion: string;
    privacyPolicyVersion: string;
    acceptedAt: string;
    proofHash: string;
    source: string;
  } | null;
  historyCount: number;
}> {
  const required = getRequiredLegalVersions();
  const res = await db.query(
    `SELECT id, user_id, cgu_version, cgv_version, privacy_policy_version, accepted_at, proof_hash, acceptance_source
     FROM public.user_terms_acceptances
     WHERE company_id = $1
     ORDER BY accepted_at DESC`,
    [companyId]
  );

  if (res.rows.length === 0) {
    if (companyId === DEMO_TENANT_ID) {
      return {
        accepted: true,
        requiresReacceptance: false,
        currentRequiredCguVersion: required.cguVersion,
        currentRequiredCgvVersion: required.cgvVersion,
        currentRequiredPrivacyVersion: required.privacyPolicyVersion,
        latestAcceptance: null,
        historyCount: 0,
      };
    }
    return {
      accepted: false,
      requiresReacceptance: true,
      currentRequiredCguVersion: required.cguVersion,
      currentRequiredCgvVersion: required.cgvVersion,
      currentRequiredPrivacyVersion: required.privacyPolicyVersion,
      latestAcceptance: null,
      historyCount: 0,
    };
  }

  const userRows = userId ? res.rows.filter((r: any) => r.user_id === userId) : [];
  const matchingRequiredRow =
    res.rows.find(
      (r: any) =>
        (!userId || r.user_id === userId) &&
        r.cgu_version === required.cguVersion &&
        r.cgv_version === required.cgvVersion
    ) ||
    res.rows.find(
      (r: any) => r.cgu_version === required.cguVersion && r.cgv_version === required.cgvVersion
    ) ||
    null;

  const latestUserRow = userRows[0] || null;
  const latestCompanyRow = res.rows[0];
  const latest =
    matchingRequiredRow ||
    (latestUserRow &&
      new Date(latestUserRow.accepted_at).getTime() >= new Date(latestCompanyRow.accepted_at).getTime()
      ? latestUserRow
      : latestCompanyRow);

  const isUpToDate = Boolean(matchingRequiredRow);

  return {
    accepted: isUpToDate,
    requiresReacceptance: !isUpToDate,
    currentRequiredCguVersion: required.cguVersion,
    currentRequiredCgvVersion: required.cgvVersion,
    currentRequiredPrivacyVersion: required.privacyPolicyVersion,
    latestAcceptance: {
      id: latest.id,
      cguVersion: latest.cgu_version,
      cgvVersion: latest.cgv_version,
      privacyPolicyVersion: latest.privacy_policy_version,
      acceptedAt: new Date(latest.accepted_at).toISOString(),
      proofHash: latest.proof_hash,
      source: latest.acceptance_source,
    },
    historyCount: userRows.length > 0 ? userRows.length : res.rows.length,
  };
}

/**
 * Démarre explicitement la période d'essai gratuit de 14 jours dès la création de l'établissement
 * (et jamais lors d'une simple requête GET /api/subscriptions/current).
 */
export async function initializeCompanyTrialSubscription(
  db: DbExecutor,
  companyId: string,
  opts: {
    planCode?: 'ESSENTIEL' | 'PRO' | 'ENTREPRISE';
    status?: 'trial' | 'active';
    durationDays?: number;
  } = {}
): Promise<any> {
  const planCode = opts.planCode || 'PRO';
  const status = opts.status || 'trial';
  const durationDays = opts.durationDays ?? 14;

  const planRes = await db.query(
    `SELECT id FROM public.subscription_plans WHERE code = $1 LIMIT 1`,
    [planCode]
  );
  const planId = planRes.rows[0]?.id || null;

  const subRes = await db.query(
    `INSERT INTO public.company_subscriptions (
       company_id, plan_id, plan_code, status, billing_period,
       starts_at, ends_at, trial_ends_at, current_period_start, current_period_end, updated_at
     )
     VALUES (
       $1, $2, $3, $4, 'monthly',
       NOW(),
       NOW() + make_interval(days => $5),
       NOW() + make_interval(days => $5),
       NOW(),
       NOW() + make_interval(days => $5),
       NOW()
     )
     ON CONFLICT (company_id) DO NOTHING
     RETURNING *`,
    [companyId, planId, planCode, status, durationDays]
  );

  if (subRes.rows.length > 0) {
    return subRes.rows[0];
  }

  const existing = await db.query(
    `SELECT * FROM public.company_subscriptions WHERE company_id = $1 LIMIT 1`,
    [companyId]
  );
  return existing.rows[0] || null;
}

export interface ResolvedSubscriptionState {
  subscription: any;
  planCode: string;
  planName: string;
  status: string;
  isExpired: boolean;
  isReadOnly: boolean;
  daysRemaining: number;
  quotas: PlanQuotas;
}

/**
 * Résout l'état réel de l'abonnement d'un établissement, bascule automatiquement
 * un essai ou abonnement arrivé à échéance au statut 'expired' (mode lecture seule),
 * et retourne les quotas applicables.
 */
export async function resolveCompanySubscriptionState(
  db: DbExecutor,
  companyId: string
): Promise<ResolvedSubscriptionState> {
  const subRes = await db.query(
    `SELECT cs.*,
            sp.code AS sp_code,
            sp.name AS sp_name,
            sp.monthly_price,
            sp.quarterly_price,
            sp.semiannual_price,
            sp.yearly_price,
            sp.setup_fee,
            sp.features,
            sp.max_users AS sp_max_users,
            sp.max_locations AS sp_max_locations,
            sp.max_tables AS sp_max_tables,
            sp.max_products AS sp_max_products
     FROM public.company_subscriptions cs
     LEFT JOIN public.subscription_plans sp
       ON (cs.plan_code IS NOT NULL AND sp.code = cs.plan_code)
       OR (cs.plan_code IS NULL AND sp.id = cs.plan_id)
     WHERE cs.company_id = $1
     LIMIT 1`,
    [companyId]
  );

  const nowRes = await db.query(`SELECT NOW() AS server_now`);
  const now = new Date(nowRes.rows[0]?.server_now || Date.now());

  if (subRes.rows.length === 0) {
    // Aucune ligne d'abonnement : NE JAMAIS créer d'essai lors d'une lecture !
    // Si c'est le tenant de démo public, son essai est géré par ensureDemoEnvironment.
    const fallbackQuotas = PLAN_QUOTA_DEFAULTS.PRO;
    return {
      subscription: {
        company_id: companyId,
        plan_code: 'PRO',
        plan_name: 'Pro Cloud Restaurant',
        status: 'expired',
        billing_period: 'monthly',
        current_period_end: null,
        trial_ends_at: null,
        daysRemaining: 0,
        isExpired: true,
        isReadOnly: true,
        max_users: fallbackQuotas.maxUsers,
        max_locations: fallbackQuotas.maxLocations,
        max_tables: fallbackQuotas.maxTables,
        max_products: fallbackQuotas.maxProducts,
      },
      planCode: 'PRO',
      planName: 'Pro Cloud Restaurant',
      status: 'expired',
      isExpired: true,
      isReadOnly: true,
      daysRemaining: 0,
      quotas: fallbackQuotas,
    };
  }

  const row = subRes.rows[0];

  // Si ce site est un établissement secondaire rattaché à un abonnement principal ENTREPRISE (MULTI-SITE:<parentCompanyId>),
  // synchroniser dynamiquement son état, sa formule, ses quotas et son expiration/suspension avec l'établissement principal,
  // tout en vérifiant que le même propriétaire actif détient toujours les deux établissements.
  if (row.last_payment_ref && String(row.last_payment_ref).startsWith('MULTI-SITE:')) {
    const parentCompanyId = String(row.last_payment_ref).slice('MULTI-SITE:'.length).trim();
    if (parentCompanyId && parentCompanyId !== companyId) {
      const sharedOwnerRes = await db.query(
        `SELECT c_parent.is_active AS parent_company_active
         FROM public.company_users cu_child
         JOIN public.roles r_child ON r_child.id = cu_child.role_id AND r_child.company_id = cu_child.company_id
         JOIN public.company_users cu_parent ON cu_parent.user_id = cu_child.user_id
         JOIN public.roles r_parent ON r_parent.id = cu_parent.role_id AND r_parent.company_id = cu_parent.company_id
         JOIN public.companies c_parent ON c_parent.id = cu_parent.company_id
         WHERE cu_child.company_id = $1
           AND cu_parent.company_id = $2
           AND cu_child.is_active = TRUE
           AND cu_parent.is_active = TRUE
           AND COALESCE((r_child.permissions->>'all')::boolean, FALSE) = TRUE
           AND COALESCE((r_parent.permissions->>'all')::boolean, FALSE) = TRUE
         LIMIT 1`,
        [companyId, parentCompanyId]
      );

      if (sharedOwnerRes.rows.length === 0) {
        const fallbackQuotas = PLAN_QUOTA_DEFAULTS.PRO;
        return {
          subscription: {
            ...row,
            status: 'expired',
            daysRemaining: 0,
            isExpired: true,
            isReadOnly: true,
          },
          planCode: String(row.plan_code || 'PRO'),
          planName: 'Accès multi-sites révoqué',
          status: 'expired',
          isExpired: true,
          isReadOnly: true,
          daysRemaining: 0,
          quotas: fallbackQuotas,
        };
      }

      const parentCompanyActive = Boolean(sharedOwnerRes.rows[0].parent_company_active);
      const parentState = await resolveCompanySubscriptionState(db, parentCompanyId);
      const pSub = parentState.subscription;
      const syncedStatus = parentCompanyActive ? parentState.status : 'suspended';
      const syncedExpired = !parentCompanyActive || parentState.isExpired;
      const syncedReadOnly = !parentCompanyActive || parentState.isReadOnly;

      if (
        row.plan_code !== parentState.planCode ||
        row.status !== syncedStatus ||
        String(row.current_period_end || '') !== String(pSub.current_period_end || '')
      ) {
        try {
          await db.query(
            `UPDATE public.company_subscriptions
             SET plan_id = $2,
                 plan_code = $3,
                 status = $4,
                 billing_period = $5,
                 starts_at = $6,
                 ends_at = $7,
                 trial_ends_at = $8,
                 current_period_start = $9,
                 current_period_end = $10,
                 custom_max_users = $11,
                 custom_max_locations = $12,
                 custom_max_tables = $13,
                 custom_max_products = $14,
                 updated_at = NOW()
             WHERE id = $1`,
            [
              row.id,
              pSub.plan_id || null,
              parentState.planCode,
              syncedStatus,
              pSub.billing_period || 'monthly',
              pSub.starts_at || null,
              pSub.ends_at || null,
              pSub.trial_ends_at || null,
              pSub.current_period_start || null,
              pSub.current_period_end || null,
              pSub.custom_max_users ?? null,
              pSub.custom_max_locations ?? null,
              pSub.custom_max_tables ?? null,
              pSub.custom_max_products ?? null,
            ]
          );
        } catch {
          // non-blocking if inside read-only role
        }
      }

      return {
        subscription: {
          ...row,
          plan_id: pSub.plan_id,
          plan_code: parentState.planCode,
          plan_name: parentState.planName,
          status: syncedStatus,
          billing_period: pSub.billing_period,
          starts_at: pSub.starts_at,
          ends_at: pSub.ends_at,
          trial_ends_at: pSub.trial_ends_at,
          current_period_start: pSub.current_period_start,
          current_period_end: pSub.current_period_end,
          daysRemaining: syncedExpired ? 0 : parentState.daysRemaining,
          isExpired: syncedExpired,
          isReadOnly: syncedReadOnly,
          max_users: parentState.quotas.maxUsers,
          max_locations: parentState.quotas.maxLocations,
          max_tables: parentState.quotas.maxTables,
          max_products: parentState.quotas.maxProducts,
          parent_company_id: parentCompanyId,
          is_linked_multi_site: true,
        },
        planCode: parentState.planCode,
        planName: parentState.planName,
        status: syncedStatus,
        isExpired: syncedExpired,
        isReadOnly: syncedReadOnly,
        daysRemaining: syncedExpired ? 0 : parentState.daysRemaining,
        quotas: parentState.quotas,
      };
    }
  }

  const planCode = String(row.plan_code || row.sp_code || 'PRO').toUpperCase();
  const baseDefaults = PLAN_QUOTA_DEFAULTS[planCode] || PLAN_QUOTA_DEFAULTS.PRO;
  const planName =
    row.sp_name ||
    (planCode === 'ESSENTIEL'
      ? 'Essentiel POS'
      : planCode === 'ENTREPRISE'
        ? 'Entreprise Multi-Sites'
        : 'Pro Cloud Restaurant');

  const quotas: PlanQuotas = {
    maxLocations: Number(row.custom_max_locations || row.sp_max_locations || baseDefaults.maxLocations),
    maxUsers: Number(row.custom_max_users || row.sp_max_users || baseDefaults.maxUsers),
    maxTables: Number(row.custom_max_tables || row.sp_max_tables || baseDefaults.maxTables),
    maxProducts: Number(row.custom_max_products || row.sp_max_products || baseDefaults.maxProducts),
  };

  const rawEnd =
    row.status === 'trial'
      ? row.trial_ends_at || row.current_period_end || row.ends_at
      : row.current_period_end || row.ends_at || row.trial_ends_at;
  const endDate = rawEnd ? new Date(rawEnd) : new Date(0);
  const isDatePast = endDate.getTime() < now.getTime();

  let effectiveStatus = String(row.status || 'trial');

  // Bascule automatique en statut 'expired' si l'essai ou l'abonnement actif a dépassé sa date de fin
  if (isDatePast && (effectiveStatus === 'trial' || effectiveStatus === 'active')) {
    effectiveStatus = 'expired';
    try {
      await db.query(
        `UPDATE public.company_subscriptions
         SET status = 'expired', updated_at = NOW()
         WHERE id = $1 AND status IN ('trial', 'active')`,
        [row.id]
      );
    } catch {
      // non-blocking if inside read-only role
    }
  }

  const isExpired =
    ['expired', 'past_due', 'suspended', 'cancelled'].includes(effectiveStatus) ||
    (effectiveStatus === 'pending_payment' && isDatePast) ||
    isDatePast;

  const isReadOnly =
    companyId === DEMO_TENANT_ID
      ? false
      : ['expired', 'past_due', 'suspended', 'cancelled'].includes(effectiveStatus) ||
      (effectiveStatus === 'pending_payment' && isDatePast) ||
      isDatePast;

  const daysRemaining = isDatePast
    ? 0
    : Math.max(0, Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 3600 * 24)));

  return {
    subscription: {
      ...row,
      plan_code: planCode,
      plan_name: planName,
      status: effectiveStatus,
      daysRemaining,
      isExpired,
      isReadOnly,
      max_users: quotas.maxUsers,
      max_locations: quotas.maxLocations,
      max_tables: quotas.maxTables,
      max_products: quotas.maxProducts,
    },
    planCode,
    planName,
    status: effectiveStatus,
    isExpired,
    isReadOnly,
    daysRemaining,
    quotas,
  };
}

/**
 * Middleware Express : autorise toutes les consultations et exports (GET/HEAD/OPTIONS)
 * mais bloque côté serveur toute opération d'écriture/création/modification :
 * 1. Lorsqu'une nouvelle version obligatoire des CGU/CGV doit être réacceptée (requiresReacceptance === true).
 * 2. Lorsque la période d'essai ou l'abonnement de l'établissement est expiré (mode lecture seule).
 */
export async function requireActiveSubscriptionWriteAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      next();
      return;
    }

    const companyId = req.auth?.companyId;
    if (!companyId || companyId === DEMO_TENANT_ID) {
      next();
      return;
    }

    const termsStatus = await getUserTermsAcceptanceStatus(adminPool, companyId, req.auth?.userId);
    if (termsStatus.requiresReacceptance) {
      res.status(403).json({
        success: false,
        error: {
          code: 'TERMS_REACCEPTANCE_REQUIRED',
          message:
            "Une nouvelle version obligatoire des Conditions Générales d'Utilisation (CGU) et des Conditions Générales de Vente (CGV) est entrée en vigueur. Vous devez accepter ces conditions mises à jour avant d'effectuer toute opération d'écriture.",
          requiresReacceptance: true,
          currentRequiredCguVersion: termsStatus.currentRequiredCguVersion,
          currentRequiredCgvVersion: termsStatus.currentRequiredCgvVersion,
        },
      });
      return;
    }

    const state = await resolveCompanySubscriptionState(adminPool, companyId);
    if (state.isReadOnly) {
      res.status(403).json({
        success: false,
        error: {
          code: 'SUBSCRIPTION_EXPIRED_READ_ONLY',
          message:
            "Votre période d'essai de 14 jours ou votre abonnement est arrivé à échéance. Votre espace est en mode lecture seule : vous pouvez consulter et exporter vos données, ou régulariser votre abonnement pour débloquer les opérations.",
          subscriptionStatus: state.status,
          isReadOnly: true,
        },
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Vérifie et applique côté serveur les quotas de la formule d'abonnement active
 * (ESSENTIEL, PRO, ENTREPRISE) avec verrou transactionnel anti-concurrence.
 */
export async function enforceSubscriptionQuota(
  db: DbExecutor,
  companyId: string,
  resourceType: QuotaResourceType,
  opts: {
    ownerUserId?: string;
    incrementBy?: number;
  } = {}
): Promise<{
  planCode: string;
  currentCount: number;
  maxAllowed: number;
}> {
  const incrementBy = opts.incrementBy ?? 1;

  // Verrou transactionnel PostgreSQL (pg_advisory_xact_lock ne nécessite aucun privilège UPDATE sur companies)
  try {
    await db.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`quota:${companyId}:${resourceType}`]);
  } catch {
    // fallback in case db is a pool without active transaction
  }

  if (companyId !== DEMO_TENANT_ID) {
    const termsStatus = await getUserTermsAcceptanceStatus(db, companyId, opts.ownerUserId);
    if (termsStatus.requiresReacceptance) {
      throw new TermsReacceptanceRequiredError({
        currentRequiredCguVersion: termsStatus.currentRequiredCguVersion,
        currentRequiredCgvVersion: termsStatus.currentRequiredCgvVersion,
      });
    }
  }

  const subState = await resolveCompanySubscriptionState(db, companyId);
  if (subState.isReadOnly) {
    throw new SubscriptionReadOnlyError();
  }

  const { planCode, planName, quotas } = subState;
  let currentCount = 0;
  let maxAllowed = 0;
  let resourceLabel = '';

  if (resourceType === 'users') {
    maxAllowed = quotas.maxUsers;
    resourceLabel = 'utilisateurs actifs';
    const cntRes = await db.query(
      `SELECT COUNT(*)::INT AS cnt
       FROM public.company_users cu
       JOIN public.users u ON u.id = cu.user_id
       WHERE cu.company_id = $1 AND cu.is_active = TRUE AND u.is_active = TRUE`,
      [companyId]
    );
    currentCount = Number(cntRes.rows[0]?.cnt || 0);
  } else if (resourceType === 'tables') {
    maxAllowed = quotas.maxTables;
    resourceLabel = 'tables QR';
    const cntRes = await db.query(
      `SELECT COUNT(*)::INT AS cnt
       FROM public.dining_tables
       WHERE company_id = $1 AND is_active = TRUE`,
      [companyId]
    );
    currentCount = Number(cntRes.rows[0]?.cnt || 0);
  } else if (resourceType === 'products') {
    maxAllowed = quotas.maxProducts;
    resourceLabel = 'produits actifs au catalogue';
    const cntRes = await db.query(
      `SELECT COUNT(*)::INT AS cnt
       FROM public.products
       WHERE company_id = $1 AND is_active = TRUE`,
      [companyId]
    );
    currentCount = Number(cntRes.rows[0]?.cnt || 0);
  } else if (resourceType === 'locations') {
    maxAllowed = quotas.maxLocations;
    resourceLabel = 'établissements / sites actifs';
    let ownerId = opts.ownerUserId;
    if (!ownerId) {
      const ownRes = await db.query(
        `SELECT cu.user_id
         FROM public.company_users cu
         LEFT JOIN public.roles r ON r.id = cu.role_id AND r.company_id = cu.company_id
         WHERE cu.company_id = $1 AND cu.is_active = TRUE
         ORDER BY COALESCE((r.permissions->>'all')::boolean, FALSE) DESC, cu.joined_at ASC
         LIMIT 1`,
        [companyId]
      );
      ownerId = ownRes.rows[0]?.user_id;
    }
    if (ownerId) {
      const cntRes = await db.query(
        `SELECT COUNT(DISTINCT cu.company_id)::INT AS cnt
         FROM public.company_users cu
         JOIN public.companies c ON c.id = cu.company_id
         LEFT JOIN public.roles r ON r.id = cu.role_id AND r.company_id = cu.company_id
         WHERE cu.user_id = $1
           AND cu.is_active = TRUE
           AND c.is_active = TRUE
           AND COALESCE((r.permissions->>'all')::boolean, FALSE) = TRUE`,
        [ownerId]
      );
      currentCount = Number(cntRes.rows[0]?.cnt || 0);
    } else {
      currentCount = 1;
    }
  }

  if (currentCount + incrementBy > maxAllowed) {
    throw new SubscriptionQuotaError({
      resourceType,
      planCode,
      currentCount,
      maxAllowed,
      message: `Quota atteint pour la formule ${planName} (${planCode}) : ${currentCount}/${maxAllowed} ${resourceLabel}. Supprimez ou désactivez un élément inutilisé, ou passez à une formule supérieure.`,
    });
  }

  return {
    planCode,
    currentCount,
    maxAllowed,
  };
}
