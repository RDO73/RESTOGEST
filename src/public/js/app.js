import {
  apiFetch,
  esc,
  fmtDate,
  fmtMoney,
  fmtQty,
  getToken,
  setOnUnauthorized,
  setToken,
  showToast,
} from './api.js';
import {
  playQrNotificationSound,
  renderTablesAndQrModule,
  bindTablesAndQrModule,
  renderQrOrdersAndKdsModule,
  bindQrOrdersAndKdsModule,
  renderSubscriptionModuleV12,
  bindSubscriptionModuleV12,
  renderSaasFinancesAdminModule,
  bindSaasFinancesAdminModule,
} from './qr-and-saas-ui.js';
import {
  renderStaffModule,
  bindStaffModule,
  renderCustomersModule,
  bindCustomersModule,
} from './staff-ui.js';

const FLOOR_TABLES = [
  ...Array.from({ length: 12 }, (_, idx) => ({
    code: `T${idx + 1}`,
    name: `Table ${idx + 1}`,
    zone: 'Salle',
    seats: idx < 4 ? 2 : idx < 10 ? 4 : 6,
  })),
  { code: 'TER1', name: 'Terrasse 1', zone: 'Terrasse', seats: 4 },
  { code: 'TER2', name: 'Terrasse 2', zone: 'Terrasse', seats: 6 },
  { code: 'CPT1', name: 'Comptoir 1', zone: 'Comptoir', seats: 2 },
  { code: 'CPT2', name: 'Comptoir 2', zone: 'Comptoir', seats: 2 },
];

const PAYMENT_CHANNELS = [
  { id: 'cash', apiMethod: 'cash', label: 'Espèces', ref: 'Espèces' },
  { id: 'wave', apiMethod: 'mobile_money', label: 'Wave', ref: 'Wave' },
  { id: 'orange_money', apiMethod: 'mobile_money', label: 'Orange Money', ref: 'Orange Money' },
  { id: 'card', apiMethod: 'card', label: 'Carte Bancaire', ref: 'Carte Bancaire' },
  { id: 'transfer', apiMethod: 'transfer', label: 'Virement / Chèque', ref: 'Virement' },
];

const state = {
  health: null,
  user: null,
  company: null,
  role: { code: 'owner', name: 'Propriétaire', isOwner: true, defaultRoute: 'dashboard', permissions: { all: true } },
  isDemo: false,
  isRefreshing: false,
  refreshSeq: 0,
  appliedRefreshSeq: 0,
  subscriptionData: null,
  route: 'dashboard',
  subtabs: {
    catalog: 'products',
    purchases: 'orders',
    tables: 'floor',
    qrOrders: 'live',
    saasAdmin: 'transactions',
  },
  tableZone: 'all',
  billingCycle: 'monthly',
  checkoutMethod: 'wave',
  categories: [],
  products: [],
  recipes: [],
  levels: [],
  alerts: [],
  invSummary: null,
  movements: [],
  suppliers: [],
  purchases: [],
  activePurchase: null,
  sales: [],
  activeSale: null,
  cashCurrent: null,
  cashSessions: [],
  expenses: [],
  customers: [],
  customerSearch: '',
  staffMembers: [],
  staffPresets: null,
  staffActivity: [],
  staffActivityUserFilter: '',
  lastCreatedStaff: null,
  qrTables: [],
  qrSettings: {},
  qrOptions: [],
  qrOrders: [],
  qrServiceRequests: [],
  qrAnalytics: null,
  qrAnalyticsPeriod: 'month',
  qrOrderStatusFilter: 'active',
  qrSoundEnabled: true,
  knownQrOrderIds: null,
  saasAdminOverview: null,
  posFilter: { search: '', categoryId: '' },
  invFilter: { search: '', lowStockOnly: false },
  payChannel: 'cash',
};

const ROUTE_META = {
  dashboard: { title: 'Tableau de bord', sub: 'Indicateurs clés et alertes en temps réel' },
  tables: { title: 'Tables & QR Codes', sub: 'Plan de salle, QR Codes par table, menu digital et options produits' },
  'qr-orders': { title: 'Commandes QR & Cuisine', sub: 'Réception en direct, écran cuisine (KDS), encaissement et statistiques' },
  pos: { title: 'Caisse & POS', sub: 'Prise de commande, livraison WhatsApp et encaissement' },
  catalog: { title: 'Catalogue & Recettes', sub: 'Catégories, articles et fiches recettes anti-coulage' },
  inventory: { title: 'Stocks & Alertes', sub: 'Niveaux, valorisation PMP, alertes et ajustements' },
  purchases: { title: 'Achats & Fournisseurs', sub: 'Approvisionnement, réception et calcul automatique du PMP' },
  cash: { title: 'Trésorerie & Caisse', sub: 'Ouverture, dépenses et clôture Z détaillée' },
  customers: { title: 'Fichier Clients', sub: 'Répertoire clients, historique de commandes et points de fidélité' },
  staff: { title: 'Équipe & Employés', sub: 'Comptes individuels, rôles métiers, autorisations et suivi d’activité' },
  subscription: { title: 'Abonnement & Licence', sub: 'Comparateur des plans, souscription SaaS et factures XOF / GNF' },
  'saas-admin': { title: 'Finances MyRestoGest', sub: 'Pilotage des revenus SaaS, abonnements clients, factures et reversements' },
};

const ROUTE_PERMISSIONS = {
  dashboard: ['dashboard:read', 'reports:read'],
  tables: ['tables:read', 'tables:write'],
  'qr-orders': ['qr_orders:read', 'qr_orders:write'],
  pos: ['pos:read', 'pos:write', 'pos:pay'],
  catalog: ['catalog:read', 'catalog:write'],
  inventory: ['inventory:read', 'inventory:write'],
  purchases: ['purchases:read', 'purchases:write'],
  cash: ['cash:read', 'cash:write', 'reports:read'],
  customers: ['customers:read', 'customers:write'],
  staff: ['staff:manage'],
  subscription: ['settings:manage'],
  'saas-admin': ['__super_admin_only__'],
};

function can(required) {
  const perms = state.role?.permissions || {};
  if (perms.all === true) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.some((p) => perms[p] === true);
}

function canAccessRoute(route) {
  const req = ROUTE_PERMISSIONS[route];
  if (!req) return true;
  return can(req);
}

function getPreferredRoute() {
  const def = state.role?.defaultRoute || 'dashboard';
  if (canAccessRoute(def)) return def;
  for (const r of ['dashboard', 'pos', 'tables', 'qr-orders', 'inventory', 'cash', 'catalog', 'purchases', 'customers', 'staff', 'subscription']) {
    if (canAccessRoute(r)) return r;
  }
  return 'dashboard';
}

async function withFormSubmit(form, task) {
  if (!form || form.dataset.submitting === '1') return;
  form.dataset.submitting = '1';
  const btn = form.querySelector('button[type="submit"]');
  const prevText = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Enregistrement...';
  }
  try {
    await task();
  } catch (err) {
    showToast(err?.message || 'Erreur lors de l’enregistrement. Vos données saisies sont conservées.', 'error');
  } finally {
    delete form.dataset.submitting;
    if (btn) {
      btn.disabled = false;
      btn.textContent = prevText;
    }
  }
}

function isUserActivelyEditingForm() {
  const active = document.activeElement;
  if (!active) return false;
  const main = document.getElementById('main-content');
  if (!main || !main.contains(active)) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

const CURRENCY = () => state.company?.currency || state.subscriptionData?.settings?.currency || state.subscriptionData?.company?.currency || 'XOF';

function statusBadge(status) {
  const labels = {
    open: 'Ouverte',
    closed: 'Clôturée',
    pending: 'En attente',
    pending_payment: 'Paiement en attente',
    completed: 'Validée',
    cancelled: 'Annulée',
    ordered: 'Commandée',
    received: 'Réceptionnée',
    draft: 'Brouillon',
    trial: 'Essai gratuit',
    active: 'Actif',
    past_due: 'Impayé',
    expired: 'Expiré',
    suspended: 'Suspendu',
  };
  return `<span class="status-pill status-${esc(status)}">${esc(labels[status] || status)}</span>`;
}

function methodLabel(m, ref = '') {
  if (m === 'mobile_money') {
    const low = String(ref || '').toLowerCase();
    if (low.includes('wave')) return 'Wave';
    if (low.includes('orange') || low.includes('om')) return 'Orange Money';
    return 'Mobile Money';
  }
  return (
    {
      cash: 'Espèces',
      card: 'Carte Bancaire',
      mobile_money: 'Mobile Money',
      transfer: 'Virement',
      check: 'Chèque',
      other: 'Autre',
    }[m] || m
  );
}

// -------------------------------------------------------------
// MÉTADONNÉES COMMANDES (TABLE, SERVICE, LIVRAISON)
// -------------------------------------------------------------
const META_PREFIX = 'RG_META:';

function parseSaleMeta(notes) {
  const defaults = {
    serviceMode: 'dine_in',
    tableCode: '',
    tableName: '',
    tableState: 'occupied',
    customerName: '',
    customerPhone: '',
    deliveryZone: '',
    deliveryFee: 0,
    courierName: '',
    freeNote: '',
  };
  if (!notes || typeof notes !== 'string') return defaults;
  if (notes.startsWith(META_PREFIX)) {
    try {
      const parsed = JSON.parse(notes.slice(META_PREFIX.length));
      return { ...defaults, ...parsed, deliveryFee: Number(parsed?.deliveryFee || 0) };
    } catch {
      return { ...defaults, freeNote: notes };
    }
  }
  return { ...defaults, freeNote: notes };
}

function serializeSaleMeta(meta) {
  const clean = {
    serviceMode: meta.serviceMode || 'dine_in',
    tableCode: meta.tableCode || '',
    tableName: meta.tableName || '',
    tableState: meta.tableState || 'occupied',
    customerName: meta.customerName || '',
    customerPhone: meta.customerPhone || '',
    deliveryZone: meta.deliveryZone || '',
    deliveryFee: Number(meta.deliveryFee || 0),
    courierName: meta.courierName || '',
    freeNote: meta.freeNote || '',
  };
  return `${META_PREFIX}${JSON.stringify(clean)}`;
}

function serviceModeSummary(meta) {
  if (meta.serviceMode === 'delivery') {
    return `Livraison${meta.deliveryZone ? ` (${meta.deliveryZone})` : ''}`;
  }
  if (meta.serviceMode === 'takeaway') {
    return 'À emporter';
  }
  return meta.tableName ? `Sur place • ${meta.tableName}` : 'Sur place';
}

function cleanWaDigits(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

// -------------------------------------------------------------
// MODALE, DRAWER & NAVIGATION
// -------------------------------------------------------------
function openModal(title, html) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  document.getElementById('modal-body').innerHTML = '';
}

function confirmActionModal({ title, message, confirmLabel = 'Confirmer', variant = 'danger', onConfirm }) {
  openModal(
    title,
    `<div class="form-stack">
      <p class="muted-text" style="line-height:1.6;">${esc(message)}</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px;">
        <button type="button" id="btn-confirm-cancel" class="btn btn-outline">Annuler</button>
        <button type="button" id="btn-confirm-accept" class="btn btn-${esc(variant)}">${esc(confirmLabel)}</button>
      </div>
    </div>`
  );
  document.getElementById('btn-confirm-cancel')?.addEventListener('click', closeModal);
  document.getElementById('btn-confirm-accept')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-confirm-accept');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Traitement...';
    }
    try {
      await onConfirm();
      closeModal();
    } catch (err) {
      closeModal();
      showToast(err?.message || 'Action impossible pour le moment.', 'error');
    }
  });
}

function toggleSidebar(forceOpen) {
  const sb = document.getElementById('app-sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  if (!sb || !bd) return;
  const open = typeof forceOpen === 'boolean' ? forceOpen : !sb.classList.contains('open');
  sb.classList.toggle('open', open);
  bd.classList.toggle('hidden', !open);
}

function switchAuthTab(tab) {
  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.authTab === tab);
  });
  document.getElementById('login-form').classList.toggle('hidden', tab !== 'login');
  document.getElementById('register-form').classList.toggle('hidden', tab !== 'register');
}

function showAuthView() {
  document.getElementById('auth-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

function applyRoleNavigation() {
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach((el) => {
    const r = el.dataset.route;
    if (!r) return;
    const allowed = canAccessRoute(r);
    el.classList.toggle('hidden', !allowed);
    el.classList.toggle('active', r === state.route);
  });
  const soundBtn = document.getElementById('btn-toggle-qr-sound');
  if (soundBtn) soundBtn.classList.toggle('hidden', !can(['qr_orders:read', 'qr_orders:write']));
  const cashPill = document.getElementById('cash-status-pill');
  if (cashPill) cashPill.classList.toggle('hidden', !can(['cash:read', 'cash:write', 'reports:read']));
}

function showAppView() {
  document.getElementById('auth-modal-backdrop')?.classList.add('hidden');
  document.body.style.overflow = '';
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  if (!canAccessRoute(state.route)) {
    state.route = getPreferredRoute();
  }
  applyRoleNavigation();
  renderChrome();
  renderRoute();
}

function setRoute(route) {
  if (!canAccessRoute(route)) {
    showToast('Votre rôle ne dispose pas des autorisations pour accéder à cette rubrique.', 'warning');
    return;
  }
  state.route = route;
  applyRoleNavigation();
  toggleSidebar(false);
  renderChrome();
  renderRoute();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderChrome() {
  if (!canAccessRoute(state.route)) {
    state.route = getPreferredRoute();
  }
  applyRoleNavigation();
  const meta = ROUTE_META[state.route] || ROUTE_META.dashboard;
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-subtitle').textContent = `${meta.sub}${state.role?.name ? ` · Profil : ${state.role.name}` : ''}`;

  if (state.company && state.user) {
    document.getElementById('sidebar-company-name').textContent = `${state.company.name} (${CURRENCY()})`;
    document.getElementById('user-fullname').textContent = state.user.full_name;
    document.getElementById('user-email').textContent = state.user.email;
    const roleBadgeEl = document.getElementById('user-role-badge');
    if (roleBadgeEl) {
      roleBadgeEl.textContent = state.role?.name || 'Propriétaire';
    }
    const initials = (state.user.full_name || 'RG')
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() || '')
      .join('');
    document.getElementById('user-avatar').textContent = initials || 'RG';
  }

  const cashPill = document.getElementById('cash-status-pill');
  if (cashPill && !cashPill.classList.contains('hidden')) {
    if (state.cashCurrent) {
      cashPill.className = 'status-pill status-open';
      cashPill.textContent = `Caisse : ${fmtMoney(state.cashCurrent.metrics?.theoreticalCashInDrawer, CURRENCY())}`;
    } else {
      cashPill.className = 'status-pill status-closed';
      cashPill.textContent = 'Caisse fermée';
    }
  }

  const licPill = document.getElementById('license-status-pill');
  if (licPill) {
    const sub = state.subscriptionData?.subscription || state.subscriptionStatus;
    if (sub?.isReadOnly || sub?.status === 'expired') {
      licPill.className = 'status-pill status-closed hide-xs';
      licPill.textContent = 'Mode Lecture Seule (Expiré)';
    } else if (sub?.status === 'active') {
      licPill.className = 'status-pill status-open hide-xs';
      licPill.textContent = `Licence : ${sub.plan_name || sub.planName || sub.plan_code}`;
    } else if (sub?.status === 'trial') {
      licPill.className = 'status-pill status-pending hide-xs';
      licPill.textContent = `Essai 14j • ${sub.plan_name || sub.planName || 'Pro'}`;
    } else if (sub?.status === 'pending_payment') {
      licPill.className = 'status-pill status-pending hide-xs';
      licPill.textContent = 'Paiement en vérification';
    } else {
      licPill.className = 'status-pill status-neutral hide-xs';
      licPill.textContent = 'MyRestoGest';
    }
  }

  const readOnlyBanner = document.getElementById('readonly-subscription-banner');
  if (readOnlyBanner) {
    const sub = state.subscriptionData?.subscription || state.subscriptionStatus;
    if (!state.isDemo && sub?.isReadOnly) {
      readOnlyBanner.classList.remove('hidden');
      readOnlyBanner.innerHTML = `
        <div>
          <strong>🔒 Mode Lecture Seule — Période d’essai ou abonnement arrivé à échéance</strong> :
          vos ventes, rapports Z, stocks et produits restent intégralement consultables et exportables, mais les nouvelles saisies sont suspendues jusqu’à la régularisation de votre abonnement.
        </div>
        <button id="btn-readonly-go-sub" type="button" class="btn btn-danger btn-sm">Régulariser mon abonnement</button>
      `;
      document.getElementById('btn-readonly-go-sub')?.addEventListener('click', () => setRoute('subscription'));
    } else {
      readOnlyBanner.classList.add('hidden');
      readOnlyBanner.innerHTML = '';
    }
  }

  const termsBanner = document.getElementById('terms-reacceptance-banner');
  if (termsBanner) {
    if (!state.isDemo && state.termsStatus?.requiresReacceptance) {
      termsBanner.classList.remove('hidden');
      termsBanner.innerHTML = `
        <div>
          <strong>📋 Mise à jour des conditions contractuelles MyRestoGest</strong> :
          veuillez consulter et valider la version en vigueur des
          <a href="/cgu" target="_blank" rel="noopener" style="text-decoration:underline;font-weight:700;">CGU (${esc(state.termsStatus.currentRequiredCguVersion)})</a>
          et des
          <a href="/cgv" target="_blank" rel="noopener" style="text-decoration:underline;font-weight:700;">CGV (${esc(state.termsStatus.currentRequiredCgvVersion)})</a>.
        </div>
        <button id="btn-reaccept-terms-now" type="button" class="btn btn-primary btn-sm">J’accepte les CGU et CGV mises à jour</button>
      `;
      document.getElementById('btn-reaccept-terms-now')?.addEventListener('click', async () => {
        try {
          const res = await apiFetch('/api/auth/accept-terms', {
            method: 'POST',
            body: {
              acceptTerms: true,
              cguVersion: state.termsStatus.currentRequiredCguVersion,
              cgvVersion: state.termsStatus.currentRequiredCgvVersion,
            },
          });
          state.termsStatus = res.data?.termsStatus || { requiresReacceptance: false };
          renderChrome();
          showToast('Acceptation des CGU et CGV enregistrée avec succès.', 'success');
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    } else {
      termsBanner.classList.add('hidden');
      termsBanner.innerHTML = '';
    }
  }

  const dbPill = document.getElementById('sidebar-db-pill');
  const isEphemeral = state.health?.database === 'pglite-ephemeral';
  if (dbPill) {
    if (isEphemeral) {
      dbPill.textContent = 'Mode bac à sable temporaire';
      dbPill.classList.add('is-ephemeral');
    } else {
      dbPill.textContent = 'Base PostgreSQL persistante';
      dbPill.classList.remove('is-ephemeral');
    }
  }

  const demoBanner = document.getElementById('demo-mode-banner');
  if (demoBanner) {
    if (state.isDemo) {
      demoBanner.classList.remove('hidden');
      demoBanner.innerHTML = `
        <div>
          <strong>Mode Démonstration isolé (${esc(state.company?.name || 'Le Palais Gourmand (Démo)')})</strong> —
          ${
            isEphemeral
              ? 'Cet aperçu tourne sans base externe : les saisies peuvent être réinitialisées entre redémarrages serveur.'
              : 'Vos opérations de test sont enregistrées dans cet espace de démonstration séparé des vrais établissements.'
          }
        </div>
        <button id="btn-demo-create-real" type="button" class="btn btn-primary btn-sm">Créer mon vrai établissement</button>
      `;
      document.getElementById('btn-demo-create-real')?.addEventListener('click', async () => {
        try {
          await apiFetch('/api/auth/logout', { method: 'POST', ignoreUnauthorized: true });
        } catch {
          // ignore
        }
        setToken(null);
        state.user = null;
        state.company = null;
        state.isDemo = false;
        showAuthView();
        document.getElementById('auth-modal-backdrop')?.classList.remove('hidden');
        switchAuthTab('register');
      });
    } else {
      demoBanner.classList.add('hidden');
      demoBanner.innerHTML = '';
    }
  }
}

// -------------------------------------------------------------
// CHARGEMENT DES DONNÉES (ANTI-ÉCRASEMENT & SÉQUENCÉ)
// -------------------------------------------------------------
async function loadHealth() {
  const badge = document.getElementById('auth-env-badge');
  try {
    const h = await apiFetch('/health', { skipAuth: true, ignoreUnauthorized: true });
    state.health = h;
    if (badge) {
      badge.innerHTML =
        h?.database === 'pglite-ephemeral'
          ? '<span>Mode Aperçu Local</span>'
          : '<span class="status-dot-ok"></span><span>Système Cloud Opérationnel</span>';
    }
  } catch {
    if (badge) {
      badge.innerHTML = '<span>Connexion Cloud en veille</span>';
    }
  }
}

function showNetworkRetryBanner(message) {
  const main = document.getElementById('main-content');
  if (!main) return;
  let banner = document.getElementById('app-network-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'app-network-banner';
    banner.className = 'card';
    banner.style.cssText =
      'background:#fef2f2;border:1px solid #fecaca;color:#991b1b;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px;';
    main.prepend(banner);
  }
  banner.innerHTML = `
    <div style="font-size:13px;font-weight:600;">
      ${esc(message)}
    </div>
    <button id="btn-retry-sync" type="button" class="btn btn-danger btn-sm">Réessayer</button>
  `;
  document.getElementById('btn-retry-sync')?.addEventListener('click', () => refreshAllData({ force: true }));
}

function clearNetworkRetryBanner() {
  document.getElementById('app-network-banner')?.remove();
}

async function refreshAllData(opts = {}) {
  if (!getToken()) return;
  const silent = Boolean(opts.silent);
  const force = Boolean(opts.force);

  // Ne jamais chevaucher un rafraîchissement silencieux si un chargement est déjà en cours
  if (silent && state.isRefreshing) return;

  const mySeq = ++state.refreshSeq;
  state.isRefreshing = true;

  const refreshBtn = document.getElementById('btn-refresh-all');
  const prevRefreshHtml = refreshBtn?.innerHTML;
  if (refreshBtn && !silent) {
    refreshBtn.disabled = true;
  }

  try {
    // 1. Charger d'abord la session active pour connaître le rôle et les permissions réels
    let meRes;
    try {
      meRes = await apiFetch('/api/auth/me');
    } catch (err) {
      if (mySeq < state.appliedRefreshSeq) return;
      state.networkError =
        err?.message || 'Connexion au serveur interrompue. Vos saisies en cours restent préservées.';
      if (!silent) showNetworkRetryBanner(state.networkError);
      return;
    }

    if (mySeq < state.appliedRefreshSeq) return;

    const me = meRes?.data;
    if (me) {
      state.user = me.user;
      state.company = me.company;
      if (me.role) state.role = me.role;
      state.isDemo = Boolean(me.isDemo);
      state.termsStatus = me.termsStatus || null;
      state.subscriptionStatus = me.subscriptionStatus || null;
    }

    // 2. N'interroger QUE les modules autorisés par le rôle de l'utilisateur
    const fetchTasks = {};
    const queue = (key, allowed, url) => {
      if (allowed) fetchTasks[key] = apiFetch(url, { ignoreUnauthorized: silent });
    };

    queue('categories', can('catalog:read'), '/api/catalog/categories');
    queue('products', can('catalog:read'), '/api/catalog/products');
    queue('recipes', can('catalog:read'), '/api/catalog/recipes');
    queue('levels', can(['inventory:read', 'reports:read']), '/api/inventory/levels');
    queue('alerts', can(['inventory:read', 'reports:read']), '/api/inventory/alerts');
    queue('invSummary', can(['inventory:read', 'reports:read']), '/api/inventory/summary');
    queue('movements', can(['inventory:read', 'reports:read']), '/api/inventory/movements?limit=50');
    queue('suppliers', can(['purchases:read', 'reports:read']), '/api/purchases/suppliers');
    queue('purchases', can(['purchases:read', 'reports:read']), '/api/purchases?limit=30');
    queue('sales', can(['pos:read', 'reports:read', 'tables:read', 'cash:read']), '/api/sales?limit=50');
    queue('cashCurrent', can(['cash:read', 'reports:read']), '/api/cash/sessions/current');
    queue('cashSessions', can(['cash:read', 'reports:read']), '/api/cash/sessions?limit=20');
    queue('expenses', can(['cash:read', 'reports:read']), '/api/cash/expenses?limit=50');
    queue('customers', can(['customers:read', 'customers:write']), '/api/customers');
    queue('subscriptionData', true, '/api/subscriptions/current');
    queue('qrTables', can(['tables:read', 'qr_orders:read']), '/api/qr/tables');
    queue('qrSettings', can(['tables:read', 'qr_orders:read']), '/api/qr/settings');
    queue('qrOptions', can(['tables:read', 'catalog:read']), '/api/qr/options');
    queue('qrOrdersData', can(['qr_orders:read', 'tables:read', 'pos:read']), '/api/qr/orders?limit=60');
    queue(
      'qrAnalytics',
      can(['reports:read', 'dashboard:read', 'qr_orders:read']),
      `/api/qr/analytics?period=${encodeURIComponent(state.qrAnalyticsPeriod || 'month')}`
    );
    queue('staffMembers', can('staff:manage'), '/api/staff');
    queue('staffPresets', can('staff:manage') && !state.staffPresets, '/api/staff/presets');
    queue(
      'staffActivity',
      can('staff:manage'),
      `/api/staff/activity?limit=80${state.staffActivityUserFilter ? `&userId=${encodeURIComponent(state.staffActivityUserFilter)}` : ''}`
    );

    const keys = Object.keys(fetchTasks);
    const settled = await Promise.allSettled(Object.values(fetchTasks));

    // Ignorer toute réponse obsolète si une mise à jour plus récente a déjà été appliquée
    if (mySeq < state.appliedRefreshSeq) return;
    state.appliedRefreshSeq = mySeq;

    state.networkError = null;
    clearNetworkRetryBanner();

    const dataMap = {};
    let rejectedCount = 0;
    keys.forEach((k, i) => {
      if (settled[i]?.status === 'fulfilled') {
        dataMap[k] = settled[i].value?.data;
      } else {
        rejectedCount++;
      }
    });

    // RÈGLE CRITIQUE ANTI-DISPARITION : ne jamais écraser un état valide par [] ou null si un appel échoue
    const merge = (key, current) => (Object.prototype.hasOwnProperty.call(dataMap, key) ? dataMap[key] : current);

    state.categories = merge('categories', state.categories);
    state.products = merge('products', state.products);
    state.recipes = merge('recipes', state.recipes);
    state.levels = merge('levels', state.levels);
    state.alerts = merge('alerts', state.alerts);
    state.invSummary = merge('invSummary', state.invSummary);
    state.movements = merge('movements', state.movements);
    state.suppliers = merge('suppliers', state.suppliers);
    state.purchases = merge('purchases', state.purchases);
    state.sales = merge('sales', state.sales);
    state.cashCurrent = merge('cashCurrent', state.cashCurrent);
    state.cashSessions = merge('cashSessions', state.cashSessions);
    state.expenses = merge('expenses', state.expenses);
    state.customers = merge('customers', state.customers);
    state.subscriptionData = merge('subscriptionData', state.subscriptionData);
    state.qrTables = merge('qrTables', state.qrTables);
    state.qrSettings = merge('qrSettings', state.qrSettings);
    state.qrOptions = merge('qrOptions', state.qrOptions);
    state.qrAnalytics = merge('qrAnalytics', state.qrAnalytics);
    state.staffMembers = merge('staffMembers', state.staffMembers);
    state.staffPresets = merge('staffPresets', state.staffPresets);
    state.staffActivity = merge('staffActivity', state.staffActivity);

    if (Object.prototype.hasOwnProperty.call(dataMap, 'qrOrdersData')) {
      const qrOrdersData = dataMap.qrOrdersData || { orders: [], serviceRequests: [] };
      const incomingOrders = qrOrdersData.orders || [];
      const incomingReqs = qrOrdersData.serviceRequests || [];

      const receivedIds = incomingOrders.filter((o) => o.status === 'received').map((o) => o.id);
      if (state.knownQrOrderIds !== null && state.qrSoundEnabled) {
        const hasBrandNew = receivedIds.some((id) => !state.knownQrOrderIds.has(id));
        if (hasBrandNew) {
          playQrNotificationSound();
          showToast('🔔 Nouvelle commande QR reçue depuis une table !', 'info');
        }
      }
      state.knownQrOrderIds = new Set(receivedIds);
      state.qrOrders = incomingOrders;
      state.qrServiceRequests = incomingReqs;

      const badgeEl = document.getElementById('qr-pending-badge');
      const pendingCount = receivedIds.length + incomingReqs.length;
      if (badgeEl) {
        badgeEl.textContent = String(pendingCount);
        badgeEl.classList.toggle('hidden', pendingCount === 0);
      }
    }

    if (can(['pos:read', 'pos:write'])) {
      if (state.activeSale) {
        try {
          const detail = await apiFetch(`/api/sales/${state.activeSale.id}`);
          if (mySeq >= state.appliedRefreshSeq) state.activeSale = detail.data;
        } catch {
          // conserver state.activeSale en cas d'erreur réseau transitoire, sauf 404
        }
      } else {
        const pending = (state.sales || []).find((s) => s.status === 'pending');
        if (pending) {
          const detail = await apiFetch(`/api/sales/${pending.id}`).catch(() => null);
          if (detail && mySeq >= state.appliedRefreshSeq) state.activeSale = detail.data;
        }
      }
    }

    if (state.activePurchase && can(['purchases:read', 'purchases:write'])) {
      try {
        const pDetail = await apiFetch(`/api/purchases/${state.activePurchase.id}`);
        if (mySeq >= state.appliedRefreshSeq) state.activePurchase = pDetail.data;
      } catch {
        // conserver
      }
    }

    if (rejectedCount > 0 && rejectedCount === keys.length && !silent) {
      showNetworkRetryBanner('Certaines données n’ont pas pu être actualisées. Vos données affichées sont préservées.');
    }

    renderChrome();

    // Ne jamais écraser un formulaire en cours de saisie lors d'une actualisation silencieuse
    const modalOpen = !document.getElementById('modal-backdrop')?.classList.contains('hidden');
    if (force || (!silent) || (!modalOpen && !isUserActivelyEditingForm())) {
      renderRoute();
    }
  } finally {
    state.isRefreshing = false;
    if (refreshBtn && !silent) {
      refreshBtn.disabled = false;
      if (prevRefreshHtml) refreshBtn.innerHTML = prevRefreshHtml;
    }
  }
}

// -------------------------------------------------------------
// RENDU DES ROUTES
// -------------------------------------------------------------
function renderRoute() {
  const root = document.getElementById('main-content');
  if (!root) return;

  if (!canAccessRoute(state.route)) {
    state.route = getPreferredRoute();
    applyRoleNavigation();
  }

  const uiHelpers = {
    cur: CURRENCY(),
    statusBadge,
    parseSaleMeta,
    serializeSaleMeta,
    openModal,
    closeModal,
    confirmActionModal,
    refreshAllData,
    renderRoute,
    setRoute,
    withFormSubmit,
    can,
  };

  switch (state.route) {
    case 'dashboard':
      root.innerHTML = renderDashboard();
      bindDashboard();
      break;
    case 'tables':
      root.innerHTML = renderTablesAndQrModule(state, uiHelpers);
      bindTablesAndQrModule(state, uiHelpers);
      break;
    case 'qr-orders':
      root.innerHTML = renderQrOrdersAndKdsModule(state, uiHelpers);
      bindQrOrdersAndKdsModule(state, uiHelpers);
      break;
    case 'pos':
      root.innerHTML = renderPos();
      bindPos();
      break;
    case 'catalog':
      root.innerHTML = renderCatalog();
      bindCatalog();
      break;
    case 'inventory':
      root.innerHTML = renderInventory();
      bindInventory();
      break;
    case 'purchases':
      root.innerHTML = renderPurchases();
      bindPurchases();
      break;
    case 'cash':
      root.innerHTML = renderCash();
      bindCash();
      break;
    case 'customers':
      root.innerHTML = renderCustomersModule(state, CURRENCY(), can('customers:write'));
      bindCustomersModule(state, uiHelpers);
      break;
    case 'staff':
      root.innerHTML = renderStaffModule(state);
      bindStaffModule(state, uiHelpers);
      break;
    case 'subscription':
      root.innerHTML = renderSubscriptionModuleV12(state, uiHelpers);
      bindSubscriptionModuleV12(state, uiHelpers);
      break;
    case 'saas-admin':
      root.innerHTML = renderSaasFinancesAdminModule(state, uiHelpers);
      bindSaasFinancesAdminModule(state, uiHelpers);
      break;
  }
}

// ---------------- 1. DASHBOARD ----------------
function renderDashboard() {
  const cur = CURRENCY();
  const completedSales = state.sales.filter((s) => s.status === 'completed');
  const pendingSales = state.sales.filter((s) => s.status === 'pending');
  const totalSalesAmount = completedSales.reduce((acc, s) => acc + parseFloat(s.total_amount || 0), 0);
  const cashBalance = state.cashCurrent ? state.cashCurrent.metrics?.theoreticalCashInDrawer : null;
  const occupiedTablesCount = FLOOR_TABLES.filter((t) =>
    pendingSales.some((s) => parseSaleMeta(s.notes).tableCode === t.code)
  ).length;

  const companyKey = state.company?.id || 'default';
  const onboardingDismissed = localStorage.getItem(`restogest_onboarding_dismissed_${companyKey}`) === '1';
  const onboardingSteps = [
    {
      done: state.products.length > 0,
      label: '1. Ajouter vos premiers produits',
      hint: 'Créez votre carte et vos prix de vente.',
      route: 'catalog',
      cta: 'Ajouter un produit',
    },
    {
      done: state.qrTables.length > 0,
      label: '2. Créer vos tables et QR codes',
      hint: 'Organisez votre salle et imprimez vos QR codes.',
      route: 'tables',
      cta: 'Créer une table',
    },
    {
      done: Boolean(state.company?.country_code && state.company?.currency),
      label: '3. Vérifier les infos de l’établissement',
      hint: 'Pays, devise (FCFA/GNF) et numéro WhatsApp du gérant.',
      route: 'subscription',
      cta: 'Vérifier mes infos',
    },
    {
      done: state.sales.length > 0 || Boolean(state.cashCurrent),
      label: '4. Effectuer une première opération de caisse',
      hint: 'Ouvrez votre caisse et enregistrez un premier ticket.',
      route: state.cashCurrent ? 'pos' : 'cash',
      cta: state.cashCurrent ? 'Ouvrir le POS' : 'Ouvrir la caisse',
    },
  ];
  const doneStepsCount = onboardingSteps.filter((s) => s.done).length;
  const showOnboarding = !onboardingDismissed && doneStepsCount < onboardingSteps.length;

  const onboardingHtml = showOnboarding
    ? `
    <div class="card" style="border-color:rgba(234,88,12,0.35);background:linear-gradient(135deg,#fff7ed 0%,#ffffff 65%);">
      <div class="section-head">
        <div>
          <h3 style="margin:0;">Configuration guidée (${doneStepsCount}/${onboardingSteps.length})</h3>
          <p class="muted-text" style="margin-top:4px;">Suivez ces étapes pour démarrer rapidement avec MyRestoGest.</p>
        </div>
        <button id="btn-dismiss-onboarding" type="button" class="btn btn-outline btn-sm">Masquer</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin-top:10px;">
        ${onboardingSteps
          .map(
            (st) => `
          <div style="padding:12px;border-radius:12px;border:1px solid ${st.done ? '#a7f3d0' : '#e2e8f0'};background:${st.done ? '#ecfdf5' : '#ffffff'};display:flex;flex-direction:column;justify-content:space-between;gap:8px;">
            <div>
              <strong style="font-size:13px;color:${st.done ? '#047857' : '#0f172a'};">${st.done ? '✓ ' : ''}${esc(st.label)}</strong>
              <p class="muted-text" style="font-size:12px;margin-top:4px;">${esc(st.hint)}</p>
            </div>
            ${
              st.done
                ? '<span class="status-pill status-open" style="align-self:flex-start;">Terminé</span>'
                : `<button type="button" class="btn btn-primary btn-sm" data-jump="${esc(st.route)}" style="align-self:flex-start;">${esc(st.cta)}</button>`
            }
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `
    : '';

  return `
    ${onboardingHtml}
    <div class="kpi-grid">
      <div class="card kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Caisse Active</span>
          <span class="kpi-icon ${cashBalance !== null ? 'is-green' : 'is-red'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/></svg>
          </span>
        </div>
        <div class="kpi-value">${cashBalance !== null ? esc(fmtMoney(cashBalance, cur)) : 'Fermée'}</div>
        <div class="kpi-foot">${state.cashCurrent ? `Fond initial : ${esc(fmtMoney(state.cashCurrent.openingAmount, cur))}` : 'Ouvrez une session pour encaisser'}</div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Chiffre d'affaires (${completedSales.length})</span>
          <span class="kpi-icon is-orange">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/></svg>
          </span>
        </div>
        <div class="kpi-value">${esc(fmtMoney(totalSalesAmount, cur))}</div>
        <div class="kpi-foot">${pendingSales.length} commande(s) ouverte(s) • ${occupiedTablesCount} table(s)</div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Valorisation Stock (PMP)</span>
          <span class="kpi-icon is-blue">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m7.5 4.27 9 5.15"/><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/></svg>
          </span>
        </div>
        <div class="kpi-value">${esc(fmtMoney(state.invSummary?.total_inventory_valuation || 0, cur))}</div>
        <div class="kpi-foot">${state.invSummary?.tracked_products_count || 0} article(s) suivis</div>
      </div>

      <div class="card kpi-card">
        <div class="kpi-top">
          <span class="kpi-label">Alertes Stock</span>
          <span class="kpi-icon ${state.alerts.length > 0 ? 'is-red' : 'is-green'}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </span>
        </div>
        <div class="kpi-value">${state.alerts.length}</div>
        <div class="kpi-foot">${state.invSummary?.out_of_stock_count || 0} rupture(s) critique(s)</div>
      </div>
    </div>

    <div class="card">
      <div class="section-head">
        <h3>Raccourcis opérationnels</h3>
      </div>
      <div class="toolbar">
        <button class="btn btn-primary" data-jump="tables" type="button">Plan de Salle (${occupiedTablesCount}/${FLOOR_TABLES.length})</button>
        <button class="btn btn-amber" data-jump="pos" type="button">Ouvrir Caisse POS</button>
        <button class="btn btn-outline" data-jump="catalog" type="button">Catalogue &amp; Recettes</button>
        <button class="btn btn-outline" data-jump="purchases" type="button">Achats &amp; Fournisseurs</button>
        <button class="btn btn-outline" data-jump="cash" type="button">${state.cashCurrent ? 'Rapport Z &amp; Clôture' : 'Ouvrir Caisse'}</button>
        <button class="btn btn-outline" data-jump="subscription" type="button">Licence (${esc(cur)})</button>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="section-head">
          <h3>Alertes de réapprovisionnement</h3>
          <button class="btn btn-outline btn-sm" data-jump="inventory" type="button">Voir tout</button>
        </div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Produit</th><th>Stock</th><th>Seuil</th><th>Niveau</th></tr></thead>
            <tbody>
              ${state.alerts.length === 0
      ? '<tr><td colspan="4" class="muted-text">Aucune alerte de stock bas. Configurez vos seuils dans « Stocks &amp; Alertes » pour être prévenu avant rupture.</td></tr>'
      : state.alerts
        .slice(0, 6)
        .map(
          (a) => `<tr>
                          <td data-label="Produit"><strong>${esc(a.product_name)}</strong></td>
                          <td data-label="Stock" class="mono">${esc(fmtQty(a.current_quantity))} ${esc(a.unit)}</td>
                          <td data-label="Seuil" class="mono">${esc(fmtQty(a.min_stock_alert))}</td>
                          <td data-label="Niveau"><span class="status-pill ${a.alert_level === 'critical_out_of_stock' ? 'status-critical' : 'status-pending'}">${a.alert_level === 'critical_out_of_stock' ? 'Rupture' : 'Stock bas'}</span></td>
                        </tr>`
        )
        .join('')
    }
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="section-head">
          <h3>Dernières commandes</h3>
          <button class="btn btn-outline btn-sm" data-jump="pos" type="button">POS</button>
        </div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Facture</th><th>Service / Table</th><th>Montant</th><th>Statut</th></tr></thead>
            <tbody>
              ${state.sales.length === 0
      ? '<tr><td colspan="4" class="muted-text">Aucune commande enregistrée. Ouvrez la caisse et créez votre premier ticket dans « Caisse &amp; POS ».</td></tr>'
      : state.sales
        .slice(0, 6)
        .map((s) => {
          const m = parseSaleMeta(s.notes);
          return `<tr>
                          <td data-label="Facture" class="mono"><strong>${esc(s.invoice_number)}</strong></td>
                          <td data-label="Service">${esc(serviceModeSummary(m))}</td>
                          <td data-label="Montant" class="mono">${esc(fmtMoney(s.total_amount, cur))}</td>
                          <td data-label="Statut">${statusBadge(s.status)}</td>
                        </tr>`;
        })
        .join('')
    }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function bindDashboard() {
  document.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => setRoute(btn.dataset.jump));
  });
  document.getElementById('btn-dismiss-onboarding')?.addEventListener('click', () => {
    const companyKey = state.company?.id || 'default';
    localStorage.setItem(`restogest_onboarding_dismissed_${companyKey}`, '1');
    renderRoute();
  });
}

// ---------------- 1B. PLAN DE SALLE VISUEL ----------------
function mapPendingSalesByTable() {
  const byTable = new Map();
  for (const s of state.sales) {
    if (s.status !== 'pending') continue;
    const meta = parseSaleMeta(s.notes);
    if (meta.tableCode && !byTable.has(meta.tableCode)) {
      byTable.set(meta.tableCode, { sale: s, meta });
    }
  }
  return byTable;
}

function renderTables() {
  const cur = CURRENCY();
  const byTable = mapPendingSalesByTable();
  const visibleTables =
    state.tableZone === 'all'
      ? FLOOR_TABLES
      : FLOOR_TABLES.filter((t) => t.zone === state.tableZone);

  let occupiedCount = 0;
  let billCount = 0;
  let roomTotal = 0;

  for (const t of FLOOR_TABLES) {
    const entry = byTable.get(t.code);
    if (entry) {
      if (entry.meta.tableState === 'bill_requested') {
        billCount += 1;
      } else {
        occupiedCount += 1;
      }
      roomTotal += parseFloat(entry.sale.total_amount || 0);
    }
  }
  const freeCount = FLOOR_TABLES.length - occupiedCount - billCount;

  return `
    <div class="kpi-grid">
      <div class="card kpi-card">
        <div class="kpi-label">Tables Libres</div>
        <div class="kpi-value" style="color:var(--success)">${freeCount}</div>
        <div class="kpi-foot">Sur ${FLOOR_TABLES.length} emplacements</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Tables Occupées</div>
        <div class="kpi-value" style="color:var(--primary)">${occupiedCount}</div>
        <div class="kpi-foot">Commandes en service</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Additions en cours</div>
        <div class="kpi-value" style="color:var(--info)">${billCount}</div>
        <div class="kpi-foot">En attente d'encaissement</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Encours Salle</div>
        <div class="kpi-value">${esc(fmtMoney(roomTotal, cur))}</div>
        <div class="kpi-foot">Total des tables ouvertes</div>
      </div>
    </div>

    <div class="card">
      <div class="section-head">
        <h3>Plan de Salle Visuel</h3>
        <div class="category-strip" style="margin:0;padding:0;">
          ${['all', 'Salle', 'Terrasse', 'Comptoir']
      .map(
        (z) =>
          `<button type="button" class="cat-chip ${state.tableZone === z ? 'active' : ''}" data-table-zone="${z}">${z === 'all' ? 'Toutes les zones' : z}</button>`
      )
      .join('')}
        </div>
      </div>

      <div class="floor-grid">
        ${visibleTables
      .map((t) => {
        const entry = byTable.get(t.code);
        const isBill = entry?.meta.tableState === 'bill_requested';
        const cardCls = !entry ? 'is-free' : isBill ? 'is-bill' : 'is-occupied';
        const statusText = !entry ? 'Libre' : isBill ? 'Addition en cours' : 'Occupée';
        const pillCls = !entry ? 'status-open' : isBill ? 'status-info' : 'status-pending';
        const amount = entry ? parseFloat(entry.sale.total_amount || 0) : 0;

        return `<div class="table-card ${cardCls}">
              <div>
                <div class="table-card-head">
                  <div>
                    <div class="table-card-title">${esc(t.name)}</div>
                    <div class="table-card-zone">${esc(t.zone)} • ${t.seats} pl.</div>
                  </div>
                  <span class="status-pill ${pillCls}">${esc(statusText)}</span>
                </div>
                ${entry
            ? `<div style="margin-top:10px;">
                        <div class="table-card-amount">${esc(fmtMoney(amount, cur))}</div>
                        <div class="muted-text mono" style="font-size:11px;">${esc(entry.sale.invoice_number)} • ${esc(entry.sale.total_items_count || 0)} art.</div>
                      </div>`
            : `<div class="muted-text" style="margin-top:12px;">Prête pour de nouveaux clients</div>`
          }
              </div>

              <div class="table-card-actions">
                ${!entry
            ? `<button type="button" class="btn btn-success btn-sm btn-full" data-open-table="${esc(t.code)}">Ouvrir la table</button>`
            : `
                      <button type="button" class="btn btn-primary btn-sm" data-pos-table-sale="${esc(entry.sale.id)}" style="flex:1;">+ Commander / Encaisser</button>
                      ${!isBill
              ? `<button type="button" class="btn btn-outline btn-sm" data-bill-table="${esc(entry.sale.id)}">Addition</button>`
              : `<button type="button" class="btn btn-whatsapp btn-sm" data-wa-sale="${esc(entry.sale.id)}">WhatsApp</button>`
            }
                    `
          }
              </div>
            </div>`;
      })
      .join('')}
      </div>
    </div>
  `;
}

function bindTables() {
  document.querySelectorAll('[data-table-zone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tableZone = btn.dataset.tableZone;
      renderRoute();
    });
  });

  document.querySelectorAll('[data-open-table]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const table = FLOOR_TABLES.find((t) => t.code === btn.dataset.openTable);
        if (!table) return;
        const notes = serializeSaleMeta({
          serviceMode: 'dine_in',
          tableCode: table.code,
          tableName: table.name,
          tableState: 'occupied',
        });
        const res = await apiFetch('/api/sales', { method: 'POST', body: { notes } });
        state.activeSale = { ...res.data, paidAmount: 0, items: [], payments: [] };
        showToast(`${table.name} ouverte — ajoutez vos articles`, 'success');
        await refreshAllData();
        setRoute('pos');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-pos-table-sale]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/sales/${btn.dataset.posTableSale}`);
        state.activeSale = res.data;
        setRoute('pos');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-bill-table]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const detail = await apiFetch(`/api/sales/${btn.dataset.billTable}`);
        const curMeta = parseSaleMeta(detail.data.notes);
        await apiFetch(`/api/sales/${btn.dataset.billTable}`, {
          method: 'PUT',
          body: { notes: serializeSaleMeta({ ...curMeta, tableState: 'bill_requested' }) },
        });
        showToast('Addition demandée pour la table', 'info');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-wa-sale]').forEach((btn) => {
    btn.addEventListener('click', () => openWhatsAppSaleModal(btn.dataset.waSale));
  });
}

// ---------------- 2. POS, LIVRAISON & WHATSAPP ----------------
function computeSaleSummary(sale) {
  const items = sale?.items || [];
  const subtotal = items.reduce((sum, it) => sum + parseFloat(it.subtotal || 0), 0);
  const discount = parseFloat(sale?.discount_amount || 0);
  const taxRate = parseFloat(state.company?.default_tax_rate || 0);
  const taxable = Math.max(0, subtotal - discount);
  const tax = Math.round(taxable * taxRate) / 100;
  const total = Math.round((taxable + tax) * 100) / 100;
  const paid = parseFloat(sale?.paidAmount || 0);
  const remaining = Math.max(0, Math.round((total - paid) * 100) / 100);
  return { subtotal, discount, taxRate, tax, total, paid, remaining };
}

function buildWhatsAppReceiptText(payload) {
  const cur = payload.currency || CURRENCY();
  const meta = parseSaleMeta(payload.notes);
  const lines = [
    `*${payload.companyName || 'MyRestoGest'}*`,
    `Facture : *${payload.invoiceNumber}*`,
    `Mode : ${serviceModeSummary(meta)}`,
  ];
  if (meta.customerName) lines.push(`Client : ${meta.customerName}`);
  if (meta.customerPhone) lines.push(`Tél : ${meta.customerPhone}`);
  if (meta.serviceMode === 'delivery') {
    if (meta.deliveryZone) lines.push(`Zone / Adresse : ${meta.deliveryZone}`);
    if (meta.courierName) lines.push(`Livreur : ${meta.courierName}`);
  }
  lines.push('-------------------------');
  for (const it of payload.items || []) {
    lines.push(`• ${fmtQty(it.quantity)}x ${it.productName} : ${fmtMoney(it.subtotal, cur)}`);
  }
  if (meta.serviceMode === 'delivery' && meta.deliveryFee > 0) {
    lines.push(`Frais livraison (info) : ${fmtMoney(meta.deliveryFee, cur)}`);
  }
  lines.push('-------------------------');
  if (payload.discount > 0) lines.push(`Remise : -${fmtMoney(payload.discount, cur)}`);
  lines.push(`*TOTAL : ${fmtMoney(payload.total, cur)}*`);
  if ((payload.payments || []).length > 0) {
    const payText = payload.payments
      .map((p) => `${methodLabel(p.payment_method || p.method, p.reference)} (${fmtMoney(p.amount, cur)})`)
      .join(', ');
    lines.push(`Règlement : ${payText}`);
  }
  lines.push('Merci pour votre confiance !');
  return lines.join('\n');
}

async function openWhatsAppSaleModal(saleId) {
  try {
    const res = await apiFetch(`/api/sales/${saleId}`);
    const s = res.data;
    const summary = computeSaleSummary(s);
    const meta = parseSaleMeta(s.notes);
    const text = buildWhatsAppReceiptText({
      companyName: state.company?.name,
      currency: CURRENCY(),
      invoiceNumber: s.invoice_number,
      notes: s.notes,
      items: (s.items || []).map((it) => ({
        productName: it.product_name,
        quantity: it.quantity,
        subtotal: it.subtotal,
      })),
      discount: summary.discount,
      total: summary.total,
      payments: s.payments || [],
    });

    const clientDigits = cleanWaDigits(meta.customerPhone || s.customer_phone);
    const clientWaUrl = clientDigits
      ? `https://wa.me/${clientDigits}?text=${encodeURIComponent(text)}`
      : `https://wa.me/?text=${encodeURIComponent(text)}`;
    const genericWaUrl = `https://wa.me/?text=${encodeURIComponent(text)}`;

    openModal(
      `Récapitulatif WhatsApp • ${s.invoice_number}`,
      `
        <div class="form-stack">
          <div class="field">
            <label>Aperçu du message client / livreur</label>
            <textarea id="wa-preview-msg" rows="11" class="mono" style="font-size:12px;">${esc(text)}</textarea>
          </div>
          <div class="toolbar">
            <a id="wa-send-client-link" href="${esc(clientWaUrl)}" target="_blank" rel="noopener" class="btn btn-whatsapp" style="text-decoration:none;flex:1;">
              ${clientDigits ? `Envoyer au Client (${esc(meta.customerPhone)})` : 'Ouvrir WhatsApp'}
            </a>
            <a href="${esc(genericWaUrl)}" target="_blank" rel="noopener" class="btn btn-outline" style="text-decoration:none;">
              Envoyer au Livreur
            </a>
            <button id="btn-copy-wa-text" type="button" class="btn btn-outline">Copier</button>
          </div>
        </div>
      `
    );

    document.getElementById('btn-copy-wa-text')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(document.getElementById('wa-preview-msg').value);
        showToast('Message copié dans le presse-papiers !', 'success');
      } catch {
        showToast('Copie manuelle requise dans votre navigateur', 'warning');
      }
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderPos() {
  const cur = CURRENCY();
  const filteredProducts = state.products.filter((p) => {
    const matchSearch =
      !state.posFilter.search ||
      p.name.toLowerCase().includes(state.posFilter.search.toLowerCase());
    const matchCat = !state.posFilter.categoryId || p.category_id === state.posFilter.categoryId;
    return matchSearch && matchCat;
  });

  const sale = state.activeSale;
  const meta = parseSaleMeta(sale?.notes);
  const summary = computeSaleSummary(sale);
  const qtyByProduct = new Map();
  for (const it of sale?.items || []) {
    qtyByProduct.set(it.product_id, (qtyByProduct.get(it.product_id) || 0) + parseFloat(it.quantity || 0));
  }
  const totalCartItems = (sale?.items || []).reduce((s, it) => s + parseFloat(it.quantity || 0), 0);

  return `
    <div class="pos-grid">
      <div class="pos-left">
        <div class="card">
          <div class="section-head">
            <h3>Carte &amp; Produits</h3>
            <input id="pos-search" class="input-inline" type="search" placeholder="Rechercher un plat, boisson..." value="${esc(state.posFilter.search)}" style="max-width:260px;" />
          </div>

          <div class="category-strip">
            <button type="button" class="cat-chip ${!state.posFilter.categoryId ? 'active' : ''}" data-pos-cat="">Tous (${state.products.length})</button>
            ${state.categories
      .map(
        (c) => `<button type="button" class="cat-chip ${state.posFilter.categoryId === c.id ? 'active' : ''}" data-pos-cat="${esc(c.id)}">${esc(c.name)}</button>`
      )
      .join('')}
          </div>

          ${filteredProducts.length === 0
      ? '<p class="muted-text">Aucun produit trouvé. Ajoutez des articles depuis Catalogue.</p>'
      : `<div class="product-grid">
                  ${filteredProducts
        .map((p) => {
          const inCartQty = qtyByProduct.get(p.id) || 0;
          const tileCls =
            p.inventory_tracking === 'recipe_on_sale'
              ? 'is-recipe'
              : p.inventory_tracking === 'none'
                ? 'is-service'
                : '';
          const stockText =
            p.inventory_tracking === 'none'
              ? 'Service'
              : p.inventory_tracking === 'recipe_on_sale'
                ? 'Recette'
                : `${fmtQty(p.current_stock)} ${p.unit}`;
          return `<button class="product-tile ${tileCls}" type="button" data-pos-add="${esc(p.id)}">
                        ${inCartQty > 0 ? `<span class="product-tile-badge">${esc(fmtQty(inCartQty))}</span>` : ''}
                        <span class="product-tile-name">${esc(p.name)}</span>
                        <div>
                          <div class="product-tile-price">${esc(fmtMoney(p.selling_price, cur))}</div>
                          <div class="product-tile-meta">
                            <span>${esc(p.category_name || 'Carte')}</span>
                            <span>${esc(stockText)}</span>
                          </div>
                        </div>
                      </button>`;
        })
        .join('')}
                </div>`
    }
        </div>

        ${sale && totalCartItems > 0
      ? `<div class="mobile-pos-jump">
                <button id="btn-mobile-jump-ticket" type="button" class="btn btn-primary btn-full" style="box-shadow: var(--shadow-md);">
                  Voir ticket (${esc(fmtQty(totalCartItems))} art.) • ${esc(fmtMoney(summary.total, cur))}
                </button>
              </div>`
      : ''
    }

        <div class="card">
          <div class="section-head">
            <h3>Commandes récentes</h3>
            <button id="btn-new-sale" type="button" class="btn btn-outline btn-sm">+ Nouveau ticket</button>
          </div>
          <div class="table-wrap">
            <table class="responsive-table">
              <thead><tr><th>Facture</th><th>Service</th><th>Total</th><th>Statut</th><th>Actions</th></tr></thead>
              <tbody>
                ${state.sales.length === 0
      ? '<tr><td colspan="5" class="muted-text">Aucune commande enregistrée.</td></tr>'
      : state.sales
        .slice(0, 15)
        .map((s) => {
          const sMeta = parseSaleMeta(s.notes);
          return `<tr>
                            <td data-label="Facture" class="mono"><strong>${esc(s.invoice_number)}</strong></td>
                            <td data-label="Service">${esc(serviceModeSummary(sMeta))}</td>
                            <td data-label="Total" class="mono">${esc(fmtMoney(s.total_amount, cur))}</td>
                            <td data-label="Statut">${statusBadge(s.status)}</td>
                            <td data-label="Actions">
                              <div class="toolbar" style="justify-content:flex-end;">
                                <button class="btn btn-outline btn-sm" data-select-sale="${esc(s.id)}" type="button">Ouvrir</button>
                                <button class="btn btn-whatsapp btn-sm" data-wa-sale="${esc(s.id)}" type="button">WhatsApp</button>
                                ${s.status === 'completed'
              ? `<button class="btn btn-outline btn-sm" data-receipt-sale="${esc(s.id)}" type="button">Ticket</button>`
              : ''
            }
                                ${s.status !== 'cancelled'
              ? `<button class="btn btn-danger btn-sm" data-cancel-sale="${esc(s.id)}" type="button">Annuler</button>`
              : ''
            }
                              </div>
                            </td>
                          </tr>`;
        })
        .join('')
    }
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div id="pos-ticket-card" class="card ticket-panel">
        <div class="section-head" style="margin-bottom:0;">
          <div>
            <h3>${sale ? `Ticket ${esc(sale.invoice_number)}` : 'Ticket POS'}</h3>
            <span class="muted-text">${sale ? `${statusBadge(sale.status)} • ${esc(serviceModeSummary(meta))}` : 'Touchez un article'}</span>
          </div>
          <div class="toolbar">
            ${sale
      ? `<button class="btn btn-whatsapp btn-sm" data-wa-sale="${esc(sale.id)}" type="button">WhatsApp</button>`
      : ''
    }
            ${sale && sale.status === 'completed'
      ? `<button class="btn btn-outline btn-sm" data-receipt-sale="${esc(sale.id)}" type="button">Reçu</button>`
      : ''
    }
          </div>
        </div>

        ${!state.cashCurrent
      ? `<div class="alert-callout">
                <span>Caisse fermée : requise pour espèces.</span>
                <button id="btn-pos-open-cash" type="button" class="btn btn-amber btn-sm">Ouvrir</button>
              </div>`
      : ''
    }

        ${!sale
      ? '<p class="muted-text">Touchez un produit sur la carte ou ouvrez une table depuis le Plan de Salle.</p>'
      : `
              ${sale.status === 'pending'
        ? `<div class="delivery-box">
                      <div class="service-mode-pills">
                        <button type="button" class="service-pill ${meta.serviceMode === 'dine_in' ? 'active' : ''}" data-service-mode="dine_in">Sur place</button>
                        <button type="button" class="service-pill ${meta.serviceMode === 'takeaway' ? 'active' : ''}" data-service-mode="takeaway">À emporter</button>
                        <button type="button" class="service-pill ${meta.serviceMode === 'delivery' ? 'active' : ''}" data-service-mode="delivery">Livraison</button>
                      </div>

                      ${meta.serviceMode === 'dine_in'
          ? `<div class="field-row">
                              <div class="field">
                                <label>Table attribuée</label>
                                <select id="pos-table-select">
                                  <option value="">Comptoir / Libre</option>
                                  ${FLOOR_TABLES.map(
            (t) =>
              `<option value="${esc(t.code)}" ${meta.tableCode === t.code ? 'selected' : ''}>${esc(t.name)} (${esc(t.zone)})</option>`
          ).join('')}
                                </select>
                              </div>
                              <div class="field">
                                <label>Statut table</label>
                                <select id="pos-table-state">
                                  <option value="occupied" ${meta.tableState !== 'bill_requested' ? 'selected' : ''}>Occupée</option>
                                  <option value="bill_requested" ${meta.tableState === 'bill_requested' ? 'selected' : ''}>Addition en cours</option>
                                </select>
                              </div>
                            </div>`
          : `<form id="pos-delivery-form" class="form-stack" style="gap:8px;">
                              <div class="field-row">
                                <div class="field">
                                  <label>Client</label>
                                  <input id="deliv-name" class="input-inline" placeholder="Nom client" value="${esc(meta.customerName)}" />
                                </div>
                                <div class="field">
                                  <label>Tél WhatsApp (+221 / +224)</label>
                                  <input id="deliv-phone" class="input-inline" placeholder="+221 77 000 00 00" value="${esc(meta.customerPhone)}" />
                                </div>
                              </div>
                              ${meta.serviceMode === 'delivery'
            ? `<div class="field-row">
                                      <div class="field">
                                        <label>Zone / Quartier</label>
                                        <input id="deliv-zone" class="input-inline" placeholder="Ex: Almadies / Kaloum" value="${esc(meta.deliveryZone)}" />
                                      </div>
                                      <div class="field">
                                        <label>Frais livraison (${esc(cur)})</label>
                                        <input id="deliv-fee" class="input-inline" type="number" min="0" step="100" value="${esc(meta.deliveryFee || 0)}" />
                                      </div>
                                    </div>
                                    <div class="field">
                                      <label>Livreur assigné</label>
                                      <input id="deliv-courier" class="input-inline" placeholder="Ex: Moussa (Moto 2)" value="${esc(meta.courierName)}" />
                                    </div>`
            : ''
          }
                              <div class="toolbar">
                                <button type="submit" class="btn btn-outline btn-sm">Enregistrer infos</button>
                                ${meta.serviceMode === 'delivery'
            ? `<button id="btn-add-deliv-fee" type="button" class="btn btn-amber btn-sm">+ Ajouter frais au ticket</button>`
            : ''
          }
                              </div>
                            </form>`
        }
                    </div>`
        : ''
      }

              <div>
                ${(sale.items || []).length === 0
        ? '<p class="muted-text">Ticket vide — touchez un produit pour l\'ajouter.</p>'
        : sale.items
          .map(
            (it) => `<div class="ticket-item">
                            <div class="ticket-item-info">
                              <div class="ticket-item-name">${esc(it.product_name)}</div>
                              <div class="muted-text mono">${esc(fmtMoney(it.unit_price, cur))} / ${esc(it.unit)}</div>
                            </div>
                            <div class="toolbar">
                              ${sale.status === 'pending'
                ? `<div class="qty-stepper">
                                      <button type="button" class="qty-btn" data-step-item="${esc(it.id)}" data-prod="${esc(it.product_id)}" data-qty="${esc(it.quantity)}" data-price="${esc(it.unit_price)}" data-delta="-1">−</button>
                                      <span class="qty-val">${esc(fmtQty(it.quantity))}</span>
                                      <button type="button" class="qty-btn" data-step-item="${esc(it.id)}" data-prod="${esc(it.product_id)}" data-qty="${esc(it.quantity)}" data-price="${esc(it.unit_price)}" data-delta="1">+</button>
                                    </div>`
                : `<span class="mono">x${esc(fmtQty(it.quantity))}</span>`
              }
                              <span class="mono" style="min-width:74px;text-align:right;"><strong>${esc(fmtMoney(it.subtotal, cur))}</strong></span>
                              ${sale.status === 'pending'
                ? `<button class="btn btn-danger btn-sm" data-del-sale-item="${esc(it.id)}" type="button" aria-label="Retirer">&times;</button>`
                : ''
              }
                            </div>
                          </div>`
          )
          .join('')
      }
              </div>

              ${sale.status === 'pending'
        ? `<form id="sale-discount-form" class="toolbar">
                      <input id="sale-discount-input" class="input-inline" type="number" step="0.01" min="0" value="${esc(summary.discount)}" placeholder="Remise" style="flex:1;" />
                      <button type="submit" class="btn btn-outline">Appliquer remise</button>
                    </form>`
        : ''
      }

              <div class="summary-lines">
                <div class="summary-line"><span>Sous-total</span><span class="mono">${esc(fmtMoney(summary.subtotal, cur))}</span></div>
                <div class="summary-line"><span>Remise</span><span class="mono">- ${esc(fmtMoney(summary.discount, cur))}</span></div>
                <div class="summary-line"><span>TVA (${summary.taxRate}%)</span><span class="mono">${esc(fmtMoney(summary.tax, cur))}</span></div>
                <div class="summary-line summary-total"><span>Total à payer</span><span class="mono">${esc(fmtMoney(summary.total, cur))}</span></div>
                <div class="summary-line"><span>Encaissé</span><span class="mono" style="color:var(--success)">${esc(fmtMoney(summary.paid, cur))}</span></div>
                <div class="summary-line"><span>Reste dû</span><span class="mono" style="color:var(--primary)"><strong>${esc(fmtMoney(summary.remaining, cur))}</strong></span></div>
              </div>

              ${(sale.payments || []).length > 0
        ? `<div class="muted-text" style="font-size:12px;">
                      <strong>Règlements :</strong>
                      ${sale.payments
          .map((p) => `<div>• ${esc(methodLabel(p.payment_method, p.reference))} : <span class="mono">${esc(fmtMoney(p.amount, cur))}</span></div>`)
          .join('')}
                    </div>`
        : ''
      }

              ${sale.status === 'pending'
        ? `<form id="sale-payment-form" class="form-stack">
                      <div class="field">
                        <label>Mode de règlement (Sénégal / Guinée)</label>
                        <div class="method-pills">
                          ${PAYMENT_CHANNELS.map(
          (ch) =>
            `<button type="button" class="method-pill ${state.payChannel === ch.id ? 'active' : ''}" data-pay-channel="${ch.id}">${esc(ch.label)}</button>`
        ).join('')}
                        </div>
                      </div>
                      <div class="field">
                        <label>Montant encaissé (${esc(cur)})</label>
                        <input id="pay-amount" type="number" step="0.01" min="0.01" required value="${summary.remaining > 0 ? summary.remaining : ''}" />
                      </div>
                      <div class="field-row">
                        <button type="submit" class="btn btn-amber">Encaisser paiement</button>
                        <button id="btn-complete-sale" type="button" class="btn btn-success" ${(sale.items || []).length === 0 ? 'disabled' : ''}>
                          Finaliser &amp; Déstocker
                        </button>
                      </div>
                    </form>`
        : `<button type="button" class="btn btn-whatsapp btn-full" data-wa-sale="${esc(sale.id)}">
                      Générer Récap WhatsApp
                    </button>`
      }
            `
    }
      </div>
    </div>
  `;
}

async function openQuickReceipt(saleId) {
  try {
    const res = await apiFetch(`/api/sales/${saleId}/receipt`);
    const r = res.data;
    const cur = r.company.currency || CURRENCY();
    const meta = parseSaleMeta(r.receiptHeader.notes);

    openModal(
      `Ticket de caisse • ${r.receiptHeader.invoiceNumber}`,
      `
        <div class="receipt-paper">
          <div style="text-align:center;margin-bottom:12px;">
            <strong style="font-size:15px;">${esc(r.company.name)}</strong><br/>
            <span>Facture : ${esc(r.receiptHeader.invoiceNumber)}</span><br/>
            <span>Mode : ${esc(serviceModeSummary(meta))}</span><br/>
            <span>Date : ${esc(fmtDate(r.receiptHeader.date))}</span><br/>
            <span>Serveur : ${esc(r.receiptHeader.serverName || 'Équipe')}</span>
          </div>
          <hr/>
          ${r.items
        .map(
          (it) => `<div style="display:flex;justify-content:space-between;margin:4px 0;">
                <span>${esc(fmtQty(it.quantity))}x ${esc(it.productName)}</span>
                <span>${esc(fmtMoney(it.subtotal, cur))}</span>
              </div>`
        )
        .join('')}
          <hr/>
          <div style="display:flex;justify-content:space-between;"><span>Sous-total</span><span>${esc(fmtMoney(r.totals.subtotal, cur))}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>Remise</span><span>-${esc(fmtMoney(r.totals.discountAmount, cur))}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>TVA (${esc(r.company.taxRate)}%)</span><span>${esc(fmtMoney(r.totals.taxAmount, cur))}</span></div>
          <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px;margin-top:6px;"><span>TOTAL</span><span>${esc(fmtMoney(r.totals.totalAmount, cur))}</span></div>
          <hr/>
          <div><strong>Règlements :</strong></div>
          ${r.payments
        .map(
          (p) => `<div style="display:flex;justify-content:space-between;">
                <span>${esc(methodLabel(p.method, p.reference))}</span>
                <span>${esc(fmtMoney(p.amount, cur))}</span>
              </div>`
        )
        .join('')}
        </div>
        <div class="toolbar" style="margin-top:14px;justify-content:flex-end;">
          <button id="btn-receipt-whatsapp" type="button" class="btn btn-whatsapp">Générer Récap WhatsApp</button>
          <button type="button" class="btn btn-primary" onclick="window.print()">Imprimer</button>
        </div>
      `
    );

    document.getElementById('btn-receipt-whatsapp')?.addEventListener('click', () => {
      openWhatsAppSaleModal(saleId);
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function ensureDeliveryFeeProduct() {
  let prod = state.products.find((p) => p.name.toLowerCase() === 'frais de livraison');
  if (!prod) {
    const created = await apiFetch('/api/catalog/products', {
      method: 'POST',
      body: {
        name: 'Frais de Livraison',
        productType: 'service',
        inventoryTracking: 'none',
        unit: 'course',
        sellingPrice: 1500,
        costPrice: 0,
        minStockAlert: 0,
      },
    });
    prod = created.data;
  }
  return prod;
}

function bindPos() {
  document.getElementById('pos-search')?.addEventListener('input', (e) => {
    state.posFilter.search = e.target.value;
    renderRoute();
    const el = document.getElementById('pos-search');
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });

  document.querySelectorAll('[data-pos-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.posFilter.categoryId = btn.dataset.posCat;
      renderRoute();
    });
  });

  document.getElementById('btn-mobile-jump-ticket')?.addEventListener('click', () => {
    document.getElementById('pos-ticket-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.getElementById('btn-pos-open-cash')?.addEventListener('click', () => setRoute('cash'));

  document.getElementById('btn-new-sale')?.addEventListener('click', async () => {
    try {
      const res = await apiFetch('/api/sales', { method: 'POST', body: {} });
      state.activeSale = { ...res.data, paidAmount: 0, items: [], payments: [] };
      showToast(`Ticket ${res.data.invoice_number} créé`, 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-service-mode]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.activeSale) return;
      try {
        const curMeta = parseSaleMeta(state.activeSale.notes);
        const nextMode = btn.dataset.serviceMode;
        const nextMeta = {
          ...curMeta,
          serviceMode: nextMode,
          ...(nextMode !== 'dine_in' ? { tableCode: '', tableName: '' } : {}),
        };
        await apiFetch(`/api/sales/${state.activeSale.id}`, {
          method: 'PUT',
          body: { notes: serializeSaleMeta(nextMeta) },
        });
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  const saveTableSelection = async () => {
    if (!state.activeSale) return;
    try {
      const code = document.getElementById('pos-table-select')?.value || '';
      const tState = document.getElementById('pos-table-state')?.value || 'occupied';
      const table = FLOOR_TABLES.find((t) => t.code === code);
      const curMeta = parseSaleMeta(state.activeSale.notes);
      await apiFetch(`/api/sales/${state.activeSale.id}`, {
        method: 'PUT',
        body: {
          notes: serializeSaleMeta({
            ...curMeta,
            serviceMode: 'dine_in',
            tableCode: code,
            tableName: table ? table.name : '',
            tableState: tState,
          }),
        },
      });
      showToast(table ? `Commande liée à ${table.name}` : 'Table mise à jour', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  };

  document.getElementById('pos-table-select')?.addEventListener('change', saveTableSelection);
  document.getElementById('pos-table-state')?.addEventListener('change', saveTableSelection);

  document.getElementById('pos-delivery-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.activeSale) return;
    try {
      const curMeta = parseSaleMeta(state.activeSale.notes);
      const nextMeta = {
        ...curMeta,
        customerName: document.getElementById('deliv-name')?.value || '',
        customerPhone: document.getElementById('deliv-phone')?.value || '',
        deliveryZone: document.getElementById('deliv-zone')?.value || '',
        deliveryFee: parseFloat(document.getElementById('deliv-fee')?.value || '0') || 0,
        courierName: document.getElementById('deliv-courier')?.value || '',
      };
      await apiFetch(`/api/sales/${state.activeSale.id}`, {
        method: 'PUT',
        body: { notes: serializeSaleMeta(nextMeta) },
      });
      showToast('Informations client / livraison enregistrées', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-add-deliv-fee')?.addEventListener('click', async () => {
    if (!state.activeSale) return;
    try {
      const fee = parseFloat(document.getElementById('deliv-fee')?.value || '0');
      if (!fee || fee <= 0) {
        showToast('Saisissez des frais de livraison supérieurs à 0', 'warning');
        return;
      }
      const curMeta = parseSaleMeta(state.activeSale.notes);
      await apiFetch(`/api/sales/${state.activeSale.id}`, {
        method: 'PUT',
        body: {
          notes: serializeSaleMeta({
            ...curMeta,
            customerName: document.getElementById('deliv-name')?.value || curMeta.customerName,
            customerPhone: document.getElementById('deliv-phone')?.value || curMeta.customerPhone,
            deliveryZone: document.getElementById('deliv-zone')?.value || curMeta.deliveryZone,
            deliveryFee: fee,
            courierName: document.getElementById('deliv-courier')?.value || curMeta.courierName,
          }),
        },
      });
      const feeProd = await ensureDeliveryFeeProduct();
      await apiFetch(`/api/sales/${state.activeSale.id}/items`, {
        method: 'POST',
        body: { productId: feeProd.id, quantity: 1, unitPrice: fee },
      });
      showToast(`Frais de livraison (${fmtMoney(fee, CURRENCY())}) ajoutés au ticket`, 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-pos-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        if (!state.activeSale || state.activeSale.status !== 'pending') {
          const created = await apiFetch('/api/sales', { method: 'POST', body: {} });
          state.activeSale = { ...created.data, items: [], payments: [], paidAmount: 0 };
        }
        const prodId = btn.dataset.posAdd;
        const existing = (state.activeSale.items || []).find((it) => it.product_id === prodId);
        if (existing) {
          const nextQty = Math.round((parseFloat(existing.quantity) + 1) * 1000) / 1000;
          await apiFetch(`/api/sales/${state.activeSale.id}/items/${existing.id}`, { method: 'DELETE' });
          await apiFetch(`/api/sales/${state.activeSale.id}/items`, {
            method: 'POST',
            body: { productId: prodId, quantity: nextQty, unitPrice: parseFloat(existing.unit_price) },
          });
        } else {
          await apiFetch(`/api/sales/${state.activeSale.id}/items`, {
            method: 'POST',
            body: { productId: prodId, quantity: 1 },
          });
        }
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-step-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const itemId = btn.dataset.stepItem;
        const prodId = btn.dataset.prod;
        const curQty = parseFloat(btn.dataset.qty);
        const unitPrice = parseFloat(btn.dataset.price);
        const delta = parseFloat(btn.dataset.delta);
        const nextQty = Math.round((curQty + delta) * 1000) / 1000;

        await apiFetch(`/api/sales/${state.activeSale.id}/items/${itemId}`, { method: 'DELETE' });
        if (nextQty > 0) {
          await apiFetch(`/api/sales/${state.activeSale.id}/items`, {
            method: 'POST',
            body: { productId: prodId, quantity: nextQty, unitPrice },
          });
        }
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-select-sale]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/sales/${btn.dataset.selectSale}`);
        state.activeSale = res.data;
        renderRoute();
        document.getElementById('pos-ticket-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-del-sale-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/sales/${state.activeSale.id}/items/${btn.dataset.delSaleItem}`, {
          method: 'DELETE',
        });
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-pay-channel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.payChannel = btn.dataset.payChannel;
      document.querySelectorAll('[data-pay-channel]').forEach((b) => {
        b.classList.toggle('active', b.dataset.payChannel === state.payChannel);
      });
    });
  });

  document.getElementById('sale-discount-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const discountAmount = parseFloat(document.getElementById('sale-discount-input').value || '0');
      await apiFetch(`/api/sales/${state.activeSale.id}`, {
        method: 'PUT',
        body: { discountAmount },
      });
      showToast('Remise appliquée', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('sale-payment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const amount = parseFloat(document.getElementById('pay-amount').value);
      const ch = PAYMENT_CHANNELS.find((c) => c.id === state.payChannel) || PAYMENT_CHANNELS[0];
      await apiFetch(`/api/sales/${state.activeSale.id}/payments`, {
        method: 'POST',
        body: { amount, paymentMethod: ch.apiMethod, reference: ch.ref },
      });
      showToast(`Paiement ${ch.label} enregistré`, 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-complete-sale')?.addEventListener('click', async () => {
    try {
      const saleId = state.activeSale.id;
      await apiFetch(`/api/sales/${saleId}/complete`, { method: 'POST' });
      showToast('Vente finalisée et stock mis à jour !', 'success');
      await refreshAllData();
      await openQuickReceipt(saleId);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-receipt-sale]').forEach((btn) => {
    btn.addEventListener('click', () => openQuickReceipt(btn.dataset.receiptSale));
  });

  document.querySelectorAll('[data-wa-sale]').forEach((btn) => {
    btn.addEventListener('click', () => openWhatsAppSaleModal(btn.dataset.waSale));
  });

  document.querySelectorAll('[data-cancel-sale]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const saleId = btn.dataset.cancelSale;
      openModal(
        'Annuler une vente',
        `<form id="modal-cancel-sale-form" class="form-stack">
          <div class="field">
            <label>Motif d'annulation (3 caractères min.)</label>
            <input id="cancel-sale-reason" required minlength="3" placeholder="Ex: Erreur de saisie client" />
          </div>
          <button type="submit" class="btn btn-danger">Confirmer l'annulation</button>
        </form>`
      );
      document.getElementById('modal-cancel-sale-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const reason = document.getElementById('cancel-sale-reason').value;
          await apiFetch(`/api/sales/${saleId}/cancel`, {
            method: 'POST',
            body: { reason },
          });
          closeModal();
          showToast('Vente annulée', 'success');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  });
}

// ---------------- 3. CATALOGUE & RECETTES ----------------
function renderCatalog() {
  const cur = CURRENCY();
  const sub = state.subtabs.catalog;
  const canWrite = can('catalog:write');

  return `
    <div class="subtabs">
      <button class="subtab ${sub === 'products' ? 'active' : ''}" data-cat-tab="products" type="button">Produits (${state.products.length})</button>
      <button class="subtab ${sub === 'categories' ? 'active' : ''}" data-cat-tab="categories" type="button">Catégories (${state.categories.length})</button>
      <button class="subtab ${sub === 'recipes' ? 'active' : ''}" data-cat-tab="recipes" type="button">Recettes (${state.recipes.length})</button>
    </div>

    ${sub === 'products'
      ? `<div class="${canWrite ? 'two-col' : ''}">
            ${canWrite ? `<div class="card">
              <div class="section-head"><h3>Nouveau produit</h3></div>
              <form id="product-create-form" class="form-stack">
                <div class="field-row">
                  <div class="field">
                    <label>Nom du produit</label>
                    <input id="prod-name" required placeholder="Ex: Tarte au citron" />
                  </div>
                  <div class="field">
                    <label>Catégorie</label>
                    <select id="prod-cat">
                      <option value="">Sans catégorie</option>
                      ${state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}
                    </select>
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Type</label>
                    <select id="prod-type">
                      <option value="finished_good">Produit fini (vente)</option>
                      <option value="raw_material">Matière première</option>
                      <option value="semi_finished">Préparation intermédiaire</option>
                      <option value="service">Service</option>
                    </select>
                  </div>
                  <div class="field">
                    <label>Mode de suivi stock</label>
                    <select id="prod-tracking">
                      <option value="direct">Direct (stock produit)</option>
                      <option value="recipe_on_sale">Recette à la vente</option>
                      <option value="none">Sans suivi stock</option>
                    </select>
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Prix de vente (${esc(cur)})</label>
                    <input id="prod-sell" type="number" step="0.01" min="0" value="0" />
                  </div>
                  <div class="field">
                    <label>Coût unitaire initial (${esc(cur)})</label>
                    <input id="prod-cost" type="number" step="0.01" min="0" value="0" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Unité</label>
                    <input id="prod-unit" value="unit" placeholder="kg, L, part..." />
                  </div>
                  <div class="field">
                    <label>Seuil alerte stock</label>
                    <input id="prod-alert" type="number" step="0.01" min="0" value="5" />
                  </div>
                </div>
                <button type="submit" class="btn btn-primary">Créer le produit</button>
              </form>
            </div>` : ''}

            <div class="card">
              <div class="section-head"><h3>Catalogue produits</h3></div>
              <div class="table-wrap">
                <table class="responsive-table">
                  <thead><tr><th>Nom</th><th>Suivi</th><th>Prix Vente</th><th>PMP</th><th>Stock</th>${canWrite ? '<th></th>' : ''}</tr></thead>
                  <tbody>
                    ${state.products.length === 0
        ? `<tr><td colspan="${canWrite ? 6 : 5}" class="muted-text">Aucun produit enregistré.</td></tr>`
        : state.products
          .map(
            (p) => `<tr>
                                <td data-label="Produit"><strong>${esc(p.name)}</strong><div class="muted-text" style="font-size:11px;">${esc(p.category_name || '—')}</div></td>
                                <td data-label="Suivi"><span class="status-pill status-neutral">${esc(p.inventory_tracking)}</span></td>
                                <td data-label="Prix Vente" class="mono">${esc(fmtMoney(p.selling_price, cur))}</td>
                                <td data-label="PMP" class="mono">${esc(fmtMoney(p.cost_price, cur))}</td>
                                <td data-label="Stock" class="mono">${p.inventory_tracking === 'none' ? '—' : esc(fmtQty(p.current_stock) + ' ' + p.unit)}</td>
                                ${canWrite ? `<td data-label="Action" style="display:flex;gap:6px;flex-wrap:wrap;"><button type="button" class="btn btn-outline btn-sm" data-edit-product="${esc(p.id)}">Modifier</button><button type="button" class="btn btn-outline btn-sm" data-delete-product="${esc(p.id)}" data-product-name="${esc(p.name)}">Supprimer</button></td>` : ''}
                              </tr>`
          )
          .join('')
      }
                  </tbody>
                </table>
              </div>
            </div>
          </div>`
      : ''
    }

    ${sub === 'categories'
      ? `<div class="two-col">
            <div class="card">
              <div class="section-head"><h3>Nouvelle catégorie</h3></div>
              <form id="category-create-form" class="form-stack">
                <div class="field">
                  <label>Nom</label>
                  <input id="cat-name" required placeholder="Boissons chaudes" />
                </div>
                <div class="field">
                  <label>Description</label>
                  <input id="cat-desc" placeholder="Optionnel" />
                </div>
                <button type="submit" class="btn btn-primary">Créer la catégorie</button>
              </form>
            </div>
            <div class="card">
              <div class="section-head"><h3>Catégories enregistrées</h3></div>
              <div class="table-wrap">
                <table class="responsive-table">
                  <thead><tr><th>Nom</th><th>Description</th></tr></thead>
                  <tbody>
                    ${state.categories.length === 0
        ? '<tr><td colspan="2" class="muted-text">Aucune catégorie.</td></tr>'
        : state.categories
          .map((c) => `<tr><td data-label="Nom"><strong>${esc(c.name)}</strong></td><td data-label="Description">${esc(c.description || '—')}</td></tr>`)
          .join('')
      }
                  </tbody>
                </table>
              </div>
            </div>
          </div>`
      : ''
    }

    ${sub === 'recipes'
      ? `<div class="two-col">
            <div class="card">
              <div class="section-head"><h3>Nouvelle fiche recette</h3></div>
              <form id="recipe-create-form" class="form-stack">
                <div class="field">
                  <label>Produit fini</label>
                  <select id="rec-finished" required>
                    <option value="">Choisir un produit...</option>
                    ${state.products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.inventory_tracking)})</option>`).join('')}
                  </select>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Nom de la fiche</label>
                    <input id="rec-name" required placeholder="Recette standard" />
                  </div>
                  <div class="field">
                    <label>Quantité produite</label>
                    <input id="rec-output" type="number" step="0.001" min="0.001" value="1" />
                  </div>
                </div>
                <div class="field">
                  <label>Ingrédients</label>
                  <div id="recipe-ing-rows" class="form-stack"></div>
                  <button id="btn-add-ing-row" type="button" class="btn btn-outline btn-sm" style="align-self:flex-start;margin-top:6px;">+ Ajouter un ingrédient</button>
                </div>
                <button type="submit" class="btn btn-primary">Enregistrer la recette</button>
              </form>
            </div>

            <div class="card">
              <div class="section-head"><h3>Fiches techniques actives</h3></div>
              ${state.recipes.length === 0
        ? '<p class="muted-text">Aucune fiche technique enregistrée.</p>'
        : state.recipes
          .map(
            (r) => `<div style="padding:12px 0;border-bottom:1px solid var(--border);">
                          <strong>${esc(r.product_name)}</strong> — <span class="muted-text">${esc(r.recipe_name)} (pour ${esc(fmtQty(r.output_quantity))})</span>
                          <ul style="margin:6px 0 0;padding-left:18px;font-size:12px;color:var(--text-secondary);">
                            ${(r.ingredients || [])
                .map((ing) => `<li>${esc(ing.ingredientName)} : <span class="mono">${esc(fmtQty(ing.quantityRequired))} ${esc(ing.unit)}</span></li>`)
                .join('')}
                          </ul>
                        </div>`
          )
          .join('')
      }
            </div>
          </div>`
      : ''
    }
  `;
}

function addRecipeIngredientRow() {
  const container = document.getElementById('recipe-ing-rows');
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'field-row recipe-ing-row';
  row.innerHTML = `
    <select class="ing-select input-inline" required>
      <option value="">Ingrédient...</option>
      ${state.products.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.unit)})</option>`).join('')}
    </select>
    <div style="display:flex;gap:6px;">
      <input class="ing-qty input-inline" type="number" step="0.0001" min="0.0001" required placeholder="Qté requise" />
      <button type="button" class="btn btn-danger btn-sm btn-rem-ing">&times;</button>
    </div>
  `;
  row.querySelector('.btn-rem-ing').addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function bindCatalog() {
  document.querySelectorAll('[data-cat-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtabs.catalog = btn.dataset.catTab;
      renderRoute();
    });
  });

  document.getElementById('category-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/catalog/categories', {
        method: 'POST',
        body: {
          name: document.getElementById('cat-name').value,
          description: document.getElementById('cat-desc').value || undefined,
        },
      });
      showToast('Catégorie créée', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const prodForm = document.getElementById('product-create-form');
  prodForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await withFormSubmit(prodForm, async () => {
      const catId = document.getElementById('prod-cat').value;
      const res = await apiFetch('/api/catalog/products', {
        method: 'POST',
        body: {
          categoryId: catId || undefined,
          name: document.getElementById('prod-name').value.trim(),
          productType: document.getElementById('prod-type').value,
          inventoryTracking: document.getElementById('prod-tracking').value,
          sellingPrice: parseFloat(document.getElementById('prod-sell').value || '0'),
          costPrice: parseFloat(document.getElementById('prod-cost').value || '0'),
          unit: document.getElementById('prod-unit').value || 'unit',
          minStockAlert: parseFloat(document.getElementById('prod-alert').value || '0'),
        },
      });
      if (res?.data) state.products = [...state.products, res.data];
      showToast('Produit ajouté au catalogue', 'success');
      await refreshAllData({ force: true });
    });
  });

  document.querySelectorAll('[data-edit-product]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prod = state.products.find((p) => p.id === btn.dataset.editProduct);
      if (!prod) return;
      const cur = CURRENCY();
      openModal(
        `Modifier ${prod.name}`,
        `
          <form id="product-edit-form" class="form-stack">
            <div class="field-row">
              <div class="field">
                <label for="pe-name">Nom du produit</label>
                <input id="pe-name" required value="${esc(prod.name)}" />
              </div>
              <div class="field">
                <label for="pe-cat">Catégorie</label>
                <select id="pe-cat">
                  <option value="">Sans catégorie</option>
                  ${state.categories.map((c) => `<option value="${esc(c.id)}" ${prod.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="pe-sell">Prix de vente (${esc(cur)})</label>
                <input id="pe-sell" type="number" step="0.01" min="0" value="${Number(prod.selling_price || 0)}" required />
              </div>
              <div class="field">
                <label for="pe-cost">Coût / PMP (${esc(cur)})</label>
                <input id="pe-cost" type="number" step="0.01" min="0" value="${Number(prod.cost_price || 0)}" required />
              </div>
            </div>
            <div class="field-row">
              <div class="field">
                <label for="pe-unit">Unité</label>
                <input id="pe-unit" value="${esc(prod.unit || 'unit')}" required />
              </div>
              <div class="field">
                <label for="pe-alert">Seuil d'alerte stock</label>
                <input id="pe-alert" type="number" step="0.01" min="0" value="${Number(prod.min_stock_alert || 0)}" required />
              </div>
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button type="button" id="btn-pe-cancel" class="btn btn-outline">Annuler</button>
              <button type="submit" class="btn btn-primary">Enregistrer</button>
            </div>
          </form>
        `
      );
      document.getElementById('btn-pe-cancel')?.addEventListener('click', closeModal);
      const editForm = document.getElementById('product-edit-form');
      editForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await withFormSubmit(editForm, async () => {
          const catVal = document.getElementById('pe-cat').value;
          await apiFetch(`/api/catalog/products/${prod.id}`, {
            method: 'PUT',
            body: {
              categoryId: catVal || null,
              name: document.getElementById('pe-name').value.trim(),
              sellingPrice: parseFloat(document.getElementById('pe-sell').value || '0'),
              costPrice: parseFloat(document.getElementById('pe-cost').value || '0'),
              unit: document.getElementById('pe-unit').value.trim() || 'unit',
              minStockAlert: parseFloat(document.getElementById('pe-alert').value || '0'),
            },
          });
          closeModal();
          showToast('Produit mis à jour avec succès', 'success');
          await refreshAllData({ force: true });
        });
      });
    });
  });

  document.querySelectorAll('[data-delete-product]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const prodId = btn.dataset.deleteProduct;
      const prodName = btn.dataset.productName || 'ce produit';
      confirmActionModal({
        title: `Supprimer ${prodName}`,
        message: `Voulez-vous supprimer « ${prodName} » du catalogue actif ? Si ce produit possède déjà un historique de ventes ou de stocks, il sera archivé sans perte d'historique et libérera une place dans votre quota.`,
        confirmLabel: 'Supprimer du catalogue',
        variant: 'danger',
        onConfirm: async () => {
          const res = await apiFetch(`/api/catalog/products/${prodId}`, { method: 'DELETE' });
          showToast(res.message || 'Produit retiré du catalogue actif', 'success');
          await refreshAllData({ force: true });
        },
      });
    });
  });

  if (document.getElementById('recipe-ing-rows')) {
    addRecipeIngredientRow();
    document.getElementById('btn-add-ing-row')?.addEventListener('click', addRecipeIngredientRow);
    document.getElementById('recipe-create-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const ingredients = [...document.querySelectorAll('.recipe-ing-row')].map((row) => ({
          ingredientId: row.querySelector('.ing-select').value,
          quantityRequired: parseFloat(row.querySelector('.ing-qty').value),
        }));
        await apiFetch('/api/catalog/recipes', {
          method: 'POST',
          body: {
            finishedProductId: document.getElementById('rec-finished').value,
            name: document.getElementById('rec-name').value,
            outputQuantity: parseFloat(document.getElementById('rec-output').value || '1'),
            ingredients,
          },
        });
        showToast('Recette enregistrée', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

// ---------------- 4. STOCKS & INVENTAIRE ----------------
function renderInventory() {
  const cur = CURRENCY();
  const filtered = state.levels.filter((lv) => {
    const matchSearch =
      !state.invFilter.search ||
      lv.product_name.toLowerCase().includes(state.invFilter.search.toLowerCase());
    const matchLow = !state.invFilter.lowStockOnly || lv.is_low_stock;
    return matchSearch && matchLow;
  });

  return `
    <div class="kpi-grid">
      <div class="card kpi-card">
        <div class="kpi-label">Articles suivis</div>
        <div class="kpi-value">${state.invSummary?.tracked_products_count || 0}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Valorisation totale</div>
        <div class="kpi-value">${esc(fmtMoney(state.invSummary?.total_inventory_valuation || 0, cur))}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Stocks bas</div>
        <div class="kpi-value">${state.invSummary?.low_stock_count || 0}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Ruptures</div>
        <div class="kpi-value">${state.invSummary?.out_of_stock_count || 0}</div>
      </div>
    </div>

    <div class="two-col">
      <div class="card">
        <div class="section-head"><h3>Ajustement manuel de stock</h3></div>
        <form id="inv-adjust-form" class="form-stack">
          <div class="field">
            <label>Produit concerné</label>
            <select id="adj-product" required>
              <option value="">Sélectionner un produit...</option>
              ${state.products
      .filter((p) => p.inventory_tracking === 'direct')
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (actuel: ${esc(fmtQty(p.current_stock))} ${esc(p.unit)})</option>`)
      .join('')}
            </select>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Type de mouvement</label>
              <select id="adj-type">
                <option value="production_in">Entrée production (+)</option>
                <option value="adjustment">Ajustement inventaire (+/-)</option>
                <option value="loss">Perte / Casse (-)</option>
              </select>
            </div>
            <div class="field">
              <label>Quantité delta</label>
              <input id="adj-qty" type="number" step="0.001" required placeholder="Ex: 10 ou -2" />
            </div>
          </div>
          <div class="field">
            <label>Justification obligatoire</label>
            <input id="adj-notes" required minlength="2" placeholder="Ex: Cuisson matin ou perte service" />
          </div>
          <button type="submit" class="btn btn-primary">Enregistrer le mouvement</button>
        </form>
      </div>

      <div class="card">
        <div class="section-head"><h3>Derniers mouvements de stock</h3></div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Produit</th><th>Type</th><th>Delta</th><th>Notes</th></tr></thead>
            <tbody>
              ${state.movements.length === 0
      ? '<tr><td colspan="4" class="muted-text">Aucun mouvement enregistré.</td></tr>'
      : state.movements
        .slice(0, 10)
        .map(
          (m) => `<tr>
                          <td data-label="Produit"><strong>${esc(m.product_name)}</strong></td>
                          <td data-label="Type"><span class="status-pill status-info">${esc(m.movement_type)}</span></td>
                          <td data-label="Delta" class="mono">${parseFloat(m.quantity_delta) > 0 ? '+' : ''}${esc(fmtQty(m.quantity_delta))} ${esc(m.unit)}</td>
                          <td data-label="Notes" class="muted-text">${esc(m.notes || m.source_type || '—')}</td>
                        </tr>`
        )
        .join('')
    }
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="section-head">
        <h3>État détaillé des stocks</h3>
        <div class="toolbar">
          <input id="inv-search" class="input-inline" type="search" placeholder="Filtrer..." value="${esc(state.invFilter.search)}" style="max-width:220px;" />
          <label style="display:flex;align-items:center;gap:6px;font-size:13px;min-height:44px;cursor:pointer;">
            <input id="inv-low-only" type="checkbox" ${state.invFilter.lowStockOnly ? 'checked' : ''} style="width:18px;height:18px;" />
            Alertes uniquement
          </label>
        </div>
      </div>
      <div class="table-wrap">
        <table class="responsive-table">
          <thead><tr><th>Produit</th><th>Quantité</th><th>Seuil alerte</th><th>PMP</th><th>Valorisation</th><th>Statut</th></tr></thead>
          <tbody>
            ${filtered.length === 0
      ? '<tr><td colspan="6" class="muted-text">Aucun niveau de stock enregistré.</td></tr>'
      : filtered
        .map(
          (lv) => `<tr>
                        <td data-label="Produit"><strong>${esc(lv.product_name)}</strong></td>
                        <td data-label="Quantité" class="mono">${esc(fmtQty(lv.current_quantity))} ${esc(lv.unit)}</td>
                        <td data-label="Seuil" class="mono">${esc(fmtQty(lv.min_stock_alert))}</td>
                        <td data-label="PMP" class="mono">${esc(fmtMoney(lv.pmp, cur))}</td>
                        <td data-label="Valorisation" class="mono">${esc(fmtMoney(lv.stock_valuation, cur))}</td>
                        <td data-label="Statut">${lv.is_low_stock
              ? '<span class="status-pill status-critical">Alerte</span>'
              : '<span class="status-pill status-open">OK</span>'
            }</td>
                      </tr>`
        )
        .join('')
    }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function bindInventory() {
  document.getElementById('inv-search')?.addEventListener('input', (e) => {
    state.invFilter.search = e.target.value;
    renderRoute();
    const el = document.getElementById('inv-search');
    if (el) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  });

  document.getElementById('inv-low-only')?.addEventListener('change', (e) => {
    state.invFilter.lowStockOnly = e.target.checked;
    renderRoute();
  });

  document.getElementById('inv-adjust-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/inventory/adjustments', {
        method: 'POST',
        body: {
          productId: document.getElementById('adj-product').value,
          movementType: document.getElementById('adj-type').value,
          quantityDelta: parseFloat(document.getElementById('adj-qty').value),
          notes: document.getElementById('adj-notes').value,
        },
      });
      showToast('Mouvement de stock enregistré', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ---------------- 5. ACHATS & FOURNISSEURS ----------------
function renderPurchases() {
  const cur = CURRENCY();
  const sub = state.subtabs.purchases;
  const ap = state.activePurchase;

  return `
    <div class="subtabs">
      <button class="subtab ${sub === 'orders' ? 'active' : ''}" data-purch-tab="orders" type="button">Commandes d'achat (${state.purchases.length})</button>
      <button class="subtab ${sub === 'suppliers' ? 'active' : ''}" data-purch-tab="suppliers" type="button">Fournisseurs (${state.suppliers.length})</button>
    </div>

    ${sub === 'orders'
      ? `<div class="two-col">
            <div style="display:flex;flex-direction:column;gap:16px;min-width:0;">
              <div class="card">
                <div class="section-head"><h3>Nouvelle commande fournisseur</h3></div>
                <form id="purchase-create-form" class="form-stack">
                  <div class="field-row">
                    <div class="field">
                      <label>Référence</label>
                      <input id="purch-ref" required value="ACH-${Date.now().toString().slice(-5)}" />
                    </div>
                    <div class="field">
                      <label>Fournisseur</label>
                      <select id="purch-sup">
                        <option value="">Optionnel...</option>
                        ${state.suppliers.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
                      </select>
                    </div>
                  </div>
                  <div class="field">
                    <label>Notes</label>
                    <input id="purch-notes" placeholder="Livraison prévue matin" />
                  </div>
                  <button type="submit" class="btn btn-primary">Créer commande d'achat</button>
                </form>
              </div>

              <div class="card">
                <div class="section-head"><h3>Commandes enregistrées</h3></div>
                <div class="table-wrap">
                  <table class="responsive-table">
                    <thead><tr><th>Réf.</th><th>Fournisseur</th><th>Total</th><th>Statut</th><th>Action</th></tr></thead>
                    <tbody>
                      ${state.purchases.length === 0
        ? '<tr><td colspan="5" class="muted-text">Aucune commande d\'achat.</td></tr>'
        : state.purchases
          .map(
            (p) => `<tr>
                                  <td data-label="Référence" class="mono"><strong>${esc(p.reference)}</strong></td>
                                  <td data-label="Fournisseur">${esc(p.supplier_name || '—')}</td>
                                  <td data-label="Total" class="mono">${esc(fmtMoney(p.total_amount, cur))}</td>
                                  <td data-label="Statut">${statusBadge(p.status)}</td>
                                  <td data-label="Action"><button class="btn btn-outline btn-sm" data-open-purch="${esc(p.id)}" type="button">Gérer</button></td>
                                </tr>`
          )
          .join('')
      }
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div id="purchase-detail-card" class="card">
              <div class="section-head">
                <h3>${ap ? `Commande ${esc(ap.reference)}` : 'Détail commande'}</h3>
                ${ap ? statusBadge(ap.status) : ''}
              </div>
              ${!ap
        ? '<p class="muted-text">Sélectionnez ou créez une commande pour y ajouter des articles et la réceptionner (calcul du PMP).</p>'
        : `
                    <p class="muted-text" style="margin-bottom:12px;">Fournisseur : <strong>${esc(ap.supplier_name || 'Non spécifié')}</strong> • Total : <strong class="mono">${esc(fmtMoney(ap.total_amount, cur))}</strong></p>
                    <div class="table-wrap" style="margin-bottom:14px;">
                      <table class="responsive-table">
                        <thead><tr><th>Produit</th><th>Qté</th><th>Coût unit.</th><th>Sous-total</th><th></th></tr></thead>
                        <tbody>
                          ${(ap.items || []).length === 0
          ? '<tr><td colspan="5" class="muted-text">Aucune ligne ajoutée.</td></tr>'
          : ap.items
            .map(
              (it) => `<tr>
                                      <td data-label="Produit"><strong>${esc(it.product_name)}</strong></td>
                                      <td data-label="Qté" class="mono">${esc(fmtQty(it.quantity))} ${esc(it.unit)}</td>
                                      <td data-label="Coût unit." class="mono">${esc(fmtMoney(it.unit_cost, cur))}</td>
                                      <td data-label="Sous-total" class="mono">${esc(fmtMoney(it.subtotal, cur))}</td>
                                      <td data-label="Action">${ap.status === 'ordered' || ap.status === 'draft'
                  ? `<button class="btn btn-danger btn-sm" data-del-purch-item="${esc(it.id)}" type="button">&times;</button>`
                  : '—'
                }</td>
                                    </tr>`
            )
            .join('')
        }
                        </tbody>
                      </table>
                    </div>

                    ${ap.status === 'ordered' || ap.status === 'draft'
          ? `<form id="purch-add-item-form" class="form-stack" style="margin-bottom:14px;">
                            <div class="field">
                              <label>Ajouter un article</label>
                              <select id="purch-item-prod" required>
                                <option value="">Choisir un produit...</option>
                                ${state.products
            .filter((p) => p.inventory_tracking === 'direct')
            .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${esc(p.unit)})</option>`)
            .join('')}
                              </select>
                            </div>
                            <div class="field-row">
                              <div class="field"><label>Quantité</label><input id="purch-item-qty" type="number" step="0.001" min="0.001" required /></div>
                              <div class="field"><label>Prix unitaire HT</label><input id="purch-item-cost" type="number" step="0.01" min="0" required /></div>
                            </div>
                            <button type="submit" class="btn btn-outline">+ Ajouter ligne</button>
                          </form>
                          <div class="field-row">
                            <button id="btn-receive-purch" type="button" class="btn btn-success" ${(ap.items || []).length === 0 ? 'disabled' : ''}>Réceptionner (PMP + Stock)</button>
                            <button id="btn-cancel-purch" type="button" class="btn btn-danger">Annuler</button>
                          </div>`
          : '<p class="muted-text">Commande clôturée — ses lignes sont verrouillées et immuables.</p>'
        }
                  `
      }
            </div>
          </div>`
      : `<div class="two-col">
            <div class="card">
              <div class="section-head"><h3>Nouveau fournisseur</h3></div>
              <form id="supplier-create-form" class="form-stack">
                <div class="field"><label>Nom</label><input id="sup-name" required placeholder="Grands Moulins" /></div>
                <div class="field-row">
                  <div class="field"><label>Téléphone</label><input id="sup-phone" placeholder="+221..." /></div>
                  <div class="field"><label>E-mail</label><input id="sup-email" type="email" placeholder="contact@fournisseur.sn" /></div>
                </div>
                <div class="field"><label>Adresse</label><input id="sup-addr" placeholder="Zone industrielle" /></div>
                <button type="submit" class="btn btn-primary">Enregistrer fournisseur</button>
              </form>
            </div>
            <div class="card">
              <div class="section-head"><h3>Fournisseurs</h3></div>
              <div class="table-wrap">
                <table class="responsive-table">
                  <thead><tr><th>Nom</th><th>Contact</th><th>Cmd reçues</th><th>Total achats</th></tr></thead>
                  <tbody>
                    ${state.suppliers.length === 0
        ? '<tr><td colspan="4" class="muted-text">Aucun fournisseur.</td></tr>'
        : state.suppliers
          .map(
            (s) => `<tr>
                                <td data-label="Nom"><strong>${esc(s.name)}</strong></td>
                                <td data-label="Contact" class="muted-text">${esc(s.phone || s.email || '—')}</td>
                                <td data-label="Cmd reçues" class="mono">${esc(s.total_orders_count)}</td>
                                <td data-label="Total achats" class="mono">${esc(fmtMoney(s.total_spend, cur))}</td>
                              </tr>`
          )
          .join('')
      }
                  </tbody>
                </table>
              </div>
            </div>
          </div>`
    }
  `;
}

function bindPurchases() {
  document.querySelectorAll('[data-purch-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtabs.purchases = btn.dataset.purchTab;
      renderRoute();
    });
  });

  document.getElementById('supplier-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/purchases/suppliers', {
        method: 'POST',
        body: {
          name: document.getElementById('sup-name').value,
          phone: document.getElementById('sup-phone').value,
          email: document.getElementById('sup-email').value,
          address: document.getElementById('sup-addr').value,
        },
      });
      showToast('Fournisseur créé', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('purchase-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const supId = document.getElementById('purch-sup').value;
      const res = await apiFetch('/api/purchases', {
        method: 'POST',
        body: {
          supplierId: supId || undefined,
          reference: document.getElementById('purch-ref').value,
          notes: document.getElementById('purch-notes').value || undefined,
        },
      });
      state.activePurchase = { ...res.data, items: [] };
      showToast('Commande créée', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-open-purch]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/purchases/${btn.dataset.openPurch}`);
        state.activePurchase = res.data;
        renderRoute();
        document.getElementById('purchase-detail-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.getElementById('purch-add-item-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch(`/api/purchases/${state.activePurchase.id}/items`, {
        method: 'POST',
        body: {
          productId: document.getElementById('purch-item-prod').value,
          quantity: parseFloat(document.getElementById('purch-item-qty').value),
          unitCost: parseFloat(document.getElementById('purch-item-cost').value),
        },
      });
      showToast('Article ajouté à la commande', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-del-purch-item]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/purchases/${state.activePurchase.id}/items/${btn.dataset.delPurchItem}`, {
          method: 'DELETE',
        });
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.getElementById('btn-receive-purch')?.addEventListener('click', async () => {
    try {
      await apiFetch(`/api/purchases/${state.activePurchase.id}/receive`, { method: 'POST' });
      showToast('Achat réceptionné : stocks incrémentés et PMP recalculé !', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-cancel-purch')?.addEventListener('click', async () => {
    try {
      await apiFetch(`/api/purchases/${state.activePurchase.id}/cancel`, {
        method: 'POST',
        body: { reason: 'Annulé depuis interface web' },
      });
      showToast('Commande annulée', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

// ---------------- 6. TRÉSORERIE & Z DE CAISSE ----------------
function formatZReportText(session) {
  const cur = CURRENCY();
  const z = session.zReport;
  const pb = z.paymentBreakdown;
  const lines = [
    `RAPPORT Z DE CAISSE — ${state.company?.name || 'MyRestoGest'}`,
    `Statut : ${z.status === 'open' ? 'Session en cours' : 'Clôturée'}`,
    `Ouverture : ${fmtDate(z.openedAt)}`,
    ...(z.closedAt ? [`Clôture : ${fmtDate(z.closedAt)}`] : []),
    '--------------------------------',
    `Tickets validés : ${z.ticketsCount} (Annulés : ${z.cancelledCount})`,
    `Ventes brutes : ${fmtMoney(z.grossSales, cur)}`,
    `Remises accordées : -${fmtMoney(z.totalDiscounts, cur)}`,
    `Chiffre d'affaires NET : ${fmtMoney(z.netSales, cur)}`,
    '--------------------------------',
    'VENTILATION PAR MOYEN DE PAIEMENT :',
    `- Espèces : ${fmtMoney(pb.especes, cur)}`,
    `- Wave : ${fmtMoney(pb.wave, cur)}`,
    `- Orange Money : ${fmtMoney(pb.orangeMoney, cur)}`,
    ...(pb.otherMobileMoney > 0 ? [`- Autre Mobile Money : ${fmtMoney(pb.otherMobileMoney, cur)}`] : []),
    `- Carte Bancaire : ${fmtMoney(pb.carteBancaire, cur)}`,
    `- Virement / Chèque / Autres : ${fmtMoney(pb.virementChequeAutres, cur)}`,
    `Total Encaissé : ${fmtMoney(z.totalCollected, cur)}`,
    '--------------------------------',
    `Fond initial : ${fmtMoney(z.openingAmount, cur)}`,
    `Dépenses sorties caisse : -${fmtMoney(z.totalExpenses, cur)}`,
    `Remboursements espèces : -${fmtMoney(z.cashRefunds, cur)}`,
    `Solde théorique tiroir : ${fmtMoney(z.expectedCashInDrawer, cur)}`,
    ...(z.actualClosingAmount !== null ? [`Montant réel compté : ${fmtMoney(z.actualClosingAmount, cur)}`] : []),
    ...(z.differenceAmount !== null ? [`ÉCART DE CAISSE : ${fmtMoney(z.differenceAmount, cur)}`] : []),
  ];
  return lines.join('\n');
}

function openZReportModal(session) {
  const cur = CURRENCY();
  const z = session.zReport;
  const pb = z.paymentBreakdown;
  const textReport = formatZReportText(session);
  const waHref = `https://wa.me/?text=${encodeURIComponent(textReport)}`;
  const mailHref = `mailto:?subject=${encodeURIComponent(`Rapport Z de caisse - ${state.company?.name || 'MyRestoGest'}`)}&body=${encodeURIComponent(textReport)}`;

  openModal(
    `Rapport Z de Caisse (${z.status === 'open' ? 'Temps réel' : 'Clôturé'})`,
    `
      <div class="receipt-paper">
        <div style="text-align:center;margin-bottom:10px;">
          <strong style="font-size:15px;">${esc(state.company?.name || 'MyRestoGest')}</strong><br/>
          <span>RAPPORT Z DE CAISSE</span><br/>
          <span>Ouverte : ${esc(fmtDate(z.openedAt))}</span>
          ${z.closedAt ? `<br/><span>Clôturée : ${esc(fmtDate(z.closedAt))}</span>` : ''}
        </div>
        <hr/>
        <div style="display:flex;justify-content:space-between;"><span>Tickets validés / annulés</span><span>${z.ticketsCount} / ${z.cancelledCount}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Chiffre d'affaires NET</span><strong>${esc(fmtMoney(z.netSales, cur))}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Remises accordées</span><span>-${esc(fmtMoney(z.totalDiscounts, cur))}</span></div>
        <hr/>
        <div><strong>Ventilation par moyen de paiement :</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Espèces</span><span>${esc(fmtMoney(pb.especes, cur))}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Wave</span><span>${esc(fmtMoney(pb.wave, cur))}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Orange Money</span><span>${esc(fmtMoney(pb.orangeMoney, cur))}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Carte Bancaire</span><span>${esc(fmtMoney(pb.carteBancaire, cur))}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Virement / Autres</span><span>${esc(fmtMoney(pb.virementChequeAutres, cur))}</span></div>
        <div style="display:flex;justify-content:space-between;font-weight:700;margin-top:4px;"><span>TOTAL ENCAISSÉ</span><span>${esc(fmtMoney(z.totalCollected, cur))}</span></div>
        <hr/>
        <div style="display:flex;justify-content:space-between;"><span>Fond initial</span><span>${esc(fmtMoney(z.openingAmount, cur))}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Dépenses / Remb. cash</span><span>-${esc(fmtMoney(z.totalExpenses + z.cashRefunds, cur))}</span></div>
        <div style="display:flex;justify-content:space-between;"><span>Solde théorique tiroir</span><strong>${esc(fmtMoney(z.expectedCashInDrawer, cur))}</strong></div>
        ${z.actualClosingAmount !== null ? `<div style="display:flex;justify-content:space-between;"><span>Montant compté</span><span>${esc(fmtMoney(z.actualClosingAmount, cur))}</span></div>` : ''}
        ${z.differenceAmount !== null ? `<div style="display:flex;justify-content:space-between;font-weight:700;"><span>ÉCART DE CAISSE</span><span>${esc(fmtMoney(z.differenceAmount, cur))}</span></div>` : ''}
      </div>
      <div class="toolbar" style="margin-top:14px;">
        <button type="button" class="btn btn-primary" onclick="window.print()">Imprimer PDF</button>
        <button id="btn-download-z-txt" type="button" class="btn btn-outline">Exporter (.TXT)</button>
        <a href="${esc(waHref)}" target="_blank" rel="noopener" class="btn btn-whatsapp" style="text-decoration:none;">Envoyer WhatsApp</a>
        <a href="${esc(mailHref)}" class="btn btn-outline" style="text-decoration:none;">Envoyer Email</a>
      </div>
    `
  );

  document.getElementById('btn-download-z-txt')?.addEventListener('click', () => {
    const blob = new Blob([textReport], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rapport-z-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

function renderCash() {
  const cur = CURRENCY();
  const cs = state.cashCurrent;
  const z = cs?.zReport;
  const pb = z?.paymentBreakdown || {};
  const canWrite = can('cash:write');

  return `
    ${!cs
      ? canWrite
        ? `<div class="card" style="max-width:520px;">
            <div class="section-head"><h3>Ouvrir une session de caisse</h3></div>
            <p class="muted-text" style="margin-bottom:14px;">Aucune session active. Saisissez le fond de caisse initial pour encaisser et générer votre rapport Z.</p>
            <form id="cash-open-form" class="form-stack">
              <div class="field">
                <label>Fond de caisse initial (${esc(cur)})</label>
                <input id="cash-opening-amount" type="number" step="0.01" min="0" value="50000" required />
              </div>
              <button type="submit" class="btn btn-primary">Ouvrir la caisse</button>
            </form>
          </div>`
        : `<div class="card"><p class="muted-text" style="margin:0;">Aucune session de caisse ouverte actuellement (mode consultation uniquement).</p></div>`
      : `<div class="kpi-grid">
            <div class="card kpi-card">
              <div class="kpi-label">Chiffre d'affaires Net</div>
              <div class="kpi-value">${esc(fmtMoney(z?.netSales || 0, cur))}</div>
              <div class="kpi-foot">${z?.ticketsCount || 0} ticket(s) validé(s)</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Total Encaissé</div>
              <div class="kpi-value">${esc(fmtMoney(z?.totalCollected || 0, cur))}</div>
              <div class="kpi-foot">Espèces: ${esc(fmtMoney(pb.especes || 0, cur))}</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Dépenses &amp; Remb. Cash</div>
              <div class="kpi-value">${esc(fmtMoney((cs.metrics?.totalExpenses || 0) + (cs.metrics?.cashRefunds || 0), cur))}</div>
              <div class="kpi-foot">Fond initial : ${esc(fmtMoney(cs.openingAmount, cur))}</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Solde théorique tiroir</div>
              <div class="kpi-value" style="color:var(--success)">${esc(fmtMoney(cs.metrics.theoreticalCashInDrawer, cur))}</div>
              <div class="kpi-foot">Écart à la clôture : 0 attendu</div>
            </div>
          </div>

          <div class="${canWrite ? 'two-col' : ''}">
            <div class="card">
              <div class="section-head">
                <h3>Rapport Z &amp; Ventilation Paiements</h3>
                <button id="btn-export-current-z" type="button" class="btn btn-outline btn-sm">Imprimer / Exporter Z</button>
              </div>
              <div class="z-report-grid" style="margin-bottom:12px;">
                <div class="z-stat-box">
                  <div class="z-stat-label">Tickets validés</div>
                  <div class="z-stat-val">${z?.ticketsCount || 0}</div>
                </div>
                <div class="z-stat-box">
                  <div class="z-stat-label">Remises accordées</div>
                  <div class="z-stat-val">${esc(fmtMoney(z?.totalDiscounts || 0, cur))}</div>
                </div>
              </div>
              <div class="z-breakdown-list">
                <div class="z-breakdown-row"><span>Espèces</span><strong class="mono">${esc(fmtMoney(pb.especes || 0, cur))}</strong></div>
                <div class="z-breakdown-row"><span>Wave</span><strong class="mono">${esc(fmtMoney(pb.wave || 0, cur))}</strong></div>
                <div class="z-breakdown-row"><span>Orange Money</span><strong class="mono">${esc(fmtMoney(pb.orangeMoney || 0, cur))}</strong></div>
                <div class="z-breakdown-row"><span>Carte Bancaire</span><strong class="mono">${esc(fmtMoney(pb.carteBancaire || 0, cur))}</strong></div>
                <div class="z-breakdown-row"><span>Virement / Chèque / Autres</span><strong class="mono">${esc(fmtMoney(pb.virementChequeAutres || 0, cur))}</strong></div>
              </div>
              <div class="toolbar" style="margin-top:14px;">
                <a href="${esc(`https://wa.me/?text=${encodeURIComponent(formatZReportText(cs))}`)}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-sm" style="text-decoration:none;flex:1;">Envoyer Z sur WhatsApp</a>
                <a href="${esc(`mailto:?subject=${encodeURIComponent(`Rapport Z - ${state.company?.name || 'MyRestoGest'}`)}&body=${encodeURIComponent(formatZReportText(cs))}`)}" class="btn btn-outline btn-sm" style="text-decoration:none;">Envoyer par Email</a>
              </div>
            </div>

            ${canWrite ? `<div style="display:flex;flex-direction:column;gap:16px;min-width:0;">
              <div class="card">
                <div class="section-head"><h3>Enregistrer une dépense</h3></div>
                <form id="expense-create-form" class="form-stack">
                  <div class="field-row">
                    <div class="field">
                      <label>Catégorie</label>
                      <input id="exp-cat" required placeholder="Fournitures / Glaçons" />
                    </div>
                    <div class="field">
                      <label>Montant (${esc(cur)})</label>
                      <input id="exp-amount" type="number" step="0.01" min="0.01" required />
                    </div>
                  </div>
                  <div class="field">
                    <label>Description / Motif</label>
                    <input id="exp-desc" required placeholder="Achat urgent en espèces" />
                  </div>
                  <button type="submit" class="btn btn-amber">Décaisser dépense</button>
                </form>
              </div>

              <div class="card">
                <div class="section-head"><h3>Clôturer la session de caisse (Z Final)</h3></div>
                <form id="cash-close-form" class="form-stack">
                  <div class="field">
                    <label>Montant réel compté dans le tiroir (${esc(cur)})</label>
                    <input id="cash-actual-amount" type="number" step="0.01" min="0" required value="${cs.metrics.theoreticalCashInDrawer}" />
                  </div>
                  <p class="muted-text">Solde théorique attendu : <strong class="mono">${esc(fmtMoney(cs.metrics.theoreticalCashInDrawer, cur))}</strong></p>
                  <button type="submit" class="btn btn-danger">Clôturer &amp; Générer le Z définitif</button>
                </form>
              </div>
            </div>` : ''}
          </div>`
    }

    <div class="two-col">
      <div class="card">
        <div class="section-head"><h3>Historique des Z de caisse</h3></div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Ouverture</th><th>Attendu</th><th>Réel</th><th>Écart</th><th>Statut</th><th></th></tr></thead>
            <tbody>
              ${state.cashSessions.length === 0
      ? '<tr><td colspan="6" class="muted-text">Aucune session.</td></tr>'
      : state.cashSessions
        .map(
          (s) => `<tr>
                          <td data-label="Ouverture">${esc(fmtDate(s.opened_at))}</td>
                          <td data-label="Attendu" class="mono">${s.expected_closing_amount !== null ? esc(fmtMoney(s.expected_closing_amount, cur)) : '—'}</td>
                          <td data-label="Réel" class="mono">${s.actual_closing_amount !== null ? esc(fmtMoney(s.actual_closing_amount, cur)) : '—'}</td>
                          <td data-label="Écart" class="mono">${s.difference_amount !== null ? esc(fmtMoney(s.difference_amount, cur)) : '—'}</td>
                          <td data-label="Statut">${statusBadge(s.status)}</td>
                          <td data-label="Rapport Z"><button class="btn btn-outline btn-sm" data-cash-detail="${esc(s.id)}" type="button">Rapport Z</button></td>
                        </tr>`
        )
        .join('')
    }
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="section-head"><h3>Dépenses récentes (${state.expenses.length})</h3></div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Catégorie</th><th>Montant</th><th>Motif</th><th>Auteur / Date</th></tr></thead>
            <tbody>
              ${state.expenses.length === 0
      ? '<tr><td colspan="4" class="muted-text">Aucune dépense enregistrée.</td></tr>'
      : state.expenses
        .map(
          (ex) => `<tr>
                          <td data-label="Catégorie"><strong>${esc(ex.category)}</strong></td>
                          <td data-label="Montant" class="mono">${esc(fmtMoney(ex.amount, cur))}</td>
                          <td data-label="Motif">${esc(ex.description)}</td>
                          <td data-label="Date"><div>${esc(ex.author_name || '—')}</div><div class="muted-text" style="font-size:11px;">${esc(fmtDate(ex.created_at))}</div></td>
                        </tr>`
        )
        .join('')
    }
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function bindCash() {
  const openForm = document.getElementById('cash-open-form');
  openForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await withFormSubmit(openForm, async () => {
      await apiFetch('/api/cash/sessions/open', {
        method: 'POST',
        body: { openingAmount: parseFloat(document.getElementById('cash-opening-amount').value || '0') },
      });
      showToast('Session de caisse ouverte et enregistrée', 'success');
      await refreshAllData({ force: true });
    });
  });

  document.getElementById('btn-export-current-z')?.addEventListener('click', () => {
    if (state.cashCurrent) openZReportModal(state.cashCurrent);
  });

  const expForm = document.getElementById('expense-create-form');
  expForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await withFormSubmit(expForm, async () => {
      const res = await apiFetch('/api/cash/expenses', {
        method: 'POST',
        body: {
          cashSessionId: state.cashCurrent?.id,
          category: document.getElementById('exp-cat').value.trim(),
          amount: parseFloat(document.getElementById('exp-amount').value),
          description: document.getElementById('exp-desc').value.trim(),
        },
      });
      if (res?.data) {
        const confirmed = {
          ...res.data,
          author_name: state.user?.full_name || '',
        };
        state.expenses = [confirmed, ...(state.expenses || []).filter((ex) => ex.id !== confirmed.id)];
      }
      showToast('Dépense enregistrée en base avec succès', 'success');
      await refreshAllData({ force: true });
    });
  });

  document.getElementById('cash-close-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const actualAmount = parseFloat(document.getElementById('cash-actual-amount').value);
    const cur = CURRENCY();
    confirmActionModal({
      title: 'Confirmer la clôture définitive de la caisse',
      message: `Vous êtes sur le point de clôturer la session de caisse avec un montant compté de ${fmtMoney(actualAmount, cur)}. Cette opération fige définitivement le rapport Z.`,
      confirmLabel: 'Clôturer la caisse',
      variant: 'danger',
      onConfirm: async () => {
        const res = await apiFetch(`/api/cash/sessions/${state.cashCurrent.id}/close`, {
          method: 'POST',
          body: { actualAmount },
        });
        const diff = parseFloat(res.data.difference_amount || 0);
        showToast(`Caisse clôturée (écart : ${fmtMoney(diff, cur)})`, 'success');
        await refreshAllData({ force: true });
        if (res.data?.zReport) {
          openZReportModal(res.data);
        }
      },
    });
  });

  document.querySelectorAll('[data-cash-detail]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/cash/sessions/${btn.dataset.cashDetail}`);
        if (res.data?.zReport) {
          openZReportModal(res.data);
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// ---------------- 7. ABONNEMENT SAAS & MULTI-DEVISES XOF / GNF ----------------
function getPlanPriceInCurrency(plan, cycle, cur) {
  const f = plan.features || {};
  if (cur === 'GNF') {
    return cycle === 'yearly' ? Number(f.gnf_yearly || plan.yearly_price * 15) : Number(f.gnf_monthly || plan.monthly_price * 15);
  }
  return cycle === 'yearly' ? Number(plan.yearly_price) : Number(plan.monthly_price);
}

function renderSubscription() {
  const cur = CURRENCY();
  const sub = state.subscriptionData?.subscription;
  const plans = state.subscriptionData?.plans || [];
  const comp = state.subscriptionData?.company || state.company || {};
  const isYearly = state.billingCycle === 'yearly';

  return `
    <div class="license-hero">
      <div>
        <div class="brand-badge" style="margin-bottom:8px;">
          <span class="brand-dot"></span>
          <span>Licence MyRestoGest</span>
        </div>
        <h3 style="margin:0 0 4px;font-family:var(--font-display);font-size:20px;">
          ${sub ? esc(sub.plan_name) : 'Essai Gratuit Cloud'} — ${statusBadge(sub?.status || 'trial')}
        </h3>
        <p style="margin:0;color:#cbd5e1;font-size:13px;">
          Établissement : <strong>${esc(comp.name || 'Mon Établissement')}</strong> • Devise active : <strong>${esc(cur)}</strong>
          ${sub?.ends_at ? ` • Échéance : ${esc(fmtDate(sub.ends_at))}` : ''}
        </p>
      </div>
      <div class="tabs-segmented" style="background:rgba(255,255,255,0.1);min-width:220px;">
        <button type="button" class="seg-btn ${!isYearly ? 'active' : ''}" data-bill-cycle="monthly">Mensuel</button>
        <button type="button" class="seg-btn ${isYearly ? 'active' : ''}" data-bill-cycle="yearly">Annuel (-17%)</button>
      </div>
    </div>

    <div class="card">
      <div class="section-head">
        <h3>Paramètres Établissement &amp; Multi-Devises (Sénégal / Guinée)</h3>
      </div>
      <form id="company-settings-form" class="form-stack">
        <div class="field-row">
          <div class="field">
            <label>Nom de l'établissement</label>
            <input id="set-comp-name" required value="${esc(comp.name || '')}" />
          </div>
          <div class="field">
            <label>Devise principale (XOF / GNF)</label>
            <select id="set-comp-currency">
              <option value="XOF" ${cur === 'XOF' ? 'selected' : ''}>XOF — Franc CFA (Sénégal / UEMOA)</option>
              <option value="GNF" ${cur === 'GNF' ? 'selected' : ''}>GNF — Franc Guinéen (Guinée)</option>
              <option value="EUR" ${cur === 'EUR' ? 'selected' : ''}>EUR — Euro (€)</option>
              <option value="USD" ${cur === 'USD' ? 'selected' : ''}>USD — Dollar ($)</option>
              <option value="MAD" ${cur === 'MAD' ? 'selected' : ''}>MAD — Dirham (DH)</option>
              <option value="CAD" ${cur === 'CAD' ? 'selected' : ''}>CAD — Dollar CAD</option>
            </select>
          </div>
        </div>
        <div class="field-row">
          <div class="field">
            <label>Taux TVA par défaut (%)</label>
            <input id="set-comp-tax" type="number" step="0.1" min="0" max="100" value="${esc(comp.default_tax_rate ?? 0)}" />
          </div>
          <div class="field" style="justify-content:flex-end;">
            <label style="display:flex;align-items:center;gap:8px;min-height:44px;cursor:pointer;">
              <input id="set-comp-neg" type="checkbox" ${comp.allow_negative_stock ? 'checked' : ''} style="width:18px;height:18px;" />
              Autoriser la vente même en stock négatif
            </label>
          </div>
        </div>
        <div class="toolbar">
          <button type="submit" class="btn btn-primary">Enregistrer la devise &amp; les paramètres</button>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="section-head">
        <h3>Choisissez votre moyen de paiement de licence</h3>
        <span class="muted-text">Activation instantanée Sénégal &amp; Guinée</span>
      </div>
      <div class="service-mode-pills">
        <button type="button" class="service-pill ${state.checkoutMethod === 'wave' ? 'active' : ''}" data-sub-method="wave">Wave Mobile</button>
        <button type="button" class="service-pill ${state.checkoutMethod === 'orange_money' ? 'active' : ''}" data-sub-method="orange_money">Orange Money</button>
        <button type="button" class="service-pill ${state.checkoutMethod === 'card_visa_uba' ? 'active' : ''}" data-sub-method="card_visa_uba">Carte Visa / UBA</button>
      </div>
    </div>

    <div class="pricing-grid">
      ${plans
      .map((plan) => {
        const price = getPlanPriceInCurrency(plan, state.billingCycle, cur);
        const highlights = plan.features?.highlights || [];
        const isRec = Boolean(plan.features?.recommended);
        const isCurrent = sub?.plan_id === plan.id && sub?.status === 'active';
        return `<div class="pricing-card ${isRec ? 'is-recommended' : ''}">
            <div class="section-head" style="margin-bottom:0;">
              <h3>${esc(plan.name)}</h3>
              ${isCurrent ? '<span class="status-pill status-open">Plan Actif</span>' : isRec ? '<span class="status-pill status-info">Recommandé</span>' : ''}
            </div>
            <p class="muted-text">${esc(plan.description || '')}</p>
            <div>
              <div class="pricing-price">${esc(fmtMoney(price, cur))}</div>
              <span class="muted-text">${isYearly ? 'par an' : 'par mois'}</span>
            </div>
            <ul class="pricing-features">
              ${highlights.map((h) => `<li>${esc(h)}</li>`).join('')}
            </ul>
            <button type="button" class="btn ${isRec ? 'btn-primary' : 'btn-outline'} btn-full" data-subscribe-plan="${esc(plan.id)}" data-plan-name="${esc(plan.name)}" data-plan-price="${price}">
              ${isCurrent ? 'Renouveler la licence' : 'Souscrire maintenant'}
            </button>
          </div>`;
      })
      .join('')}
    </div>
  `;
}

function bindSubscription() {
  document.querySelectorAll('[data-bill-cycle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.billingCycle = btn.dataset.billCycle;
      renderRoute();
    });
  });

  document.querySelectorAll('[data-sub-method]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.checkoutMethod = btn.dataset.subMethod;
      renderRoute();
    });
  });

  document.getElementById('company-settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/subscriptions/company-settings', {
        method: 'PUT',
        body: {
          name: document.getElementById('set-comp-name').value,
          currency: document.getElementById('set-comp-currency').value,
          defaultTaxRate: parseFloat(document.getElementById('set-comp-tax').value || '0'),
          allowNegativeStock: document.getElementById('set-comp-neg').checked,
        },
      });
      state.company = res.data;
      showToast(`Devise (${res.data.currency}) et paramètres mis à jour`, 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-subscribe-plan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const planId = btn.dataset.subscribePlan;
      const planName = btn.dataset.planName;
      const price = Number(btn.dataset.planPrice || 0);
      const cur = CURRENCY();
      const methodNames = {
        wave: 'Wave Mobile',
        orange_money: 'Orange Money',
        card_visa_uba: 'Carte Bancaire (Visa / UBA)',
      };

      openModal(
        `Souscription • ${planName}`,
        `
          <form id="sub-checkout-form" class="form-stack">
            <div class="summary-lines">
              <div class="summary-line"><span>Formule</span><strong>${esc(planName)} (${state.billingCycle === 'yearly' ? 'Annuel' : 'Mensuel'})</strong></div>
              <div class="summary-line"><span>Mode choisi</span><strong>${esc(methodNames[state.checkoutMethod] || state.checkoutMethod)}</strong></div>
              <div class="summary-line summary-total"><span>Total à régler</span><span class="mono">${esc(fmtMoney(price, cur))}</span></div>
            </div>
            <div class="field">
              <label>${state.checkoutMethod === 'card_visa_uba' ? '4 derniers chiffres carte / Réf. autorisation' : 'Numéro téléphone Wave / Orange Money'}</label>
              <input id="sub-payer-ref" required placeholder="+221 77 ... ou +224 62 ..." />
            </div>
            <button type="submit" class="btn btn-success btn-full">Confirmer et activer ma licence</button>
          </form>
        `
      );

      document.getElementById('sub-checkout-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const res = await apiFetch('/api/subscriptions/checkout', {
            method: 'POST',
            body: {
              planId,
              billingPeriod: state.billingCycle,
              paymentMethod: state.checkoutMethod,
              payerReference: document.getElementById('sub-payer-ref').value,
            },
          });
          closeModal();
          showToast(`Demande d'abonnement enregistrée en attente de validation (${res.data.licenseReference}) !`, 'info');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  });
}

// -------------------------------------------------------------
// DÉMO 1-CLIC COMPLÈTE VIA API RÉELLE
// -------------------------------------------------------------
async function runQuickDemo() {
  const btn = document.getElementById('btn-demo-quickstart');
  const orig = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Création en cours...';
  try {
    const reg = await apiFetch('/api/auth/demo', {
      skipAuth: true,
      method: 'POST',
    });
    setToken(reg.data.token);

    await refreshAllData();
    showToast('Espace démo initialisé avec succès !', 'success');
    showAppView();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = orig;
  }
}

// -------------------------------------------------------------
// INITIALISATION GLOBALE
// -------------------------------------------------------------
async function init() {
  setOnUnauthorized((reason) => {
    setToken(null);
    state.user = null;
    state.company = null;
    showAuthView();
    showToast(reason, 'warning');
  });

  document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchAuthTab(btn.dataset.authTab));
  });

  document.querySelectorAll('[data-route]').forEach((btn) => {
    btn.addEventListener('click', () => setRoute(btn.dataset.route));
  });

  document.getElementById('btn-mobile-menu')?.addEventListener('click', () => toggleSidebar());
  document.getElementById('sidebar-backdrop')?.addEventListener('click', () => toggleSidebar(false));

  document.getElementById('modal-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  });

  document.getElementById('btn-refresh-all')?.addEventListener('click', () => refreshAllData());
  document.getElementById('btn-demo-quickstart')?.addEventListener('click', runQuickDemo);
  document.getElementById('btn-focus-client-login')?.addEventListener('click', () => {
    const panel = document.getElementById('client-auth-panel');
    const loginTab = document.querySelector('#auth-tabs [data-tab="login"]');
    if (loginTab) loginTab.click();
    if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => document.getElementById('login-email')?.focus(), 200);
  });

  document.getElementById('btn-toggle-qr-sound')?.addEventListener('click', () => {
    state.qrSoundEnabled = !state.qrSoundEnabled;
    const iconEl = document.getElementById('qr-sound-icon');
    const lblEl = document.getElementById('qr-sound-label');
    if (iconEl) iconEl.textContent = state.qrSoundEnabled ? '🔔' : '🔕';
    if (lblEl) lblEl.textContent = state.qrSoundEnabled ? 'Son QR : Actif' : 'Son QR : Muet';
    if (state.qrSoundEnabled) {
      playQrNotificationSound();
      showToast('Alerte sonore des commandes QR activée', 'info');
    } else {
      showToast('Alerte sonore des commandes QR désactivée', 'info');
    }
  });

  setInterval(() => {
    const modalOpen = !document.getElementById('modal-backdrop')?.classList.contains('hidden');
    if (getToken() && !document.hidden && !state.isRefreshing && !modalOpen && !isUserActivelyEditingForm()) {
      refreshAllData({ silent: true });
    }
  }, 25000);

  document.getElementById('btn-forgot-password')?.addEventListener('click', () => {
    openModal(
      'Mot de passe oublié ?',
      `
        <form id="forgot-password-form" class="form-stack">
          <p class="muted-text">Saisissez l'adresse e-mail de votre compte gérant pour recevoir un lien sécurisé de réinitialisation.</p>
          <div class="field">
            <label>Adresse e-mail professionnelle</label>
            <input id="forgot-email" type="email" required placeholder="chef@monresto.sn" />
          </div>
          <button type="submit" class="btn btn-primary btn-full">Envoyer les instructions</button>
        </form>
      `
    );
    document.getElementById('forgot-password-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const res = await apiFetch('/api/auth/forgot-password', {
          skipAuth: true,
          method: 'POST',
          body: { email: document.getElementById('forgot-email').value },
        });
        closeModal();
        showToast(res.message || 'Instructions envoyées par e-mail', 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', ignoreUnauthorized: true });
    } catch {
      // ignore if already revoked
    }
    setToken(null);
    state.user = null;
    state.company = null;
    state.role = { code: 'owner', name: 'Propriétaire', isOwner: true, defaultRoute: 'dashboard', permissions: { all: true } };
    state.isDemo = false;
    state.activeSale = null;
    state.activePurchase = null;
    state.staffMembers = [];
    state.staffActivity = [];
    state.customers = [];
    toggleSidebar(false);
    showAuthView();
    showToast('Déconnecté en toute sécurité', 'success');
  });

  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const prevLabel = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Connexion en cours...';
    }
    try {
      const res = await apiFetch('/api/auth/login', {
        skipAuth: true,
        method: 'POST',
        body: {
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value,
        },
      });
      setToken(res.data.token);
      if (res.data.role) {
        state.role = res.data.role;
      }
      state.isDemo = Boolean(res.data.isDemo);
      state.route = getPreferredRoute();
      await refreshAllData({ force: true });
      showToast(`Connexion réussie (${state.role?.name || 'Espace'}) !`, 'success');
      showAppView();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel || 'Se connecter à mon espace';
      }
    }
  });

  document.getElementById('reg-country')?.addEventListener('change', (e) => {
    const sel = e.target;
    const opt = sel.options[sel.selectedIndex];
    const curInp = document.getElementById('reg-currency');
    if (curInp && opt?.dataset?.currency) {
      curInp.value = opt.dataset.currency;
    }
  });

  document.getElementById('register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const prevLabel = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Création en cours...';
    }
    try {
      const acceptCheckbox = document.getElementById('reg-accept-terms');
      if (!acceptCheckbox || !acceptCheckbox.checked) {
        showToast(
          "Vous devez accepter les Conditions Générales d'Utilisation (CGU) et les Conditions Générales de Vente (CGV) pour créer votre compte.",
          'warning'
        );
        return;
      }

      const countrySelect = document.getElementById('reg-country');
      const countryCode = countrySelect ? countrySelect.value : 'SN';
      const selectedOpt = countrySelect ? countrySelect.options[countrySelect.selectedIndex] : null;
      const currency =
        selectedOpt?.dataset?.currency || document.getElementById('reg-currency')?.value || 'XOF';

      const res = await apiFetch('/api/auth/register', {
        skipAuth: true,
        method: 'POST',
        body: {
          companyName: document.getElementById('reg-company').value,
          businessType: document.getElementById('reg-type').value,
          countryCode,
          currency,
          fullName: document.getElementById('reg-fullname').value,
          email: document.getElementById('reg-email').value,
          password: document.getElementById('reg-password').value,
          acceptTerms: true,
          acceptCgu: true,
          acceptCgv: true,
          cguVersion: '2026-11-21',
          cgvVersion: '2026-11-21',
          privacyPolicyVersion: '2026-11-21',
        },
      });
      setToken(res.data.token);
      await refreshAllData();
      showToast('Établissement créé avec succès !', 'success');
      showAppView();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel || 'Créer mon espace MyRestoGest';
      }
    }
  });

  // Charger l'état serveur et les pays en arrière-plan sans bloquer l'affichage immédiat de l'accueil
  loadHealth().catch(() => {});
  apiFetch('/api/subscriptions/plans/public', { skipAuth: true, ignoreUnauthorized: true })
    .then((pubRes) => {
      const countries = pubRes?.data?.countries || [];
      const countrySel = document.getElementById('reg-country');
      if (countrySel && countries.length > 0) {
        countrySel.innerHTML = countries
          .map(
            (c) =>
              `<option value="${esc(c.code)}" data-currency="${esc(c.currency_code)}">${esc(c.name)} (${esc(c.currency_code)} • ${esc(c.dial_code)})</option>`
          )
          .join('');
        const curInp = document.getElementById('reg-currency');
        if (curInp) curInp.value = countries[0].currency_code || 'XOF';
      }
    })
    .catch(() => {
      // fallback to static options
    });

  // Vérifier silencieusement si un cookie de session HttpOnly est actif
  try {
    const meRes = await apiFetch('/api/auth/me', { ignoreUnauthorized: true });
    if (meRes?.data?.user) {
      setToken('cookie-session');
      if (meRes.data.role) state.role = meRes.data.role;
      state.isDemo = Boolean(meRes.data.isDemo);
      state.route = getPreferredRoute();
      await refreshAllData({ force: true });
      showAppView();
      return;
    }
  } catch {
    setToken(null);
  }
  showAuthView();
}

init();
