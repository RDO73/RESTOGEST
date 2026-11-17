import { esc, fmtDate, fmtMoney, showToast } from './api.js';

const SA_TOKEN_KEY = 'restogest_super_admin_token';

const state = {
  token: localStorage.getItem(SA_TOKEN_KEY) || null,
  subtab: 'pending',
  countryFilter: '',
  statusFilter: '',
  overview: null,
  establishments: [],
};

async function saFetch(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      if (!opts.skipAuthReset) {
        setAdminToken(null);
        showLoginView();
      }
    }
    throw new Error(data?.error?.message || data?.error || 'Erreur serveur');
  }
  return data;
}

function setAdminToken(token) {
  state.token = token;
  if (token) localStorage.setItem(SA_TOKEN_KEY, token);
  else localStorage.removeItem(SA_TOKEN_KEY);
}

function showLoginView() {
  document.getElementById('admin-login-view')?.classList.remove('hidden');
  document.getElementById('admin-app-view')?.classList.add('hidden');
}

function showAppView() {
  document.getElementById('admin-login-view')?.classList.add('hidden');
  document.getElementById('admin-app-view')?.classList.remove('hidden');
}

function statusPill(status) {
  const labels = {
    active: 'Actif',
    trial: 'Essai',
    pending_payment: 'En attente',
    pending: 'En attente',
    confirmed: 'Validé',
    failed: 'Refusé',
    refunded: 'Remboursé',
    expired: 'Expiré',
    past_due: 'Impayé',
    suspended: 'Suspendu',
  };
  const cls =
    status === 'active' || status === 'confirmed'
      ? 'status-open'
      : status === 'pending' || status === 'pending_payment' || status === 'trial'
        ? 'status-pending'
        : 'status-closed';
  return `<span class="status-pill ${cls}">${esc(labels[status] || status)}</span>`;
}

async function loadAdminData() {
  if (!state.token) return;
  const [ovRes, estRes] = await Promise.all([
    saFetch(`/api/subscriptions/admin/overview?countryCode=${encodeURIComponent(state.countryFilter)}`),
    saFetch(`/api/admin/establishments?countryCode=${encodeURIComponent(state.countryFilter)}&status=${encodeURIComponent(state.statusFilter)}`),
  ]);
  state.overview = ovRes.data;
  state.establishments = estRes.data || [];
  renderAdminDashboard();
}

function renderAdminDashboard() {
  const root = document.getElementById('admin-main-content');
  if (!root || !state.overview) return;

  const ov = state.overview;
  const mc = ov.multiCurrency || {};
  const byCur = mc.totalsByCurrency || [];
  const xofStats = byCur.find((c) => c.currency === 'XOF') || { grossConfirmed: 0, pendingAmount: 0, confirmedCount: 0, pendingCount: 0 };
  const gnfStats = byCur.find((c) => c.currency === 'GNF') || { grossConfirmed: 0, pendingAmount: 0, confirmedCount: 0, pendingCount: 0 };
  const txs = ov.transactions || [];
  const pendingTxs = txs.filter((t) => t.status === 'pending');
  const establishments = state.establishments || [];
  const receptionAccounts = ov.receptionAccounts || [];

  root.innerHTML = `
    <div class="kpi-grid" style="margin-bottom:20px;">
      <div class="card kpi-card">
        <div class="kpi-label">🇸🇳 Sénégal (XOF — FCFA)</div>
        <div class="kpi-value" style="color:var(--success)">${esc(fmtMoney(xofStats.grossConfirmed, 'XOF'))}</div>
        <div class="kpi-foot">${xofStats.confirmedCount} validé(s) • En attente : ${esc(fmtMoney(xofStats.pendingAmount, 'XOF'))}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">🇬🇳 Guinée (GNF — Franc Guinéen)</div>
        <div class="kpi-value" style="color:var(--primary)">${esc(fmtMoney(gnfStats.grossConfirmed, 'GNF'))}</div>
        <div class="kpi-foot">${gnfStats.confirmedCount} validé(s) • En attente : ${esc(fmtMoney(gnfStats.pendingAmount, 'GNF'))}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Établissements Inscrits</div>
        <div class="kpi-value">${establishments.length}</div>
        <div class="kpi-foot">
          Actifs: ${ov.kpis?.activeSubscriptionsCount || 0} • Essai: ${ov.kpis?.trialSubscriptionsCount || 0} • Expirés: ${ov.kpis?.expiredOrSuspendedCount || 0}
        </div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Abonnements à Valider</div>
        <div class="kpi-value" style="color:${pendingTxs.length > 0 ? '#f59e0b' : 'var(--success)'}">${pendingTxs.length}</div>
        <div class="kpi-foot">Wave, Orange Money &amp; Carte UBA</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
        <div class="subtabs" style="margin:0;">
          <button type="button" class="subtab ${state.subtab === 'pending' ? 'active' : ''}" data-sa-tab="pending">
            ⏳ Paiements à Valider (${pendingTxs.length})
          </button>
          <button type="button" class="subtab ${state.subtab === 'establishments' ? 'active' : ''}" data-sa-tab="establishments">
            🏢 Établissements (${establishments.length})
          </button>
          <button type="button" class="subtab ${state.subtab === 'history' ? 'active' : ''}" data-sa-tab="history">
            💳 Historique Complet (${txs.length})
          </button>
          <button type="button" class="subtab ${state.subtab === 'reception' ? 'active' : ''}" data-sa-tab="reception">
            📱 Comptes Marchands &amp; Tarifs
          </button>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <select id="adm-flt-country" class="input-inline" style="max-width:160px;">
            <option value="" ${state.countryFilter === '' ? 'selected' : ''}>🇸🇳🇬🇳 Tous (SN &amp; GN)</option>
            <option value="SN" ${state.countryFilter === 'SN' ? 'selected' : ''}>🇸🇳 Sénégal (XOF)</option>
            <option value="GN" ${state.countryFilter === 'GN' ? 'selected' : ''}>🇬🇳 Guinée (GNF)</option>
          </select>
        </div>
      </div>
    </div>

    ${
      state.subtab === 'pending'
        ? `
          <div class="card">
            <div class="section-head"><h3>Validation des Paiements d'Abonnement (Wave, Orange Money, UBA)</h3></div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead>
                  <tr><th>Date / Réf.</th><th>Établissement</th><th>Pays</th><th>Formule</th><th>Montant</th><th>Moyen / Réf. Client</th><th>Décision</th></tr>
                </thead>
                <tbody>
                  ${
                    pendingTxs.length === 0
                      ? '<tr><td colspan="7" class="muted-text">Aucun paiement en attente de validation.</td></tr>'
                      : pendingTxs
                          .map(
                            (tx) => `<tr>
                              <td class="mono"><strong>${esc(tx.transaction_ref)}</strong><div class="muted-text" style="font-size:11px;">${esc(fmtDate(tx.created_at))}</div></td>
                              <td><strong>${esc(tx.company_name)}</strong><div class="muted-text" style="font-size:11px;">${esc(tx.payer_phone || '')}</div></td>
                              <td>${tx.country_code === 'GN' ? '🇬🇳 Guinée' : '🇸🇳 Sénégal'}</td>
                              <td>${esc(tx.plan_code)} (${esc(tx.billing_period)})</td>
                              <td class="mono"><strong>${esc(fmtMoney(tx.gross_amount, tx.currency))}</strong></td>
                              <td>${esc(tx.payment_method)} <div class="mono" style="font-size:11px;color:#fdba74;">${esc(tx.manual_reference || '—')}</div></td>
                              <td>
                                <div style="display:flex;gap:6px;">
                                  <button type="button" class="btn btn-success btn-sm" data-adm-confirm="${esc(tx.id)}">✓ Valider</button>
                                  <button type="button" class="btn btn-danger btn-sm" data-adm-reject="${esc(tx.id)}">✕ Refuser</button>
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
        `
        : ''
    }

    ${
      state.subtab === 'establishments'
        ? `
          <div class="card">
            <div class="section-head">
              <h3>Liste des Établissements Inscrits (Sénégal &amp; Guinée)</h3>
              <select id="adm-flt-status" class="input-inline" style="max-width:160px;">
                <option value="" ${state.statusFilter === '' ? 'selected' : ''}>Tous les statuts</option>
                <option value="active" ${state.statusFilter === 'active' ? 'selected' : ''}>Actif</option>
                <option value="pending_payment" ${state.statusFilter === 'pending_payment' ? 'selected' : ''}>En attente</option>
                <option value="trial" ${state.statusFilter === 'trial' ? 'selected' : ''}>Essai</option>
                <option value="expired" ${state.statusFilter === 'expired' ? 'selected' : ''}>Expiré</option>
              </select>
            </div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead>
                  <tr><th>Établissement</th><th>Gérant</th><th>Pays / Devise</th><th>Plan</th><th>Statut</th><th>Échéance</th><th>Action</th></tr>
                </thead>
                <tbody>
                  ${
                    establishments.length === 0
                      ? '<tr><td colspan="7" class="muted-text">Aucun établissement trouvé.</td></tr>'
                      : establishments
                          .map(
                            (e) => `<tr>
                              <td><strong>${esc(e.name)}</strong><div class="muted-text" style="font-size:11px;">Inscrit le ${esc(fmtDate(e.created_at))}</div></td>
                              <td>${esc(e.owner_name || '—')}<div class="muted-text" style="font-size:11px;">${esc(e.owner_email || '')}</div></td>
                              <td>${e.country_code === 'GN' ? '🇬🇳 Guinée (GNF)' : '🇸🇳 Sénégal (XOF)'}</td>
                              <td>${esc(e.plan_code)} (${esc(e.billing_period)})</td>
                              <td>${statusPill(e.subscription_status)}</td>
                              <td>${e.current_period_end ? esc(fmtDate(e.current_period_end)) : '—'}</td>
                              <td>
                                ${
                                  e.subscription_id
                                    ? `<div style="display:flex;gap:6px;flex-wrap:wrap;">
                                        <button type="button" class="btn btn-success btn-sm" data-adm-activate-sub="${esc(e.subscription_id)}">Activer +30j</button>
                                        <button type="button" class="btn btn-outline btn-sm" data-adm-expire-sub="${esc(e.subscription_id)}">Expirer</button>
                                      </div>`
                                    : '<span class="muted-text">—</span>'
                                }
                              </td>
                            </tr>`
                          )
                          .join('')
                  }
                </tbody>
              </table>
            </div>
          </div>
        `
        : ''
    }

    ${
      state.subtab === 'history'
        ? `
          <div class="card">
            <div class="section-head"><h3>Historique des Transactions SaaS</h3></div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead><tr><th>Réf.</th><th>Établissement</th><th>Pays</th><th>Montant</th><th>Moyen</th><th>Statut</th></tr></thead>
                <tbody>
                  ${txs
                    .map(
                      (tx) => `<tr>
                        <td class="mono"><strong>${esc(tx.transaction_ref)}</strong><div class="muted-text" style="font-size:10px;">${esc(fmtDate(tx.created_at))}</div></td>
                        <td><strong>${esc(tx.company_name)}</strong></td>
                        <td>${tx.country_code === 'GN' ? '🇬🇳 GN' : '🇸🇳 SN'}</td>
                        <td class="mono">${esc(fmtMoney(tx.gross_amount, tx.currency))}</td>
                        <td>${esc(tx.payment_method)} ${tx.manual_reference ? `(${esc(tx.manual_reference)})` : ''}</td>
                        <td>${statusPill(tx.status)}</td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>
        `
        : ''
    }

    ${
      state.subtab === 'reception'
        ? `
          <div class="card">
            <div class="section-head"><h3>Moyens de Réception Propriétaire RESTOGEST</h3></div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead><tr><th>Pays</th><th>Libellé</th><th>Numéro Marchand / IBAN</th><th>Devise</th><th>Statut</th></tr></thead>
                <tbody>
                  ${receptionAccounts
                    .map(
                      (ra) => `<tr>
                        <td><strong>${esc(ra.country_code)}</strong></td>
                        <td>${esc(ra.account_label)}</td>
                        <td class="mono"><strong>${esc(ra.merchant_number_or_iban)}</strong></td>
                        <td>${esc(ra.currency_code)}</td>
                        <td>${statusPill('pending')}</td>
                      </tr>`
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>
        `
        : ''
    }
  `;

  root.querySelectorAll('[data-sa-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtab = btn.dataset.saTab;
      renderAdminDashboard();
    });
  });

  document.getElementById('adm-flt-country')?.addEventListener('change', async (e) => {
    state.countryFilter = e.target.value;
    await loadAdminData();
  });

  document.getElementById('adm-flt-status')?.addEventListener('change', async (e) => {
    state.statusFilter = e.target.value;
    await loadAdminData();
  });

  root.querySelectorAll('[data-adm-confirm]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await saFetch(`/api/subscriptions/admin/transactions/${btn.dataset.admConfirm}/confirm`, {
          method: 'POST',
          body: { note: 'Validé depuis Super-Admin /admin' },
        });
        showToast('Abonnement validé et activé !', 'success');
        await loadAdminData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  root.querySelectorAll('[data-adm-reject]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await saFetch(`/api/subscriptions/admin/transactions/${btn.dataset.admReject}/reject`, {
          method: 'POST',
          body: { reason: 'Paiement non reçu ou référence invalide' },
        });
        showToast('Paiement refusé', 'info');
        await loadAdminData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  root.querySelectorAll('[data-adm-activate-sub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await saFetch(`/api/subscriptions/admin/subscriptions/${btn.dataset.admActivateSub}/status`, {
          method: 'POST',
          body: { status: 'active', extendDays: 30, reason: 'Activation manuelle (+30j) depuis /admin' },
        });
        showToast('Établissement activé (+30 jours)', 'success');
        await loadAdminData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  root.querySelectorAll('[data-adm-expire-sub]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await saFetch(`/api/subscriptions/admin/subscriptions/${btn.dataset.admExpireSub}/status`, {
          method: 'POST',
          body: { status: 'expired', reason: 'Marqué expiré depuis /admin' },
        });
        showToast('Statut mis à jour sur Expiré', 'info');
        await loadAdminData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

document.getElementById('admin-login-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await saFetch('/api/admin/auth/login', {
      method: 'POST',
      skipAuthReset: true,
      body: {
        email: document.getElementById('sa-email').value.trim(),
        password: document.getElementById('sa-password').value,
      },
    });
    setAdminToken(res.data.token);
    showAppView();
    await loadAdminData();
    showToast('Bienvenue dans votre Espace Propriétaire', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

document.getElementById('btn-sa-refresh')?.addEventListener('click', () => loadAdminData());
document.getElementById('btn-sa-logout')?.addEventListener('click', async () => {
  try {
    await saFetch('/api/admin/auth/logout', { method: 'POST', skipAuthReset: true });
  } catch {
    // ignore
  }
  setAdminToken(null);
  showLoginView();
  showToast('Déconnecté de l’espace Super-Admin', 'info');
});

async function init() {
  if (state.token) {
    try {
      await saFetch('/api/admin/auth/me', { skipAuthReset: true });
      showAppView();
      await loadAdminData();
      return;
    } catch {
      setAdminToken(null);
    }
  }
  showLoginView();
}

init();
