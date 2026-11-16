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

const state = {
  health: null,
  user: null,
  company: null,
  route: 'dashboard',
  subtabs: {
    catalog: 'products',
    purchases: 'orders',
  },
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
  posFilter: { search: '', categoryId: '' },
  invFilter: { search: '', lowStockOnly: false },
  payMethod: 'cash',
};

const ROUTE_META = {
  dashboard: { title: 'Tableau de bord', sub: 'Indicateurs clés et alertes en temps réel' },
  pos: { title: 'Caisse & POS', sub: 'Prise de commande, encaissement et déstockage atomique' },
  catalog: { title: 'Catalogue & Recettes', sub: 'Catégories, articles et fiches techniques anti-cycle' },
  inventory: { title: 'Stocks & Alertes', sub: 'Niveaux, valorisation PMP, alertes et ajustements' },
  purchases: { title: 'Achats & Fournisseurs', sub: 'Approvisionnement, réception et calcul automatique du PMP' },
  cash: { title: 'Trésorerie & Caisse', sub: 'Ouverture, dépenses et clôture réconciliée' },
};

const CURRENCY = () => state.company?.currency || 'XOF';

function statusBadge(status) {
  const labels = {
    open: 'Ouverte',
    closed: 'Clôturée',
    pending: 'En attente',
    completed: 'Validée',
    cancelled: 'Annulée',
    ordered: 'Commandée',
    received: 'Réceptionnée',
    draft: 'Brouillon',
  };
  return `<span class="status-pill status-${esc(status)}">${esc(labels[status] || status)}</span>`;
}

function methodLabel(m) {
  return (
    {
      cash: 'Espèces',
      card: 'Carte',
      mobile_money: 'Mobile Money',
      transfer: 'Virement',
      check: 'Chèque',
      other: 'Autre',
    }[m] || m
  );
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

function showAppView() {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');
  renderChrome();
  renderRoute();
}

function setRoute(route) {
  state.route = route;
  document.querySelectorAll('.nav-item, .mobile-nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.route === route);
  });
  toggleSidebar(false);
  renderChrome();
  renderRoute();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderChrome() {
  const meta = ROUTE_META[state.route] || ROUTE_META.dashboard;
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-subtitle').textContent = meta.sub;

  if (state.company && state.user) {
    document.getElementById('sidebar-company-name').textContent = `${state.company.name} (${CURRENCY()})`;
    document.getElementById('user-fullname').textContent = state.user.full_name;
    document.getElementById('user-email').textContent = state.user.email;
    const initials = (state.user.full_name || 'RG')
      .split(/\s+/)
      .slice(0, 2)
      .map((s) => s[0]?.toUpperCase() || '')
      .join('');
    document.getElementById('user-avatar').textContent = initials || 'RG';
  }

  const cashPill = document.getElementById('cash-status-pill');
  if (state.cashCurrent) {
    cashPill.className = 'status-pill status-open';
    cashPill.textContent = `Caisse : ${fmtMoney(state.cashCurrent.metrics?.theoreticalCashInDrawer, CURRENCY())}`;
  } else {
    cashPill.className = 'status-pill status-closed';
    cashPill.textContent = 'Caisse fermée';
  }

  const dbType = state.health?.database;
  const isPermanentPg = dbType === 'postgres';
  const dbPill = document.getElementById('sidebar-db-pill');
  dbPill.textContent = isPermanentPg
    ? 'PostgreSQL Permanent'
    : dbType === 'pglite-ephemeral'
      ? 'Démo Éphémère (PGlite)'
      : 'Base Locale (PGlite)';
  dbPill.classList.toggle('is-ephemeral', !isPermanentPg);

  document.getElementById('ephemeral-banner').classList.toggle(
    'hidden',
    dbType !== 'pglite-ephemeral'
  );
}

// -------------------------------------------------------------
// CHARGEMENT DES DONNÉES
// -------------------------------------------------------------
async function loadHealth() {
  try {
    const h = await apiFetch('/health', { skipAuth: true, ignoreUnauthorized: true });
    state.health = h;
    const badge = document.getElementById('auth-env-badge');
    if (badge) {
      badge.textContent = `API OK • DB: ${h.database || 'postgres'}`;
    }
  } catch {
    const badge = document.getElementById('auth-env-badge');
    if (badge) badge.textContent = 'API inaccessible';
  }
}

async function refreshAllData() {
  if (!getToken()) return;
  const results = await Promise.allSettled([
    apiFetch('/api/auth/me'),
    apiFetch('/api/catalog/categories'),
    apiFetch('/api/catalog/products'),
    apiFetch('/api/catalog/recipes'),
    apiFetch('/api/inventory/levels'),
    apiFetch('/api/inventory/alerts'),
    apiFetch('/api/inventory/summary'),
    apiFetch('/api/inventory/movements?limit=50'),
    apiFetch('/api/purchases/suppliers'),
    apiFetch('/api/purchases?limit=30'),
    apiFetch('/api/sales?limit=30'),
    apiFetch('/api/cash/sessions/current'),
    apiFetch('/api/cash/sessions?limit=20'),
    apiFetch('/api/cash/expenses?limit=30'),
  ]);

  const val = (idx, fallback = null) =>
    results[idx]?.status === 'fulfilled' ? results[idx].value.data : fallback;

  const me = val(0);
  if (me) {
    state.user = me.user;
    state.company = me.company;
  }
  state.categories = val(1, []);
  state.products = val(2, []);
  state.recipes = val(3, []);
  state.levels = val(4, []);
  state.alerts = val(5, []);
  state.invSummary = val(6, null);
  state.movements = val(7, []);
  state.suppliers = val(8, []);
  state.purchases = val(9, []);
  state.sales = val(10, []);
  state.cashCurrent = val(11, null);
  state.cashSessions = val(12, []);
  state.expenses = val(13, []);

  if (state.activeSale) {
    try {
      const detail = await apiFetch(`/api/sales/${state.activeSale.id}`);
      state.activeSale = detail.data;
    } catch {
      state.activeSale = null;
    }
  } else {
    const pending = state.sales.find((s) => s.status === 'pending');
    if (pending) {
      const detail = await apiFetch(`/api/sales/${pending.id}`).catch(() => null);
      if (detail) state.activeSale = detail.data;
    }
  }

  if (state.activePurchase) {
    try {
      const pDetail = await apiFetch(`/api/purchases/${state.activePurchase.id}`);
      state.activePurchase = pDetail.data;
    } catch {
      state.activePurchase = null;
    }
  }

  renderChrome();
  renderRoute();
}

// -------------------------------------------------------------
// RENDU DES ROUTES
// -------------------------------------------------------------
function renderRoute() {
  const root = document.getElementById('main-content');
  if (!root) return;

  switch (state.route) {
    case 'dashboard':
      root.innerHTML = renderDashboard();
      bindDashboard();
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
  }
}

// ---------------- 1. DASHBOARD ----------------
function renderDashboard() {
  const cur = CURRENCY();
  const completedSales = state.sales.filter((s) => s.status === 'completed');
  const totalSalesAmount = completedSales.reduce((acc, s) => acc + parseFloat(s.total_amount || 0), 0);
  const cashBalance = state.cashCurrent ? state.cashCurrent.metrics?.theoreticalCashInDrawer : null;

  return `
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
        <div class="kpi-foot">${state.sales.filter((s) => s.status === 'pending').length} ticket(s) en attente</div>
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
        <button class="btn btn-primary" data-jump="pos" type="button">Ouvrir Caisse POS</button>
        <button class="btn btn-amber" data-jump="purchases" type="button">Nouvel Achat</button>
        <button class="btn btn-outline" data-jump="catalog" type="button">Catalogue &amp; Recettes</button>
        <button class="btn btn-outline" data-jump="cash" type="button">${state.cashCurrent ? 'Gérer / Clôturer Caisse' : 'Ouvrir Caisse'}</button>
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
              ${
                state.alerts.length === 0
                  ? '<tr><td colspan="4" class="muted-text">Aucune alerte de stock bas.</td></tr>'
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
          <h3>Dernières ventes</h3>
          <button class="btn btn-outline btn-sm" data-jump="pos" type="button">POS</button>
        </div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Facture</th><th>Montant</th><th>Statut</th><th>Date</th></tr></thead>
            <tbody>
              ${
                state.sales.length === 0
                  ? '<tr><td colspan="4" class="muted-text">Aucune vente enregistrée.</td></tr>'
                  : state.sales
                      .slice(0, 6)
                      .map(
                        (s) => `<tr>
                          <td data-label="Facture" class="mono"><strong>${esc(s.invoice_number)}</strong></td>
                          <td data-label="Montant" class="mono">${esc(fmtMoney(s.total_amount, cur))}</td>
                          <td data-label="Statut">${statusBadge(s.status)}</td>
                          <td data-label="Date">${esc(fmtDate(s.created_at))}</td>
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

function bindDashboard() {
  document.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => setRoute(btn.dataset.jump));
  });
}

// ---------------- 2. POS & VENTES ----------------
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

          ${
            filteredProducts.length === 0
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

        ${
          sale && totalCartItems > 0
            ? `<div class="mobile-pos-jump">
                <button id="btn-mobile-jump-ticket" type="button" class="btn btn-primary btn-full" style="box-shadow: var(--shadow-md);">
                  Voir ticket (${esc(fmtQty(totalCartItems))} art.) • ${esc(fmtMoney(summary.total, cur))}
                </button>
              </div>`
            : ''
        }

        <div class="card">
          <div class="section-head">
            <h3>Ventes récentes</h3>
            <button id="btn-new-sale" type="button" class="btn btn-outline btn-sm">+ Nouveau ticket</button>
          </div>
          <div class="table-wrap">
            <table class="responsive-table">
              <thead><tr><th>Facture</th><th>Articles</th><th>Total</th><th>Encaissé</th><th>Statut</th><th>Actions</th></tr></thead>
              <tbody>
                ${
                  state.sales.length === 0
                    ? '<tr><td colspan="6" class="muted-text">Aucune vente enregistrée.</td></tr>'
                    : state.sales
                        .map(
                          (s) => `<tr>
                            <td data-label="Facture" class="mono"><strong>${esc(s.invoice_number)}</strong></td>
                            <td data-label="Articles" class="mono">${esc(s.total_items_count)}</td>
                            <td data-label="Total" class="mono">${esc(fmtMoney(s.total_amount, cur))}</td>
                            <td data-label="Encaissé" class="mono">${esc(fmtMoney(s.paid_amount, cur))}</td>
                            <td data-label="Statut">${statusBadge(s.status)}</td>
                            <td data-label="Actions">
                              <div class="toolbar" style="justify-content:flex-end;">
                                <button class="btn btn-outline btn-sm" data-select-sale="${esc(s.id)}" type="button">Ouvrir</button>
                                ${
                                  s.status === 'completed'
                                    ? `<button class="btn btn-outline btn-sm" data-receipt-sale="${esc(s.id)}" type="button">Ticket</button>`
                                    : ''
                                }
                                ${
                                  s.status !== 'cancelled'
                                    ? `<button class="btn btn-danger btn-sm" data-cancel-sale="${esc(s.id)}" type="button">Annuler</button>`
                                    : ''
                                }
                              </div>
                            </td>
                          </tr>`
                        )
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
            <span class="muted-text">${sale ? statusBadge(sale.status) : 'Sélectionnez un article'}</span>
          </div>
          ${
            sale && sale.status === 'completed'
              ? `<button class="btn btn-outline btn-sm" data-receipt-sale="${esc(sale.id)}" type="button">Imprimer Reçu</button>`
              : ''
          }
        </div>

        ${
          !state.cashCurrent
            ? `<div class="alert-callout">
                <span>Caisse fermée : requise pour paiements espèces.</span>
                <button id="btn-pos-open-cash" type="button" class="btn btn-amber btn-sm">Ouvrir</button>
              </div>`
            : ''
        }

        ${
          !sale
            ? '<p class="muted-text">Touchez un produit sur la carte pour ouvrir automatiquement une commande.</p>'
            : `
              <div>
                ${
                  (sale.items || []).length === 0
                    ? '<p class="muted-text">Ticket vide — touchez un produit pour l\'ajouter.</p>'
                    : sale.items
                        .map(
                          (it) => `<div class="ticket-item">
                            <div class="ticket-item-info">
                              <div class="ticket-item-name">${esc(it.product_name)}</div>
                              <div class="muted-text mono">${esc(fmtMoney(it.unit_price, cur))} / ${esc(it.unit)}</div>
                            </div>
                            <div class="toolbar">
                              ${
                                sale.status === 'pending'
                                  ? `<div class="qty-stepper">
                                      <button type="button" class="qty-btn" data-step-item="${esc(it.id)}" data-prod="${esc(it.product_id)}" data-qty="${esc(it.quantity)}" data-price="${esc(it.unit_price)}" data-delta="-1">−</button>
                                      <span class="qty-val">${esc(fmtQty(it.quantity))}</span>
                                      <button type="button" class="qty-btn" data-step-item="${esc(it.id)}" data-prod="${esc(it.product_id)}" data-qty="${esc(it.quantity)}" data-price="${esc(it.unit_price)}" data-delta="1">+</button>
                                    </div>`
                                  : `<span class="mono">x${esc(fmtQty(it.quantity))}</span>`
                              }
                              <span class="mono" style="min-width:74px;text-align:right;"><strong>${esc(fmtMoney(it.subtotal, cur))}</strong></span>
                              ${
                                sale.status === 'pending'
                                  ? `<button class="btn btn-danger btn-sm" data-del-sale-item="${esc(it.id)}" type="button" aria-label="Retirer">&times;</button>`
                                  : ''
                              }
                            </div>
                          </div>`
                        )
                        .join('')
                }
              </div>

              ${
                sale.status === 'pending'
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

              ${
                (sale.payments || []).length > 0
                  ? `<div class="muted-text" style="font-size:12px;">
                      <strong>Règlements :</strong>
                      ${sale.payments
                        .map((p) => `<div>• ${esc(methodLabel(p.payment_method))} : <span class="mono">${esc(fmtMoney(p.amount, cur))}</span></div>`)
                        .join('')}
                    </div>`
                  : ''
              }

              ${
                sale.status === 'pending'
                  ? `<form id="sale-payment-form" class="form-stack">
                      <div class="field">
                        <label>Mode de règlement</label>
                        <div class="method-pills">
                          ${['cash', 'card', 'mobile_money', 'transfer', 'check', 'other']
                            .map(
                              (m) => `<button type="button" class="method-pill ${state.payMethod === m ? 'active' : ''}" data-pay-method="${m}">${esc(methodLabel(m))}</button>`
                            )
                            .join('')}
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
                  : ''
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
    openModal(
      `Ticket de caisse • ${r.receiptHeader.invoiceNumber}`,
      `
        <div class="receipt-paper">
          <div style="text-align:center;margin-bottom:12px;">
            <strong style="font-size:15px;">${esc(r.company.name)}</strong><br/>
            <span>Facture : ${esc(r.receiptHeader.invoiceNumber)}</span><br/>
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
                <span>${esc(methodLabel(p.method))}</span>
                <span>${esc(fmtMoney(p.amount, cur))}</span>
              </div>`
            )
            .join('')}
        </div>
        <div class="toolbar" style="margin-top:14px;justify-content:flex-end;">
          <button type="button" class="btn btn-primary" onclick="window.print()">Imprimer</button>
        </div>
      `
    );
  } catch (err) {
    showToast(err.message, 'error');
  }
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

  document.querySelectorAll('[data-pay-method]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.payMethod = btn.dataset.payMethod;
      document.querySelectorAll('[data-pay-method]').forEach((b) => {
        b.classList.toggle('active', b.dataset.payMethod === state.payMethod);
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
      await apiFetch(`/api/sales/${state.activeSale.id}/payments`, {
        method: 'POST',
        body: { amount, paymentMethod: state.payMethod },
      });
      showToast('Paiement enregistré', 'success');
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

  return `
    <div class="subtabs">
      <button class="subtab ${sub === 'products' ? 'active' : ''}" data-cat-tab="products" type="button">Produits (${state.products.length})</button>
      <button class="subtab ${sub === 'categories' ? 'active' : ''}" data-cat-tab="categories" type="button">Catégories (${state.categories.length})</button>
      <button class="subtab ${sub === 'recipes' ? 'active' : ''}" data-cat-tab="recipes" type="button">Recettes (${state.recipes.length})</button>
    </div>

    ${
      sub === 'products'
        ? `<div class="two-col">
            <div class="card">
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
                    <label>Prix de vente</label>
                    <input id="prod-sell" type="number" step="0.01" min="0" value="0" />
                  </div>
                  <div class="field">
                    <label>Coût unitaire initial</label>
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
            </div>

            <div class="card">
              <div class="section-head"><h3>Catalogue produits</h3></div>
              <div class="table-wrap">
                <table class="responsive-table">
                  <thead><tr><th>Nom</th><th>Suivi</th><th>Prix Vente</th><th>PMP</th><th>Stock</th></tr></thead>
                  <tbody>
                    ${
                      state.products.length === 0
                        ? '<tr><td colspan="5" class="muted-text">Aucun produit enregistré.</td></tr>'
                        : state.products
                            .map(
                              (p) => `<tr>
                                <td data-label="Produit"><strong>${esc(p.name)}</strong><div class="muted-text" style="font-size:11px;">${esc(p.category_name || '—')}</div></td>
                                <td data-label="Suivi"><span class="status-pill status-neutral">${esc(p.inventory_tracking)}</span></td>
                                <td data-label="Prix Vente" class="mono">${esc(fmtMoney(p.selling_price, cur))}</td>
                                <td data-label="PMP" class="mono">${esc(fmtMoney(p.cost_price, cur))}</td>
                                <td data-label="Stock" class="mono">${p.inventory_tracking === 'none' ? '—' : esc(fmtQty(p.current_stock) + ' ' + p.unit)}</td>
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

    ${
      sub === 'categories'
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
                    ${
                      state.categories.length === 0
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

    ${
      sub === 'recipes'
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
              ${
                state.recipes.length === 0
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

  document.getElementById('product-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const catId = document.getElementById('prod-cat').value;
      await apiFetch('/api/catalog/products', {
        method: 'POST',
        body: {
          categoryId: catId || undefined,
          name: document.getElementById('prod-name').value,
          productType: document.getElementById('prod-type').value,
          inventoryTracking: document.getElementById('prod-tracking').value,
          sellingPrice: parseFloat(document.getElementById('prod-sell').value || '0'),
          costPrice: parseFloat(document.getElementById('prod-cost').value || '0'),
          unit: document.getElementById('prod-unit').value || 'unit',
          minStockAlert: parseFloat(document.getElementById('prod-alert').value || '0'),
        },
      });
      showToast('Produit ajouté au catalogue', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
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
              ${
                state.movements.length === 0
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
            ${
              filtered.length === 0
                ? '<tr><td colspan="6" class="muted-text">Aucun niveau de stock enregistré.</td></tr>'
                : filtered
                    .map(
                      (lv) => `<tr>
                        <td data-label="Produit"><strong>${esc(lv.product_name)}</strong></td>
                        <td data-label="Quantité" class="mono">${esc(fmtQty(lv.current_quantity))} ${esc(lv.unit)}</td>
                        <td data-label="Seuil" class="mono">${esc(fmtQty(lv.min_stock_alert))}</td>
                        <td data-label="PMP" class="mono">${esc(fmtMoney(lv.pmp, cur))}</td>
                        <td data-label="Valorisation" class="mono">${esc(fmtMoney(lv.stock_valuation, cur))}</td>
                        <td data-label="Statut">${
                          lv.is_low_stock
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

    ${
      sub === 'orders'
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
                      ${
                        state.purchases.length === 0
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
              ${
                !ap
                  ? '<p class="muted-text">Sélectionnez ou créez une commande pour y ajouter des articles et la réceptionner (calcul du PMP).</p>'
                  : `
                    <p class="muted-text" style="margin-bottom:12px;">Fournisseur : <strong>${esc(ap.supplier_name || 'Non spécifié')}</strong> • Total : <strong class="mono">${esc(fmtMoney(ap.total_amount, cur))}</strong></p>
                    <div class="table-wrap" style="margin-bottom:14px;">
                      <table class="responsive-table">
                        <thead><tr><th>Produit</th><th>Qté</th><th>Coût unit.</th><th>Sous-total</th><th></th></tr></thead>
                        <tbody>
                          ${
                            (ap.items || []).length === 0
                              ? '<tr><td colspan="5" class="muted-text">Aucune ligne ajoutée.</td></tr>'
                              : ap.items
                                  .map(
                                    (it) => `<tr>
                                      <td data-label="Produit"><strong>${esc(it.product_name)}</strong></td>
                                      <td data-label="Qté" class="mono">${esc(fmtQty(it.quantity))} ${esc(it.unit)}</td>
                                      <td data-label="Coût unit." class="mono">${esc(fmtMoney(it.unit_cost, cur))}</td>
                                      <td data-label="Sous-total" class="mono">${esc(fmtMoney(it.subtotal, cur))}</td>
                                      <td data-label="Action">${
                                        ap.status === 'ordered' || ap.status === 'draft'
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

                    ${
                      ap.status === 'ordered' || ap.status === 'draft'
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
                    ${
                      state.suppliers.length === 0
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

// ---------------- 6. TRÉSORERIE & CAISSE ----------------
function renderCash() {
  const cur = CURRENCY();
  const cs = state.cashCurrent;

  return `
    ${
      !cs
        ? `<div class="card" style="max-width:520px;">
            <div class="section-head"><h3>Ouvrir une session de caisse</h3></div>
            <p class="muted-text" style="margin-bottom:14px;">Aucune session active. Saisissez le fond de caisse initial pour encaisser en espèces.</p>
            <form id="cash-open-form" class="form-stack">
              <div class="field">
                <label>Fond de caisse initial (${esc(cur)})</label>
                <input id="cash-opening-amount" type="number" step="0.01" min="0" value="50000" required />
              </div>
              <button type="submit" class="btn btn-primary">Ouvrir la caisse</button>
            </form>
          </div>`
        : `<div class="kpi-grid">
            <div class="card kpi-card">
              <div class="kpi-label">Fond initial</div>
              <div class="kpi-value">${esc(fmtMoney(cs.openingAmount, cur))}</div>
              <div class="kpi-foot">Ouverte le ${esc(fmtDate(cs.opened_at))}</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Encaissements Espèces</div>
              <div class="kpi-value">${esc(fmtMoney(cs.metrics.cashIn, cur))}</div>
              <div class="kpi-foot">CB: ${esc(fmtMoney(cs.metrics.cardIn, cur))} • MM: ${esc(fmtMoney(cs.metrics.mobileMoneyIn, cur))}</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Dépenses &amp; Remb. Cash</div>
              <div class="kpi-value">${esc(fmtMoney(cs.metrics.totalExpenses + cs.metrics.cashRefunds, cur))}</div>
              <div class="kpi-foot">Dépenses: ${esc(fmtMoney(cs.metrics.totalExpenses, cur))}</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Solde théorique tiroir</div>
              <div class="kpi-value" style="color:var(--success)">${esc(fmtMoney(cs.metrics.theoreticalCashInDrawer, cur))}</div>
              <div class="kpi-foot">Calcul réconcilié en direct</div>
            </div>
          </div>

          <div class="two-col">
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
              <div class="section-head"><h3>Clôturer la session de caisse</h3></div>
              <form id="cash-close-form" class="form-stack">
                <div class="field">
                  <label>Montant réel compté dans le tiroir (${esc(cur)})</label>
                  <input id="cash-actual-amount" type="number" step="0.01" min="0" required value="${cs.metrics.theoreticalCashInDrawer}" />
                </div>
                <p class="muted-text">Solde théorique attendu : <strong class="mono">${esc(fmtMoney(cs.metrics.theoreticalCashInDrawer, cur))}</strong></p>
                <button type="submit" class="btn btn-danger">Clôturer définitivement la caisse</button>
              </form>
            </div>
          </div>`
    }

    <div class="two-col">
      <div class="card">
        <div class="section-head"><h3>Historique des sessions</h3></div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Ouverture</th><th>Attendu</th><th>Réel</th><th>Écart</th><th>Statut</th><th></th></tr></thead>
            <tbody>
              ${
                state.cashSessions.length === 0
                  ? '<tr><td colspan="6" class="muted-text">Aucune session.</td></tr>'
                  : state.cashSessions
                      .map(
                        (s) => `<tr>
                          <td data-label="Ouverture">${esc(fmtDate(s.opened_at))}</td>
                          <td data-label="Attendu" class="mono">${s.expected_closing_amount !== null ? esc(fmtMoney(s.expected_closing_amount, cur)) : '—'}</td>
                          <td data-label="Réel" class="mono">${s.actual_closing_amount !== null ? esc(fmtMoney(s.actual_closing_amount, cur)) : '—'}</td>
                          <td data-label="Écart" class="mono">${s.difference_amount !== null ? esc(fmtMoney(s.difference_amount, cur)) : '—'}</td>
                          <td data-label="Statut">${statusBadge(s.status)}</td>
                          <td data-label="Détail"><button class="btn btn-outline btn-sm" data-cash-detail="${esc(s.id)}" type="button">Détail</button></td>
                        </tr>`
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="section-head"><h3>Dépenses récentes</h3></div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>Catégorie</th><th>Montant</th><th>Motif</th><th>Date</th></tr></thead>
            <tbody>
              ${
                state.expenses.length === 0
                  ? '<tr><td colspan="4" class="muted-text">Aucune dépense enregistrée.</td></tr>'
                  : state.expenses
                      .map(
                        (ex) => `<tr>
                          <td data-label="Catégorie"><strong>${esc(ex.category)}</strong></td>
                          <td data-label="Montant" class="mono">${esc(fmtMoney(ex.amount, cur))}</td>
                          <td data-label="Motif">${esc(ex.description)}</td>
                          <td data-label="Date">${esc(fmtDate(ex.created_at))}</td>
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
  document.getElementById('cash-open-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/cash/sessions/open', {
        method: 'POST',
        body: { openingAmount: parseFloat(document.getElementById('cash-opening-amount').value || '0') },
      });
      showToast('Session de caisse ouverte', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('expense-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/cash/expenses', {
        method: 'POST',
        body: {
          cashSessionId: state.cashCurrent.id,
          category: document.getElementById('exp-cat').value,
          amount: parseFloat(document.getElementById('exp-amount').value),
          description: document.getElementById('exp-desc').value,
        },
      });
      showToast('Dépense enregistrée', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('cash-close-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch(`/api/cash/sessions/${state.cashCurrent.id}/close`, {
        method: 'POST',
        body: { actualAmount: parseFloat(document.getElementById('cash-actual-amount').value) },
      });
      const diff = parseFloat(res.data.difference_amount || 0);
      showToast(`Caisse clôturée (écart : ${fmtMoney(diff, CURRENCY())})`, 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-cash-detail]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/cash/sessions/${btn.dataset.cashDetail}`);
        const d = res.data;
        const cur = CURRENCY();
        openModal(
          `Détail Session (${d.status === 'open' ? 'Ouverte' : 'Clôturée'})`,
          `<div class="form-stack">
            <div><strong>Ouverte par :</strong> ${esc(d.opened_by_name || '—')} (${esc(fmtDate(d.opened_at))})</div>
            <div><strong>Fond initial :</strong> <span class="mono">${esc(fmtMoney(d.opening_amount, cur))}</span></div>
            <div><strong>Paiements (${(d.payments || []).length}) :</strong></div>
            <ul style="margin:0;padding-left:18px;font-size:12px;">
              ${(d.payments || [])
                .map((p) => `<li>${esc(p.invoice_number || '')} • ${esc(methodLabel(p.payment_method))} : ${esc(fmtMoney(p.amount, cur))}</li>`)
                .join('') || '<li>Aucun paiement</li>'}
            </ul>
            <div><strong>Dépenses (${(d.expenses || []).length}) :</strong></div>
            <ul style="margin:0;padding-left:18px;font-size:12px;">
              ${(d.expenses || [])
                .map((ex) => `<li>${esc(ex.category)} (${esc(ex.description)}) : ${esc(fmtMoney(ex.amount, cur))}</li>`)
                .join('') || '<li>Aucune dépense</li>'}
            </ul>
          </div>`
        );
      } catch (err) {
        showToast(err.message, 'error');
      }
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
    const suffix = Date.now().toString().slice(-6);
    const reg = await apiFetch('/api/auth/register', {
      skipAuth: true,
      method: 'POST',
      body: {
        companyName: 'Le Palais Gourmand (Démo)',
        businessType: 'both',
        currency: 'XOF',
        email: `demo_${suffix}@restogest.sn`,
        password: 'DemoPassword2026!',
        fullName: 'Chef Amadou',
      },
    });
    setToken(reg.data.token);

    await apiFetch('/api/cash/sessions/open', { method: 'POST', body: { openingAmount: 50000 } });

    const [catBoissons, catPatisserie, catIng] = await Promise.all([
      apiFetch('/api/catalog/categories', { method: 'POST', body: { name: 'Boissons' } }),
      apiFetch('/api/catalog/categories', { method: 'POST', body: { name: 'Pâtisseries' } }),
      apiFetch('/api/catalog/categories', { method: 'POST', body: { name: 'Matières Premières' } }),
    ]);

    const [pGrain, pFarine, pSucre, pEspresso, pCroissant] = await Promise.all([
      apiFetch('/api/catalog/products', {
        method: 'POST',
        body: {
          categoryId: catIng.data.id,
          name: 'Grains Café Arabica',
          productType: 'raw_material',
          unit: 'kg',
          costPrice: 8000,
          inventoryTracking: 'direct',
          minStockAlert: 2,
        },
      }),
      apiFetch('/api/catalog/products', {
        method: 'POST',
        body: {
          categoryId: catIng.data.id,
          name: 'Farine Pâtissière T55',
          productType: 'raw_material',
          unit: 'kg',
          costPrice: 600,
          inventoryTracking: 'direct',
          minStockAlert: 5,
        },
      }),
      apiFetch('/api/catalog/products', {
        method: 'POST',
        body: {
          categoryId: catIng.data.id,
          name: 'Sucre Fin',
          productType: 'raw_material',
          unit: 'kg',
          costPrice: 750,
          inventoryTracking: 'direct',
          minStockAlert: 5,
        },
      }),
      apiFetch('/api/catalog/products', {
        method: 'POST',
        body: {
          categoryId: catBoissons.data.id,
          name: 'Café Espresso',
          productType: 'finished_good',
          unit: 'tasse',
          sellingPrice: 1500,
          inventoryTracking: 'recipe_on_sale',
          minStockAlert: 0,
        },
      }),
      apiFetch('/api/catalog/products', {
        method: 'POST',
        body: {
          categoryId: catPatisserie.data.id,
          name: 'Croissant Pur Beurre',
          productType: 'finished_good',
          unit: 'pièce',
          sellingPrice: 900,
          costPrice: 350,
          inventoryTracking: 'direct',
          minStockAlert: 10,
        },
      }),
    ]);

    await apiFetch('/api/catalog/recipes', {
      method: 'POST',
      body: {
        finishedProductId: pEspresso.data.id,
        name: 'Extraction Espresso 20g',
        outputQuantity: 1,
        ingredients: [{ ingredientId: pGrain.data.id, quantityRequired: 0.02 }],
      },
    });

    const sup = await apiFetch('/api/purchases/suppliers', {
      method: 'POST',
      body: { name: 'Grands Moulins & Torréfaction', phone: '+221 77 000 00 00' },
    });

    const purch = await apiFetch('/api/purchases', {
      method: 'POST',
      body: { supplierId: sup.data.id, reference: `ACH-DEMO-${suffix}`, notes: 'Dotation initiale démo' },
    });

    await Promise.all([
      apiFetch(`/api/purchases/${purch.data.id}/items`, {
        method: 'POST',
        body: { productId: pGrain.data.id, quantity: 10, unitCost: 8500 },
      }),
      apiFetch(`/api/purchases/${purch.data.id}/items`, {
        method: 'POST',
        body: { productId: pFarine.data.id, quantity: 50, unitCost: 600 },
      }),
      apiFetch(`/api/purchases/${purch.data.id}/items`, {
        method: 'POST',
        body: { productId: pSucre.data.id, quantity: 4, unitCost: 750 },
      }),
    ]);

    await apiFetch(`/api/purchases/${purch.data.id}/receive`, { method: 'POST' });
    await apiFetch('/api/inventory/adjustments', {
      method: 'POST',
      body: {
        productId: pCroissant.data.id,
        movementType: 'production_in',
        quantityDelta: 30,
        notes: 'Fournée démo du matin',
      },
    });

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

  document.getElementById('btn-logout')?.addEventListener('click', async () => {
    try {
      await apiFetch('/api/auth/logout', { method: 'POST', ignoreUnauthorized: true });
    } catch {
      // ignore if already revoked
    }
    setToken(null);
    state.user = null;
    state.company = null;
    state.activeSale = null;
    state.activePurchase = null;
    toggleSidebar(false);
    showAuthView();
    showToast('Déconnecté en toute sécurité', 'success');
  });

  document.getElementById('login-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
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
      await refreshAllData();
      showToast('Connexion réussie !', 'success');
      showAppView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('register-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const res = await apiFetch('/api/auth/register', {
        skipAuth: true,
        method: 'POST',
        body: {
          companyName: document.getElementById('reg-company').value,
          businessType: document.getElementById('reg-type').value,
          currency: document.getElementById('reg-currency').value,
          fullName: document.getElementById('reg-fullname').value,
          email: document.getElementById('reg-email').value,
          password: document.getElementById('reg-password').value,
        },
      });
      setToken(res.data.token);
      await refreshAllData();
      showToast('Établissement créé avec succès !', 'success');
      showAppView();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  await loadHealth();

  if (getToken()) {
    try {
      await refreshAllData();
      showAppView();
      return;
    } catch {
      setToken(null);
    }
  }
  showAuthView();
}

init();
