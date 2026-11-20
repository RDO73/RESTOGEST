import { esc, fmtDate, fmtMoney, getCsrfToken, showToast } from './api.js';

// Nettoyage de l'ancien jeton localStorage (migration vers cookie HttpOnly)
try {
  localStorage.removeItem('restogest_super_admin_token');
} catch {
  // ignore
}

const state = {
  authenticated: false,
  subtab: 'pending',
  countryFilter: '',
  statusFilter: '',
  overview: null,
  establishments: [],
  users: [],
  auditLogs: [],
  lastCreatedDemo: null,
};

async function saFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new Error('Impossible de joindre le serveur RESTOGEST. Vérifiez votre connexion internet.');
  }

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

function setAdminToken(active) {
  state.authenticated = Boolean(active);
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
  if (!state.authenticated) return;
  const [ovRes, estRes, usrRes, auditRes] = await Promise.all([
    saFetch(`/api/subscriptions/admin/overview?countryCode=${encodeURIComponent(state.countryFilter)}`),
    saFetch(`/api/admin/establishments?countryCode=${encodeURIComponent(state.countryFilter)}&status=${encodeURIComponent(state.statusFilter)}`),
    saFetch(`/api/admin/users?countryCode=${encodeURIComponent(state.countryFilter)}`),
    saFetch('/api/admin/audit-logs?limit=80'),
  ]);
  state.overview = ovRes.data;
  state.establishments = estRes.data || [];
  state.users = usrRes.data || [];
  state.auditLogs = auditRes.data || [];
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
  const users = state.users || [];
  const auditLogs = state.auditLogs || [];
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
          <button type="button" class="subtab ${state.subtab === 'users' ? 'active' : ''}" data-sa-tab="users">
            👥 Utilisateurs (${users.length})
          </button>
          <button type="button" class="subtab ${state.subtab === 'audit' ? 'active' : ''}" data-sa-tab="audit">
            📋 Journaux (${auditLogs.length})
          </button>
          <button type="button" class="subtab ${state.subtab === 'control' ? 'active' : ''}" data-sa-tab="control">
            ⚙️ Centre de Contrôle Admin
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
          <div class="card" style="margin-bottom:16px;border-color:rgba(249,115,22,0.45);">
            <div class="section-head">
              <div>
                <h3 style="margin:0;">✨ Créer un compte / restaurant de démonstration</h3>
                <p class="muted-text" style="margin:4px 0 0;font-size:12px;">
                  Enregistrement immédiat dans PostgreSQL — le testeur peut se connecter tout de suite sur l'accueil.
                </p>
              </div>
            </div>
            <form id="form-sa-create-demo" class="form-stack" style="margin-top:12px;">
              <div class="field-row">
                <div class="field">
                  <label for="demo-company-name">Nom de l'établissement (mention « (Démo) » ajoutée auto.)</label>
                  <input id="demo-company-name" type="text" required minlength="2" placeholder="Ex: Restaurant Teranga (Démo)" />
                </div>
                <div class="field">
                  <label for="demo-email">E-mail de connexion</label>
                  <input id="demo-email" type="email" required placeholder="testeur@myrestogest.com" />
                </div>
              </div>
              <div class="field-row">
                <div class="field">
                  <label for="demo-password">Mot de passe provisoire (8 car. min.)</label>
                  <div style="display:flex;gap:6px;">
                    <input id="demo-password" type="text" required minlength="8" placeholder="DemoResto2026!" style="flex:1;" />
                    <button type="button" id="btn-gen-demo-pwd" class="btn btn-outline btn-sm">Aléatoire</button>
                  </div>
                </div>
                <div class="field">
                  <label for="demo-country">Pays &amp; Devise</label>
                  <select id="demo-country">
                    <option value="SN">🇸🇳 Sénégal (XOF — FCFA)</option>
                    <option value="GN">🇬🇳 Guinée (GNF — Franc Guinéen)</option>
                  </select>
                </div>
                <div class="field">
                  <label for="demo-status">Statut du compte</label>
                  <select id="demo-status">
                    <option value="trial">Essai (14 jours)</option>
                    <option value="active">Actif (30 jours)</option>
                  </select>
                </div>
              </div>
              <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <button type="submit" class="btn btn-primary">Créer l'accès Démo immédiatement</button>
              </div>
            </form>

            ${
              state.lastCreatedDemo
                ? `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.4);font-size:13px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                      <strong>✅ Compte démo prêt : ${esc(state.lastCreatedDemo.companyName)} (${esc(state.lastCreatedDemo.countryCode)} / ${esc(state.lastCreatedDemo.currency)})</strong>
                      <button type="button" id="btn-copy-demo-creds" class="btn btn-success btn-sm">📋 Copier les accès</button>
                    </div>
                    <div class="mono" style="margin-top:6px;font-size:12px;">
                      URL : ${esc(window.location.origin)}/ &nbsp;|&nbsp; E-mail : <strong>${esc(state.lastCreatedDemo.email)}</strong> &nbsp;|&nbsp; Mot de passe : <strong>${esc(state.lastCreatedDemo.password)}</strong> &nbsp;|&nbsp; Statut : ${esc(state.lastCreatedDemo.status)}
                    </div>
                  </div>`
                : ''
            }
          </div>

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
                              <td>${statusPill(e.is_active === false ? 'suspended' : e.subscription_status)}</td>
                              <td>${e.current_period_end ? esc(fmtDate(e.current_period_end)) : '—'}</td>
                              <td>
                                <div style="display:flex;gap:6px;flex-wrap:wrap;">
                                  ${
                                    e.subscription_id
                                      ? `<button type="button" class="btn btn-success btn-sm" data-adm-activate-sub="${esc(e.subscription_id)}">Activer +30j</button>
                                         <button type="button" class="btn btn-outline btn-sm" data-adm-expire-sub="${esc(e.subscription_id)}">Expirer</button>`
                                      : ''
                                  }
                                  ${
                                    e.is_active === false
                                      ? `<button type="button" class="btn btn-success btn-sm" data-adm-toggle-company="${esc(e.id)}" data-next-active="true">Réactiver</button>`
                                      : `<button type="button" class="btn btn-danger btn-sm" data-adm-toggle-company="${esc(e.id)}" data-next-active="false">Suspendre</button>`
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
                        <td>${statusPill(ra.is_active ? 'active' : 'expired')}</td>
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
      state.subtab === 'users'
        ? `
          <div class="card">
            <div class="section-head">
              <h3>Utilisateurs des Établissements &amp; Permissions (${users.length})</h3>
            </div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead>
                  <tr><th>Utilisateur</th><th>Établissement</th><th>Pays</th><th>Rôle / Permissions</th><th>Statut</th><th>Action</th></tr>
                </thead>
                <tbody>
                  ${
                    users.length === 0
                      ? '<tr><td colspan="6" class="muted-text">Aucun utilisateur enregistré.</td></tr>'
                      : users
                          .map((u) => {
                            const perms = u.role_permissions && typeof u.role_permissions === 'object'
                              ? (u.role_permissions.all ? 'Accès complet établissement' : Object.keys(u.role_permissions).join(', ') || 'Standard')
                              : 'Standard';
                            return `<tr>
                              <td><strong>${esc(u.full_name || '—')}</strong><div class="muted-text" style="font-size:11px;">${esc(u.email)}</div></td>
                              <td><strong>${esc(u.company_name || '—')}</strong></td>
                              <td>${u.country_code === 'GN' ? '🇬🇳 Guinée' : '🇸🇳 Sénégal'}</td>
                              <td><strong>${esc(u.role_name || 'Utilisateur')}</strong><div class="muted-text" style="font-size:11px;">${esc(perms)}</div></td>
                              <td>${statusPill(u.is_active ? 'active' : 'suspended')}</td>
                              <td>
                                ${
                                  u.is_active
                                    ? `<button type="button" class="btn btn-danger btn-sm" data-adm-toggle-user="${esc(u.id)}" data-next-active="false">Suspendre</button>`
                                    : `<button type="button" class="btn btn-success btn-sm" data-adm-toggle-user="${esc(u.id)}" data-next-active="true">Réactiver</button>`
                                }
                              </td>
                            </tr>`;
                          })
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
      state.subtab === 'audit'
        ? `
          <div class="card">
            <div class="section-head">
              <h3>Journaux d'Activité &amp; Sécurité (80 derniers événements)</h3>
            </div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead>
                  <tr><th>Date</th><th>Action</th><th>Cible</th><th>Établissement</th><th>Acteur</th></tr>
                </thead>
                <tbody>
                  ${
                    auditLogs.length === 0
                      ? '<tr><td colspan="5" class="muted-text">Aucun événement consigné pour le moment.</td></tr>'
                      : auditLogs
                          .map(
                            (ev) => `<tr>
                              <td class="mono" style="font-size:11px;">${esc(fmtDate(ev.created_at))}</td>
                              <td><strong>${esc(ev.action)}</strong></td>
                              <td class="mono" style="font-size:11px;">${esc(ev.table_name || '—')}</td>
                              <td>${esc(ev.company_name || 'Plateforme')}</td>
                              <td class="muted-text" style="font-size:11px;">${esc(ev.user_email || 'Système')}</td>
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
      state.subtab === 'control'
        ? `
          <div class="two-col">
            <div class="card">
              <div class="section-head"><h3>🧭 Actions &amp; Paramètres Essentiels Super-Admin</h3></div>
              <div class="form-stack" style="font-size:13px;">
                <div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
                  <div>
                    <strong>1. Créer un compte / restaurant Démo</strong>
                    <div class="muted-text" style="font-size:12px;">Génère un accès immédiat (Sénégal XOF ou Guinée GNF) pour votre informaticien ou un prospect.</div>
                  </div>
                  <button type="button" class="btn btn-primary btn-sm" data-sa-goto="establishments">Ouvrir</button>
                </div>
                <div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
                  <div>
                    <strong>2. Valider ou refuser les paiements reçus (${pendingTxs.length})</strong>
                    <div class="muted-text" style="font-size:12px;">Contrôle Wave (+221 78 897 93 42), Orange Money et Carte UBA avant activation.</div>
                  </div>
                  <button type="button" class="btn btn-outline btn-sm" data-sa-goto="pending">Voir (${pendingTxs.length})</button>
                </div>
                <div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
                  <div>
                    <strong>3. Piloter les établissements (+30j / Expirer)</strong>
                    <div class="muted-text" style="font-size:12px;">Prolongez manuellement un abonnement, vérifiez les dates d'échéance ou suspendez un compte.</div>
                  </div>
                  <button type="button" class="btn btn-outline btn-sm" data-sa-goto="establishments">Gérer (${establishments.length})</button>
                </div>
                <div style="padding:10px 12px;border:1px solid var(--border);border-radius:10px;">
                  <strong>4. Identifiants &amp; Sécurité du compte Propriétaire</strong>
                  <div class="muted-text" style="font-size:12px;margin-top:4px;">
                    Modifiables via les variables d'environnement Vercel : <code class="mono">SUPER_ADMIN_EMAIL</code> et <code class="mono">SUPER_ADMIN_PASSWORD</code>.
                  </div>
                </div>
              </div>
            </div>

            <div class="card">
              <div class="section-head"><h3>💱 Taux de change &amp; Tarifs Locaux (XOF / GNF)</h3></div>
              <form id="form-sa-exchange-rate" class="form-stack" style="margin-bottom:18px;padding-bottom:14px;border-bottom:1px solid var(--border);">
                <div class="field-row">
                  <div class="field">
                    <label for="sa-fx-rate">Taux 1 XOF → GNF</label>
                    <input id="sa-fx-rate" type="number" step="0.01" min="0.01" required value="${esc(String(mc.exchangeRates?.find((r) => r.base_currency === 'XOF' && r.target_currency === 'GNF')?.rate || 15))}" />
                  </div>
                  <div class="field">
                    <label for="sa-fx-source">Source</label>
                    <input id="sa-fx-source" type="text" required value="Référence Super-Admin" />
                  </div>
                </div>
                <button type="submit" class="btn btn-outline btn-sm">Mettre à jour le taux XOF → GNF</button>
              </form>

              <form id="form-sa-country-price" class="form-stack">
                <div class="field-row">
                  <div class="field">
                    <label for="sa-cp-country">Pays</label>
                    <select id="sa-cp-country">
                      <option value="SN">🇸🇳 Sénégal (XOF)</option>
                      <option value="GN">🇬🇳 Guinée (GNF)</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="sa-cp-plan">Plan</label>
                    <select id="sa-cp-plan">
                      <option value="ESSENTIEL">ESSENTIEL</option>
                      <option value="PRO" selected>PRO</option>
                      <option value="ENTREPRISE">ENTREPRISE</option>
                    </select>
                  </div>
                  <div class="field">
                    <label for="sa-cp-price">Prix mensuel local</label>
                    <input id="sa-cp-price" type="number" min="0" required placeholder="29000 ou 435000" />
                  </div>
                </div>
                <button type="submit" class="btn btn-primary btn-sm">Enregistrer le tarif mensuel local</button>
              </form>
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
      const ok = window.confirm('Confirmer la mise en statut « Expiré » pour cet établissement ?');
      if (!ok) return;
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

  root.querySelectorAll('[data-adm-toggle-company]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nextActive = btn.dataset.nextActive === 'true';
      const label = nextActive ? 'réactiver cet établissement' : 'suspendre cet établissement (les sessions en cours seront immédiatement coupées)';
      if (!window.confirm(`Confirmez-vous vouloir ${label} ?`)) return;
      try {
        await saFetch(`/api/admin/establishments/${btn.dataset.admToggleCompany}/status`, {
          method: 'POST',
          body: { isActive: nextActive, reason: nextActive ? 'Réactivation manuelle /admin' : 'Suspension manuelle /admin' },
        });
        showToast(nextActive ? 'Établissement réactivé' : 'Établissement suspendu', nextActive ? 'success' : 'info');
        await loadAdminData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  root.querySelectorAll('[data-adm-toggle-user]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const nextActive = btn.dataset.nextActive === 'true';
      const label = nextActive ? 'réactiver ce compte utilisateur' : 'suspendre ce compte utilisateur';
      if (!window.confirm(`Confirmez-vous vouloir ${label} ?`)) return;
      try {
        await saFetch(`/api/admin/users/${btn.dataset.admToggleUser}/status`, {
          method: 'POST',
          body: { isActive: nextActive, reason: nextActive ? 'Réactivation manuelle /admin' : 'Suspension manuelle /admin' },
        });
        showToast(nextActive ? 'Utilisateur réactivé' : 'Utilisateur suspendu', nextActive ? 'success' : 'info');
        await loadAdminData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  root.querySelectorAll('[data-sa-goto]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtab = btn.dataset.saGoto;
      renderAdminDashboard();
    });
  });

  document.getElementById('btn-gen-demo-pwd')?.addEventListener('click', () => {
    const pwdInput = document.getElementById('demo-password');
    if (pwdInput) {
      pwdInput.value = `DemoRG-${Math.random().toString(36).slice(2, 8).toUpperCase()}26`;
    }
  });

  document.getElementById('form-sa-create-demo')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const companyName = document.getElementById('demo-company-name').value.trim();
      const email = document.getElementById('demo-email').value.trim();
      const password = document.getElementById('demo-password').value;
      const countryCode = document.getElementById('demo-country').value;
      const status = document.getElementById('demo-status').value;

      const res = await saFetch('/api/admin/establishments/demo', {
        method: 'POST',
        body: { companyName, email, password, countryCode, status },
      });

      state.lastCreatedDemo = {
        ...res.data,
        password,
      };
      showToast(`Compte démo « ${res.data.companyName} » créé et prêt !`, 'success');
      await loadAdminData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('btn-copy-demo-creds')?.addEventListener('click', async () => {
    if (!state.lastCreatedDemo) return;
    const text = `Accès Démo RESTOGEST\nURL: ${window.location.origin}/\nÉtablissement: ${state.lastCreatedDemo.companyName}\nE-mail: ${state.lastCreatedDemo.email}\nMot de passe: ${state.lastCreatedDemo.password}`;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Identifiants démo copiés dans le presse-papiers', 'success');
    } catch {
      showToast('Copiez manuellement les identifiants affichés ci-dessous', 'info');
    }
  });

  document.getElementById('form-sa-exchange-rate')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const rate = Number(document.getElementById('sa-fx-rate').value);
      const source = document.getElementById('sa-fx-source').value.trim();
      await saFetch('/api/subscriptions/admin/exchange-rates', {
        method: 'PUT',
        body: { baseCurrency: 'XOF', targetCurrency: 'GNF', rate, source },
      });
      showToast(`Taux mis à jour : 1 XOF = ${rate} GNF`, 'success');
      await loadAdminData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('form-sa-country-price')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const countryCode = document.getElementById('sa-cp-country').value;
      const planCode = document.getElementById('sa-cp-plan').value;
      const localPrice = Number(document.getElementById('sa-cp-price').value);
      const currencyCode = countryCode === 'GN' ? 'GNF' : 'XOF';
      await saFetch('/api/subscriptions/admin/country-prices', {
        method: 'PUT',
        body: {
          countryCode,
          planCode,
          billingPeriod: 'monthly',
          referencePrice: localPrice,
          localPrice,
          currencyCode,
          setupFee: 0,
        },
      });
      showToast(`Tarif ${planCode} (${countryCode}) mis à jour : ${localPrice} ${currencyCode}`, 'success');
      await loadAdminData();
    } catch (err) {
      showToast(err.message, 'error');
    }
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
  try {
    await saFetch('/api/admin/auth/me', { skipAuthReset: true });
    setAdminToken(true);
    showAppView();
    await loadAdminData();
    return;
  } catch {
    setAdminToken(null);
  }
  showLoginView();
}

init();
