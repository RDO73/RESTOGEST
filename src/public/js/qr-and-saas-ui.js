import { apiFetch, esc, fmtDate, fmtMoney, showToast } from './api.js';

// -------------------------------------------------------------
// SONORE WEB AUDIO API POUR NOUVELLES COMMANDES QR / APPELS SERVEUR
// -------------------------------------------------------------
export function playQrNotificationSound() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(587.33, now); // D5
    osc1.frequency.setValueAtTime(880, now + 0.14); // A5
    gain1.gain.setValueAtTime(0.18, now);
    gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.45);

    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.start(now);
    osc1.stop(now + 0.46);
  } catch {
    // Ignore audio context autoplay restrictions
  }
}

function qrStatusBadge(status) {
  const map = {
    received: { label: 'Nouvelle (Reçue)', cls: 'status-critical' },
    accepted: { label: 'Acceptée', cls: 'status-info' },
    preparing: { label: 'En préparation', cls: 'status-pending' },
    ready: { label: 'Prête à servir', cls: 'status-open' },
    served: { label: 'Servie', cls: 'status-open' },
    rejected: { label: 'Refusée', cls: 'status-closed' },
    cancelled: { label: 'Annulée', cls: 'status-closed' },
  };
  const info = map[status] || { label: status, cls: 'status-neutral' };
  return `<span class="status-pill ${info.cls}">${esc(info.label)}</span>`;
}

function minutesElapsed(isoDate) {
  if (!isoDate) return '0 min';
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const mins = Math.max(0, Math.floor(diffMs / 60000));
  if (mins < 60) return `${mins} min`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

// -------------------------------------------------------------
// IMPRESSION BON DE CUISINE / TICKET CLIENT / AFFICHE QR / FACTURE SAAS
// -------------------------------------------------------------
export function printHtmlWindow(title, bodyHtml) {
  const win = window.open('', '_blank', 'width=840,height=720');
  if (!win) {
    showToast('Veuillez autoriser les pop-ups pour lancer l’impression.', 'warning');
    return;
  }
  win.document.write(`<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; margin: 24px; }
    h1, h2, h3 { margin: 0 0 8px; }
    .ticket { max-width: 360px; margin: 0 auto; border: 1px dashed #334155; padding: 16px; }
    .line { display: flex; justify-content: space-between; padding: 5px 0; border-bottom: 1px dotted #cbd5e1; font-size: 13px; }
    .total { display: flex; justify-content: space-between; padding-top: 10px; font-weight: bold; font-size: 16px; }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 6px; background: #f1f5f9; font-weight: bold; font-size: 12px; }
    @media print { .no-print { display: none !important; } body { margin: 0; } }
  </style>
</head>
<body>
  <div class="no-print" style="margin-bottom:16px;text-align:right;">
    <button onclick="window.print()" style="padding:8px 16px;background:#f97316;color:#fff;border:none;border-radius:6px;font-weight:bold;cursor:pointer;">🖨️ Imprimer / Enregistrer en PDF</button>
  </div>
  ${bodyHtml}
</body>
</html>`);
  win.document.close();
}

export function printKitchenTicket(order) {
  const itemsHtml = (order.items || [])
    .map((it) => {
      const opts = (it.options || []).map((o) => `${o.groupName}: ${o.label}`).join(' | ');
      return `
        <div style="padding:8px 0;border-bottom:1px dashed #94a3b8;">
          <div style="font-size:16px;font-weight:bold;">${esc(it.quantity)}x ${esc(it.product_name_snapshot)}</div>
          ${opts ? `<div style="font-size:13px;color:#334155;margin-top:2px;">👉 ${esc(opts)}</div>` : ''}
          ${it.custom_message ? `<div style="font-size:13px;font-weight:bold;margin-top:2px;">🎂 Message: ${esc(it.custom_message)}</div>` : ''}
          ${it.item_note ? `<div style="font-size:12px;font-style:italic;margin-top:2px;">⚠️ Note: ${esc(it.item_note)}</div>` : ''}
        </div>
      `;
    })
    .join('');

  printHtmlWindow(
    `Bon Cuisine ${order.order_number}`,
    `<div class="ticket">
      <h2>BON DE PRÉPARATION CUISINE</h2>
      <div style="margin-bottom:8px;">
        <span class="badge">Table : ${esc(order.table_name_snapshot)} (${esc(order.table_code_snapshot)})</span>
        <span class="badge">${order.order_type === 'takeaway' ? 'À EMPORTER' : 'SUR PLACE'}</span>
      </div>
      <div style="font-size:12px;color:#475569;margin-bottom:10px;">
        N° <strong>${esc(order.order_number)}</strong> • Reçue le ${esc(fmtDate(order.created_at))}
        ${order.customer_name ? `<br/>Client : ${esc(order.customer_name)}` : ''}
      </div>
      ${order.customer_note ? `<div style="padding:6px;background:#fef3c7;border:1px solid #f59e0b;font-size:12px;margin-bottom:10px;"><strong>Note commande :</strong> ${esc(order.customer_note)}</div>` : ''}
      <div>${itemsHtml}</div>
    </div>`
  );
}

export function printCustomerQrReceipt(order, companyName, currency) {
  const itemsHtml = (order.items || [])
    .map((it) => {
      const opts = (it.options || []).map((o) => `${o.groupName}: ${o.label}`).join(' • ');
      return `
        <div class="line">
          <div>
            <strong>${esc(it.quantity)}x ${esc(it.product_name_snapshot)}</strong>
            ${opts ? `<div style="font-size:11px;color:#475569;">${esc(opts)}</div>` : ''}
          </div>
          <div>${esc(fmtMoney(it.subtotal, currency))}</div>
        </div>
      `;
    })
    .join('');

  printHtmlWindow(
    `Ticket Client ${order.order_number}`,
    `<div class="ticket">
      <h2 style="text-align:center;">${esc(companyName || 'RESTOGEST')}</h2>
      <p style="text-align:center;font-size:12px;color:#475569;margin-top:0;">
        Ticket de commande QR • ${esc(order.order_number)}<br/>
        Table : ${esc(order.table_name_snapshot)} (${esc(order.table_code_snapshot)})<br/>
        Date : ${esc(fmtDate(order.created_at))}
      </p>
      <hr/>
      ${itemsHtml}
      <div class="total">
        <span>TOTAL</span>
        <span>${esc(fmtMoney(order.total_amount, currency))}</span>
      </div>
      <p style="text-align:center;font-size:12px;margin-top:14px;">
        Statut règlement : <strong>${order.payment_status === 'paid' ? 'PAYÉ' : 'À RÉGLER'}</strong><br/>
        Merci de votre visite !
      </p>
    </div>`
  );
}

// -------------------------------------------------------------
// MODULE 1 : TABLES, PLAN DE SALLE & QR CODES (ADMIN)
// -------------------------------------------------------------
export function renderTablesAndQrModule(state, { cur, parseSaleMeta }) {
  const subtab = state.subtabs.tables || 'floor';
  const qrTables = state.qrTables || [];
  const qrSettings = state.qrSettings || {};
  const qrOptions = state.qrOptions || [];
  const zoneFilter = state.tableZone || 'all';

  const zones = ['all', ...Array.from(new Set(qrTables.map((t) => t.zone || 'Salle intérieure')))];
  const visibleTables =
    zoneFilter === 'all' ? qrTables : qrTables.filter((t) => (t.zone || 'Salle intérieure') === zoneFilter);

  const freeCount = qrTables.filter((t) => t.is_active && t.current_status === 'free' && Number(t.active_orders_count || 0) === 0).length;
  const activeCount = qrTables.filter((t) => t.is_active && (t.current_status !== 'free' || Number(t.active_orders_count || 0) > 0)).length;
  const totalSessionAmount = qrTables.reduce((acc, t) => acc + Number(t.session_amount || 0), 0);

  return `
    <div class="subtabs">
      <button type="button" class="subtab ${subtab === 'floor' ? 'active' : ''}" data-tables-subtab="floor">
        🪑 Plan de Salle &amp; QR Codes (${qrTables.length})
      </button>
      <button type="button" class="subtab ${subtab === 'manage' ? 'active' : ''}" data-tables-subtab="manage">
        ➕ Créer / Gérer les Tables
      </button>
      <button type="button" class="subtab ${subtab === 'menu-config' ? 'active' : ''}" data-tables-subtab="menu-config">
        🎨 Menu Digital &amp; Options Produits
      </button>
    </div>

    ${
      subtab === 'floor'
        ? `
          <div class="kpi-grid">
            <div class="card kpi-card">
              <div class="kpi-label">Tables Actives Libres</div>
              <div class="kpi-value" style="color:var(--success)">${freeCount}</div>
              <div class="kpi-foot">Sur ${qrTables.filter((t) => t.is_active).length} tables actives</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Tables en Service / Commande QR</div>
              <div class="kpi-value" style="color:var(--primary)">${activeCount}</div>
              <div class="kpi-foot">Occupation en temps réel</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Encours des Tables</div>
              <div class="kpi-value">${esc(fmtMoney(totalSessionAmount, cur))}</div>
              <div class="kpi-foot">Commandes QR actives</div>
            </div>
            <div class="card kpi-card">
              <div class="kpi-label">Impression QR en Lot</div>
              <div style="margin-top:8px;">
                <button type="button" id="btn-print-all-qrs" class="btn btn-primary btn-sm btn-full">
                  🖨️ Planche PDF / Tous les QR Codes
                </button>
              </div>
              <div class="kpi-foot">Support imprimable avec logo</div>
            </div>
          </div>

          <div class="card">
            <div class="section-head">
              <h3>Tables &amp; QR Codes Individuels</h3>
              <div class="category-strip" style="margin:0;padding:0;">
                ${zones
                  .map(
                    (z) =>
                      `<button type="button" class="cat-chip ${zoneFilter === z ? 'active' : ''}" data-qr-zone="${esc(z)}">${z === 'all' ? 'Toutes les zones' : esc(z)}</button>`
                  )
                  .join('')}
              </div>
            </div>

            <div class="floor-grid">
              ${visibleTables
                .map((t) => {
                  const activeOrders = Number(t.active_orders_count || 0);
                  const pendingReq = Number(t.pending_requests_count || 0);
                  const sessionAmt = Number(t.session_amount || 0);
                  const isOccupied = t.current_status !== 'free' || activeOrders > 0 || sessionAmt > 0;
                  const isBill = t.current_status === 'bill_requested';
                  const cardCls = !t.is_active
                    ? 'is-closed'
                    : isBill
                      ? 'is-bill'
                      : isOccupied
                        ? 'is-occupied'
                        : 'is-free';

                  const statusMap = {
                    free: 'Libre',
                    occupied: 'Occupée',
                    order_pending: 'Commande QR reçue',
                    preparing: 'En préparation',
                    ready: 'Prête à servir',
                    served: 'Servie',
                    bill_requested: 'Addition demandée',
                    closed: 'Clôturée',
                  };
                  const statusLabel = !t.is_active ? 'Désactivée' : statusMap[t.current_status] || t.current_status;
                  const menuUrl = `${window.location.origin}/menu/${t.qr_token}`;

                  return `
                    <div class="table-card ${cardCls}">
                      <div>
                        <div class="table-card-head">
                          <div>
                            <div class="table-card-title">${esc(t.name)} <span class="mono" style="font-size:11px;opacity:0.75;">(${esc(t.code)})</span></div>
                            <div class="table-card-zone">${esc(t.zone)} • ${t.seats} pl. ${t.table_type === 'takeaway_qr' ? '• 🛍️ À Emporter' : ''}</div>
                          </div>
                          <span class="status-pill ${!t.is_active ? 'status-closed' : isOccupied ? 'status-pending' : 'status-open'}">${esc(statusLabel)}</span>
                        </div>

                        ${
                          pendingReq > 0
                            ? `<div style="margin-top:8px;padding:6px 8px;border-radius:8px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.45);font-size:12px;color:#fca5a5;font-weight:700;">
                                 🔔 ${pendingReq} appel(s) serveur / addition en attente
                               </div>`
                            : ''
                        }

                        <div style="margin-top:10px;">
                          <div class="table-card-amount">${esc(fmtMoney(sessionAmt, cur))}</div>
                          <div class="muted-text" style="font-size:11px;">
                            ${activeOrders} commande(s) active(s) ${t.last_order_number ? `• Dernière: ${esc(t.last_order_number)}` : ''}
                          </div>
                        </div>
                      </div>

                      <div class="table-card-actions" style="flex-wrap:wrap;gap:6px;margin-top:12px;">
                        <a href="${esc(menuUrl)}" target="_blank" rel="noopener" class="btn btn-outline btn-sm" title="Ouvrir le menu digital de cette table">
                          📱 Menu Client
                        </a>
                        <button type="button" class="btn btn-primary btn-sm" data-dl-qr-svg="${esc(t.id)}" data-table-code="${esc(t.code)}">
                          📥 QR Code
                        </button>
                        <button type="button" class="btn btn-outline btn-sm" data-table-history="${esc(t.id)}">
                          📜 Historique
                        </button>
                        ${
                          isOccupied
                            ? `<button type="button" class="btn btn-amber btn-sm" data-close-table-session="${esc(t.id)}"> Libérer</button>`
                            : `<button type="button" class="btn btn-success btn-sm" data-open-pos-table="${esc(t.code)}" data-table-name="${esc(t.name)}">+ POS</button>`
                        }
                      </div>
                    </div>
                  `;
                })
                .join('')}
            </div>
          </div>
        `
        : ''
    }

    ${
      subtab === 'manage'
        ? `
          <div class="two-col">
            <div class="card">
              <div class="section-head"><h3>Créer une nouvelle Table ou Comptoir QR</h3></div>
              <form id="form-create-qr-table" class="form-stack">
                <div class="field-row">
                  <div class="field">
                    <label>Code unique (ex: T15, VIP2)</label>
                    <input id="qt-code" required placeholder="T15" />
                  </div>
                  <div class="field">
                    <label>Nom affiché</label>
                    <input id="qt-name" required placeholder="Table 15" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Zone / Espace</label>
                    <input id="qt-zone" required value="Salle intérieure" placeholder="Salle intérieure, Terrasse, VIP..." />
                  </div>
                  <div class="field">
                    <label>Nombre de places</label>
                    <input id="qt-seats" type="number" min="1" max="50" value="4" required />
                  </div>
                </div>
                <div class="field">
                  <label>Type de QR Code</label>
                  <select id="qt-type">
                    <option value="table">🍽️ Table de salle / terrasse (service à table)</option>
                    <option value="takeaway_qr">🛍️ QR Code général « À Emporter » (Pâtisserie / Fast-food)</option>
                    <option value="counter">🏪 QR Code Comptoir</option>
                  </select>
                </div>
                <button type="submit" class="btn btn-primary">Générer la table &amp; son QR Code sécurisé</button>
              </form>
            </div>

            <div class="card">
              <div class="section-head"><h3>Administration &amp; Sécurité des QR Codes</h3></div>
              <div class="table-wrap">
                <table class="responsive-table">
                  <thead>
                    <tr>
                      <th>Code / Nom</th>
                      <th>Zone</th>
                      <th>Statut</th>
                      <th>Actions QR &amp; Sécurité</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${qrTables
                      .map(
                        (t) => `
                          <tr>
                            <td data-label="Table">
                              <strong>${esc(t.code)}</strong> — ${esc(t.name)}
                              <div class="muted-text mono" style="font-size:10px;">Token: ${esc(String(t.qr_token).slice(0, 12))}…</div>
                            </td>
                            <td data-label="Zone">${esc(t.zone)} (${t.seats} pl.)</td>
                            <td data-label="Statut">
                              <span class="status-pill ${t.is_active ? 'status-open' : 'status-closed'}">
                                ${t.is_active ? 'Active' : 'Désactivée'}
                              </span>
                            </td>
                            <td data-label="Actions">
                              <div style="display:flex;gap:6px;flex-wrap:wrap;">
                                <button type="button" class="btn btn-outline btn-sm" data-regen-qr="${esc(t.id)}" title="Révoquer l'ancien QR et en générer un nouveau">
                                  🔄 Régénérer QR
                                </button>
                                <button type="button" class="btn btn-outline btn-sm" data-toggle-qr-table="${esc(t.id)}" data-current-active="${t.is_active ? '1' : '0'}">
                                  ${t.is_active ? '⏸ Désactiver' : '▶️ Réactiver'}
                                </button>
                                <button type="button" class="btn btn-danger btn-sm" data-delete-qr-table="${esc(t.id)}">
                                  🗑
                                </button>
                              </div>
                            </td>
                          </tr>
                        `
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        `
        : ''
    }

    ${
      subtab === 'menu-config'
        ? `
          <div class="two-col">
            <div class="card">
              <div class="section-head"><h3>Personnalisation du Menu Digital Public</h3></div>
              <form id="form-qr-menu-settings" class="form-stack">
                <div class="field-row">
                  <div class="field">
                    <label>Nom de l'établissement affiché</label>
                    <input id="qms-name" required value="${esc(qrSettings.display_name || state.company?.name || '')}" />
                  </div>
                  <div class="field">
                    <label>Slogan / Sous-titre</label>
                    <input id="qms-tagline" value="${esc(qrSettings.tagline || 'Commandez directement depuis votre table')}" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Téléphone / Contact</label>
                    <input id="qms-phone" value="${esc(qrSettings.phone || '')}" placeholder="+221 77 000 00 00" />
                  </div>
                  <div class="field">
                    <label>WhatsApp Commandes</label>
                    <input id="qms-wa" value="${esc(qrSettings.whatsapp_phone || '')}" placeholder="+221 77 000 00 00" />
                  </div>
                </div>
                <div class="field">
                  <label>Adresse / Informations pratiques</label>
                  <input id="qms-address" value="${esc(qrSettings.address || '')}" placeholder="Dakar Plateau / Conakry Kaloum — Ouvert 7j/7 de 08h à 23h" />
                </div>
                <div class="field">
                  <label>Message de bienvenue sur le menu QR</label>
                  <input id="qms-welcome" value="${esc(qrSettings.welcome_message || '')}" placeholder="Bienvenue ! Scannez, personnalisez vos plats et envoyez votre commande en cuisine." />
                </div>
                <div class="field-row">
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="qms-enabled" ${qrSettings.qr_ordering_enabled !== false ? 'checked' : ''} />
                    Autoriser la commande par QR Code
                  </label>
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="qms-call-waiter" ${qrSettings.allow_call_waiter !== false ? 'checked' : ''} />
                    Bouton « Appeler un serveur »
                  </label>
                </div>
                <div class="field-row">
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="qms-req-bill" ${qrSettings.allow_request_bill !== false ? 'checked' : ''} />
                    Bouton « Demander l'addition »
                  </label>
                  <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                    <input type="checkbox" id="qms-auto-accept" ${qrSettings.auto_accept_orders ? 'checked' : ''} />
                    Accepter automatiquement les commandes QR
                  </label>
                </div>
                <button type="submit" class="btn btn-primary">Enregistrer la configuration du Menu Digital</button>
              </form>
            </div>

            <div class="card">
              <div class="section-head"><h3>Options, Variantes, Suppléments &amp; Messages Gâteaux</h3></div>
              <form id="form-create-option-group" class="form-stack">
                <div class="field-row">
                  <div class="field">
                    <label>Produit ciblé (ou tous les produits)</label>
                    <select id="og-product">
                      <option value="">✨ Global (Tous les produits finis)</option>
                      ${state.products
                        .filter((p) => ['finished_good', 'service'].includes(p.product_type))
                        .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
                        .join('')}
                    </select>
                  </div>
                  <div class="field">
                    <label>Nom du groupe (ex: Cuisson, Taille, Parfum)</label>
                    <input id="og-name" required placeholder="Ex: Cuisson / Suppléments / Format" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Type de choix</label>
                    <select id="og-type">
                      <option value="single">Choix unique (Radio)</option>
                      <option value="multiple">Choix multiples (Cases à cocher)</option>
                    </select>
                  </div>
                  <div class="field" style="justify-content:center;">
                    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:18px;">
                      <input type="checkbox" id="og-required" />
                      Choix obligatoire avant ajout au panier
                    </label>
                  </div>
                </div>
                <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
                  <input type="checkbox" id="og-custom-text" />
                  🎂 Autoriser un message personnalisé (ex: texte sur gâteau d'anniversaire)
                </label>
                <div class="field">
                  <label>Valeurs &amp; Suppléments (Format : Libellé:Prix séparés par virgule)</label>
                  <input id="og-values" required placeholder="Ex: Bien cuit:0, À point:0, Supplément Fromage:1000" />
                </div>
                <button type="submit" class="btn btn-primary">Ajouter ce groupe d'options</button>
              </form>

              <div style="margin-top:16px;">
                <h4 style="margin-bottom:8px;font-size:13px;">Groupes d'options actifs (${qrOptions.length})</h4>
                ${
                  qrOptions.length === 0
                    ? '<p class="muted-text">Aucun groupe d’options configuré.</p>'
                    : qrOptions
                        .map(
                          (g) => `
                            <div style="padding:10px;border:1px solid var(--border);border-radius:8px;margin-bottom:8px;">
                              <div style="display:flex;justify-content:space-between;align-items:center;">
                                <strong>${esc(g.name)} ${g.is_required ? '(Obligatoire)' : '(Optionnel)'}</strong>
                                <button type="button" class="btn btn-danger btn-sm" data-del-opt-group="${esc(g.id)}">&times;</button>
                              </div>
                              <div class="muted-text" style="font-size:12px;margin-top:4px;">
                                ${(g.values || [])
                                  .map((v) => `${esc(v.label)} (${Number(v.price_delta) > 0 ? '+' + fmtMoney(v.price_delta, cur) : 'Inclus'})`)
                                  .join(' • ')}
                              </div>
                            </div>
                          `
                        )
                        .join('')
                }
              </div>
            </div>
          </div>
        `
        : ''
    }
  `;
}

export function bindTablesAndQrModule(state, { cur, openModal, closeModal, refreshAllData, renderRoute, setRoute, serializeSaleMeta }) {
  document.querySelectorAll('[data-tables-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtabs.tables = btn.dataset.tablesSubtab;
      renderRoute();
    });
  });

  document.querySelectorAll('[data-qr-zone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tableZone = btn.dataset.qrZone;
      renderRoute();
    });
  });

  document.getElementById('btn-print-all-qrs')?.addEventListener('click', async () => {
    const activeTables = (state.qrTables || []).filter((t) => t.is_active);
    if (activeTables.length === 0) {
      showToast('Aucune table active à imprimer', 'warning');
      return;
    }
    try {
      const posters = await Promise.all(
        activeTables.map(async (t) => {
          const res = await fetch(`/api/qr/tables/${t.id}/qrcode.svg`, {
            headers: { Authorization: `Bearer ${localStorage.getItem('restogest_token') || ''}` },
          });
          const svgText = await res.text();
          return `<div style="display:inline-block;margin:10px;page-break-inside:avoid;">${svgText}</div>`;
        })
      );
      printHtmlWindow(
        `Planche QR Codes — ${state.company?.name || 'RestoGest'}`,
        `<div style="text-align:center;">
          <h2>Planche QR Codes Tables — ${esc(state.company?.name || 'RestoGest')}</h2>
          <p style="font-size:12px;color:#475569;">Découpez et déposez chaque support sur la table correspondante</p>
          <div>${posters.join('')}</div>
        </div>`
      );
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-dl-qr-svg]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tableId = btn.dataset.dlQrSvg;
      const code = btn.dataset.tableCode;
      try {
        const res = await fetch(`/api/qr/tables/${tableId}/qrcode.svg`, {
          headers: { Authorization: `Bearer ${localStorage.getItem('restogest_token') || ''}` },
        });
        const svgText = await res.text();
        openModal(
          `Support QR Code • Table ${code}`,
          `<div style="text-align:center;">
            <div style="max-width:340px;margin:0 auto 14px;">${svgText}</div>
            <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">
              <button type="button" id="btn-print-single-qr" class="btn btn-primary">🖨️ Imprimer l'affiche</button>
              <button type="button" id="btn-download-single-qr" class="btn btn-outline">📥 Télécharger (.SVG)</button>
            </div>
          </div>`
        );
        document.getElementById('btn-print-single-qr')?.addEventListener('click', () => {
          printHtmlWindow(`QR Code ${code}`, `<div style="text-align:center;">${svgText}</div>`);
        });
        document.getElementById('btn-download-single-qr')?.addEventListener('click', () => {
          const blob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `QR-${code}.svg`;
          a.click();
          URL.revokeObjectURL(url);
        });
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-table-history]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/qr/tables/${btn.dataset.tableHistory}/history`);
        const { table, orders } = res.data;
        openModal(
          `Historique • ${table.name} (${table.code})`,
          orders.length === 0
            ? `<p class="muted-text">Aucune commande enregistrée sur cette table.</p>`
            : `<div class="table-wrap">
                <table class="responsive-table">
                  <thead><tr><th>N° Commande</th><th>Date</th><th>Montant</th><th>Statut</th><th>Paiement</th></tr></thead>
                  <tbody>
                    ${orders
                      .map(
                        (o) => `<tr>
                          <td class="mono"><strong>${esc(o.order_number)}</strong></td>
                          <td>${esc(fmtDate(o.created_at))}</td>
                          <td class="mono">${esc(fmtMoney(o.total_amount, cur))}</td>
                          <td>${qrStatusBadge(o.status)}</td>
                          <td>${o.payment_status === 'paid' ? '<span class="status-pill status-open">Payée</span>' : '<span class="status-pill status-pending">Non payée</span>'}</td>
                        </tr>`
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>`
        );
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-close-table-session]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/qr/tables/${btn.dataset.closeTableSession}/close-session`, { method: 'POST' });
        showToast('Session de table clôturée et table libérée', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-open-pos-table]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const code = btn.dataset.openPosTable;
        const name = btn.dataset.tableName;
        const notes = serializeSaleMeta({
          serviceMode: 'dine_in',
          tableCode: code,
          tableName: name,
          tableState: 'occupied',
        });
        const res = await apiFetch('/api/sales', { method: 'POST', body: { notes } });
        state.activeSale = { ...res.data, paidAmount: 0, items: [], payments: [] };
        showToast(`${name} ouverte sur la caisse POS`, 'success');
        await refreshAllData();
        setRoute('pos');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.getElementById('form-create-qr-table')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/qr/tables', {
        method: 'POST',
        body: {
          code: document.getElementById('qt-code').value.trim(),
          name: document.getElementById('qt-name').value.trim(),
          zone: document.getElementById('qt-zone').value.trim(),
          seats: parseInt(document.getElementById('qt-seats').value || '4', 10),
          tableType: document.getElementById('qt-type').value,
        },
      });
      showToast('Table et QR Code créés avec succès !', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-regen-qr]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/qr/tables/${btn.dataset.regenQr}/regenerate-qr`, { method: 'POST' });
        showToast('Nouveau QR Code généré (ancien révoqué)', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-toggle-qr-table]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const currentlyActive = btn.dataset.currentActive === '1';
        await apiFetch(`/api/qr/tables/${btn.dataset.toggleQrTable}`, {
          method: 'PUT',
          body: { isActive: !currentlyActive },
        });
        showToast(!currentlyActive ? 'Table réactivée' : 'Table désactivée', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-delete-qr-table]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/qr/tables/${btn.dataset.deleteQrTable}`, { method: 'DELETE' });
        showToast('Table supprimée', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.getElementById('form-qr-menu-settings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/qr/settings', {
        method: 'PUT',
        body: {
          displayName: document.getElementById('qms-name').value.trim(),
          tagline: document.getElementById('qms-tagline').value.trim(),
          phone: document.getElementById('qms-phone').value.trim() || null,
          whatsappPhone: document.getElementById('qms-wa').value.trim() || null,
          address: document.getElementById('qms-address').value.trim() || null,
          welcomeMessage: document.getElementById('qms-welcome').value.trim() || null,
          qrOrderingEnabled: document.getElementById('qms-enabled').checked,
          allowCallWaiter: document.getElementById('qms-call-waiter').checked,
          allowRequestBill: document.getElementById('qms-req-bill').checked,
          autoAcceptOrders: document.getElementById('qms-auto-accept').checked,
        },
      });
      showToast('Configuration du menu digital enregistrée !', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('form-create-option-group')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const rawValues = document.getElementById('og-values').value;
      const values = rawValues
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part, idx) => {
          const [label, deltaStr] = part.split(':').map((s) => s.trim());
          return {
            label,
            priceDelta: parseFloat(deltaStr || '0') || 0,
            isDefault: idx === 0,
          };
        });

      const selectionType = document.getElementById('og-type').value;
      const isRequired = document.getElementById('og-required').checked;
      await apiFetch('/api/qr/options/groups', {
        method: 'POST',
        body: {
          productId: document.getElementById('og-product').value || null,
          name: document.getElementById('og-name').value.trim(),
          selectionType,
          isRequired,
          minChoices: isRequired ? 1 : 0,
          maxChoices: selectionType === 'single' ? 1 : Math.max(1, values.length),
          allowCustomText: document.getElementById('og-custom-text').checked,
          values,
        },
      });
      showToast('Groupe d’options créé avec succès !', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-del-opt-group]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/qr/options/groups/${btn.dataset.delOptGroup}`, { method: 'DELETE' });
        showToast('Groupe d’options supprimé', 'info');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });
}

// -------------------------------------------------------------
// MODULE 5, 7, 10 : COMMANDES QR TEMPS RÉEL, ÉCRAN CUISINE (KDS) & ANALYTIQUES
// -------------------------------------------------------------
export function renderQrOrdersAndKdsModule(state, { cur }) {
  const subtab = state.subtabs.qrOrders || 'live';
  const orders = state.qrOrders || [];
  const serviceRequests = state.qrServiceRequests || [];
  const analytics = state.qrAnalytics || null;
  const filterStatus = state.qrOrderStatusFilter || 'active';

  const filteredOrders = orders.filter((o) => {
    if (filterStatus === 'active') {
      return ['received', 'accepted', 'preparing', 'ready'].includes(o.status);
    }
    if (filterStatus === 'all') return true;
    return o.status === filterStatus;
  });

  const receivedOrders = orders.filter((o) => o.status === 'received');
  const preparingOrders = orders.filter((o) => ['accepted', 'preparing'].includes(o.status));
  const readyOrders = orders.filter((o) => o.status === 'ready');

  return `
    <div class="subtabs">
      <button type="button" class="subtab ${subtab === 'live' ? 'active' : ''}" data-qro-subtab="live">
        🔔 Commandes QR en Direct (${orders.filter((o) => ['received', 'accepted', 'preparing', 'ready'].includes(o.status)).length})
      </button>
      <button type="button" class="subtab ${subtab === 'kds' ? 'active' : ''}" data-qro-subtab="kds">
        👨‍🍳 Écran Cuisine (KDS)
      </button>
      <button type="button" class="subtab ${subtab === 'analytics' ? 'active' : ''}" data-qro-subtab="analytics">
        📊 Rapports &amp; Statistiques Digitales
      </button>
    </div>

    ${
      serviceRequests.length > 0
        ? `
          <div class="card" style="border-color:rgba(249,115,22,0.55);background:rgba(249,115,22,0.08);margin-bottom:16px;">
            <div class="section-head" style="margin-bottom:8px;">
              <h3 style="color:#fdba74;">🔔 Appels Serveur &amp; Demandes d'Addition (${serviceRequests.length})</h3>
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:10px;">
              ${serviceRequests
                .map(
                  (sr) => `
                    <div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-radius:10px;background:var(--bg-elevated);border:1px solid var(--border);">
                      <div>
                        <strong>Table ${esc(sr.table_code_snapshot)}</strong> —
                        <span style="color:#fdba74;font-weight:700;">
                          ${sr.request_type === 'call_waiter' ? '👋 Appelle un serveur' : '🧾 Demande l’addition'}
                        </span>
                        <div class="muted-text" style="font-size:11px;">Il y a ${minutesElapsed(sr.created_at)}</div>
                      </div>
                      <button type="button" class="btn btn-success btn-sm" data-resolve-sr="${esc(sr.id)}">✓ Traité</button>
                    </div>
                  `
                )
                .join('')}
            </div>
          </div>
        `
        : ''
    }

    ${
      subtab === 'live'
        ? `
          <div class="card">
            <div class="section-head">
              <h3>Flux des Commandes Digitales</h3>
              <div class="category-strip" style="margin:0;padding:0;">
                ${[
                  { id: 'active', label: 'En cours' },
                  { id: 'received', label: `Nouvelles (${receivedOrders.length})` },
                  { id: 'preparing', label: 'En cuisine' },
                  { id: 'ready', label: 'Prêtes' },
                  { id: 'served', label: 'Servies' },
                  { id: 'all', label: 'Toutes' },
                ]
                  .map(
                    (f) =>
                      `<button type="button" class="cat-chip ${filterStatus === f.id ? 'active' : ''}" data-qro-filter="${f.id}">${esc(f.label)}</button>`
                  )
                  .join('')}
              </div>
            </div>

            ${
              filteredOrders.length === 0
                ? `<p class="muted-text" style="padding:24px 0;text-align:center;">Aucune commande dans cette vue.</p>`
                : `<div class="floor-grid">
                    ${filteredOrders
                      .map((o) => {
                        const itemsHtml = (o.items || [])
                          .map((it) => {
                            const opts = (it.options || []).map((op) => `${op.groupName}: ${op.label}`).join(' | ');
                            return `
                              <div style="padding:6px 0;border-bottom:1px dashed var(--border);font-size:13px;">
                                <div style="display:flex;justify-content:space-between;">
                                  <strong>${it.quantity}x ${esc(it.product_name_snapshot)}</strong>
                                  <span class="mono">${esc(fmtMoney(it.subtotal, cur))}</span>
                                </div>
                                ${opts ? `<div style="font-size:11px;color:#fdba74;">${esc(opts)}</div>` : ''}
                                ${it.custom_message ? `<div style="font-size:11px;color:#7dd3fc;">🎂 ${esc(it.custom_message)}</div>` : ''}
                                ${it.item_note ? `<div style="font-size:11px;color:var(--text-secondary);">Note: ${esc(it.item_note)}</div>` : ''}
                              </div>
                            `;
                          })
                          .join('');

                        return `
                          <div class="card" style="margin:0;display:flex;flex-direction:column;justify-content:space-between;border-left:4px solid ${
                            o.status === 'received' ? '#ef4444' : o.status === 'ready' ? '#10b981' : '#f97316'
                          };">
                            <div>
                              <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
                                <div>
                                  <div style="font-weight:800;font-size:15px;">
                                    📍 ${esc(o.table_name_snapshot)} (${esc(o.table_code_snapshot)})
                                  </div>
                                  <div class="muted-text mono" style="font-size:11px;">
                                    ${esc(o.order_number)} • ⏱ ${minutesElapsed(o.created_at)}
                                  </div>
                                </div>
                                ${qrStatusBadge(o.status)}
                              </div>

                              ${
                                o.customer_name || o.customer_phone
                                  ? `<div style="font-size:12px;margin-top:6px;color:#cbd5e1;">👤 ${esc(o.customer_name || '')} ${esc(o.customer_phone || '')}</div>`
                                  : ''
                              }
                              ${
                                o.customer_note
                                  ? `<div style="margin-top:6px;padding:6px;border-radius:6px;background:rgba(245,158,11,0.14);font-size:12px;color:#fcd34d;">⚠️ ${esc(o.customer_note)}</div>`
                                  : ''
                              }

                              <div style="margin:10px 0;">${itemsHtml}</div>

                              <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
                                <span style="font-size:12px;font-weight:700;color:${o.payment_status === 'paid' ? '#10b981' : '#f59e0b'};">
                                  ${o.payment_status === 'paid' ? `✅ Payée (${esc(o.payment_method || '')})` : '⏳ Non encaissée'}
                                </span>
                                <strong class="mono" style="font-size:16px;">${esc(fmtMoney(o.total_amount, cur))}</strong>
                              </div>
                            </div>

                            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:14px;">
                              ${
                                o.status === 'received'
                                  ? `
                                    <button type="button" class="btn btn-success btn-sm" data-qro-status="${esc(o.id)}" data-next-status="accepted">✓ Accepter</button>
                                    <button type="button" class="btn btn-danger btn-sm" data-qro-reject="${esc(o.id)}">✕ Refuser</button>
                                  `
                                  : ''
                              }
                              ${
                                o.status === 'accepted'
                                  ? `<button type="button" class="btn btn-primary btn-sm" data-qro-status="${esc(o.id)}" data-next-status="preparing">🔥 Lancer préparation</button>`
                                  : ''
                              }
                              ${
                                o.status === 'preparing'
                                  ? `<button type="button" class="btn btn-success btn-sm" data-qro-status="${esc(o.id)}" data-next-status="ready">🔔 Prête à servir</button>`
                                  : ''
                              }
                              ${
                                o.status === 'ready'
                                  ? `<button type="button" class="btn btn-primary btn-sm" data-qro-status="${esc(o.id)}" data-next-status="served">🍽️ Marquer servie</button>`
                                  : ''
                              }
                              ${
                                o.payment_status !== 'paid' && !['rejected', 'cancelled'].includes(o.status)
                                  ? `<button type="button" class="btn btn-amber btn-sm" data-qro-pay="${esc(o.id)}" data-order-num="${esc(o.order_number)}" data-order-total="${o.total_amount}">💳 Encaisser</button>`
                                  : ''
                              }
                              <button type="button" class="btn btn-outline btn-sm" data-qro-print-kitchen="${esc(o.id)}" title="Bon de cuisine">🖨️ Cuisine</button>
                              <button type="button" class="btn btn-outline btn-sm" data-qro-print-receipt="${esc(o.id)}" title="Ticket client">🧾 Ticket</button>
                            </div>
                          </div>
                        `;
                      })
                      .join('')}
                  </div>`
            }
          </div>
        `
        : ''
    }

    ${
      subtab === 'kds'
        ? `
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:16px;">
            <div class="card" style="border-top:4px solid #ef4444;">
              <div class="section-head"><h3>🔴 1. À Accepter (${receivedOrders.length})</h3></div>
              ${
                receivedOrders.length === 0
                  ? '<p class="muted-text">Aucune nouvelle commande en attente.</p>'
                  : receivedOrders
                      .map(
                        (o) => `
                          <div style="padding:12px;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;background:var(--bg-elevated);">
                            <div style="display:flex;justify-content:space-between;font-weight:700;">
                              <span>${esc(o.table_name_snapshot)} (${esc(o.table_code_snapshot)})</span>
                              <span class="mono">${minutesElapsed(o.created_at)}</span>
                            </div>
                            <ul style="margin:8px 0;padding-left:18px;font-size:13px;">
                              ${(o.items || []).map((it) => `<li><strong>${it.quantity}x ${esc(it.product_name_snapshot)}</strong> ${it.custom_message ? `(🎂 ${esc(it.custom_message)})` : ''}</li>`).join('')}
                            </ul>
                            <div style="display:flex;gap:6px;">
                              <button type="button" class="btn btn-success btn-sm btn-full" data-qro-status="${esc(o.id)}" data-next-status="preparing">Accepter &amp; Préparer</button>
                            </div>
                          </div>
                        `
                      )
                      .join('')
              }
            </div>

            <div class="card" style="border-top:4px solid #f97316;">
              <div class="section-head"><h3>🟠 2. En Préparation (${preparingOrders.length})</h3></div>
              ${
                preparingOrders.length === 0
                  ? '<p class="muted-text">Aucune commande en préparation.</p>'
                  : preparingOrders
                      .map(
                        (o) => `
                          <div style="padding:12px;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;background:var(--bg-elevated);">
                            <div style="display:flex;justify-content:space-between;font-weight:700;">
                              <span>${esc(o.table_name_snapshot)} (${esc(o.table_code_snapshot)})</span>
                              <span class="mono">${minutesElapsed(o.created_at)}</span>
                            </div>
                            <ul style="margin:8px 0;padding-left:18px;font-size:14px;">
                              ${(o.items || [])
                                .map((it) => {
                                  const opts = (it.options || []).map((op) => op.label).join(', ');
                                  return `<li><strong>${it.quantity}x ${esc(it.product_name_snapshot)}</strong> ${opts ? `<span style="color:#fdba74;">[${esc(opts)}]</span>` : ''} ${it.item_note ? `<em>(${esc(it.item_note)})</em>` : ''}</li>`;
                                })
                                .join('')}
                            </ul>
                            <div style="display:flex;gap:6px;">
                              <button type="button" class="btn btn-success btn-sm btn-full" data-qro-status="${esc(o.id)}" data-next-status="ready">🔔 Marquer Prête</button>
                              <button type="button" class="btn btn-outline btn-sm" data-qro-print-kitchen="${esc(o.id)}">🖨️</button>
                            </div>
                          </div>
                        `
                      )
                      .join('')
              }
            </div>

            <div class="card" style="border-top:4px solid #10b981;">
              <div class="section-head"><h3>🟢 3. Prêtes à Servir (${readyOrders.length})</h3></div>
              ${
                readyOrders.length === 0
                  ? '<p class="muted-text">Aucune commande en attente de service.</p>'
                  : readyOrders
                      .map(
                        (o) => `
                          <div style="padding:12px;border:1px solid var(--border);border-radius:10px;margin-bottom:10px;background:var(--bg-elevated);">
                            <div style="display:flex;justify-content:space-between;font-weight:700;">
                              <span>${esc(o.table_name_snapshot)} (${esc(o.table_code_snapshot)})</span>
                              <span class="mono">${esc(o.order_number)}</span>
                            </div>
                            <p class="muted-text" style="font-size:12px;margin:6px 0;">${(o.items || []).length} ligne(s) prête(s) au comptoir cuisine</p>
                            <button type="button" class="btn btn-primary btn-sm btn-full" data-qro-status="${esc(o.id)}" data-next-status="served">🍽️ Servie à table</button>
                          </div>
                        `
                      )
                      .join('')
              }
            </div>
          </div>
        `
        : ''
    }

    ${
      subtab === 'analytics'
        ? `
          <div class="card">
            <div class="section-head">
              <h3>Statistiques &amp; Performance des Commandes QR</h3>
              <div class="category-strip" style="margin:0;padding:0;">
                ${[
                  { id: 'today', label: "Aujourd'hui" },
                  { id: 'yesterday', label: 'Hier' },
                  { id: 'week', label: '7 derniers jours' },
                  { id: 'month', label: 'Ce mois' },
                ]
                  .map(
                    (p) =>
                      `<button type="button" class="cat-chip ${(state.qrAnalyticsPeriod || 'month') === p.id ? 'active' : ''}" data-qra-period="${p.id}">${esc(p.label)}</button>`
                  )
                  .join('')}
              </div>
            </div>

            <div class="kpi-grid">
              <div class="card kpi-card">
                <div class="kpi-label">Commandes QR Reçues</div>
                <div class="kpi-value">${analytics?.summary?.total_orders || 0}</div>
                <div class="kpi-foot">${analytics?.summary?.served_orders || 0} servies • ${analytics?.summary?.cancelled_or_rejected_orders || 0} annulées</div>
              </div>
              <div class="card kpi-card">
                <div class="kpi-label">CA Digital Encaissé</div>
                <div class="kpi-value" style="color:var(--success)">${esc(fmtMoney(analytics?.summary?.paid_revenue || 0, cur))}</div>
                <div class="kpi-foot">Comptabilisé dans les ventes</div>
              </div>
              <div class="card kpi-card">
                <div class="kpi-label">Encours QR Non Encaissé</div>
                <div class="kpi-value" style="color:var(--primary)">${esc(fmtMoney(analytics?.summary?.unpaid_active_revenue || 0, cur))}</div>
                <div class="kpi-foot">En attente de règlement</div>
              </div>
              <div class="card kpi-card">
                <div class="kpi-label">Panier Moyen QR</div>
                <div class="kpi-value">${esc(fmtMoney(analytics?.summary?.average_basket || 0, cur))}</div>
                <div class="kpi-foot">Sur place : ${analytics?.summary?.dine_in_orders || 0} • Emporter : ${analytics?.summary?.takeaway_orders || 0}</div>
              </div>
            </div>

            <div class="two-col" style="margin-top:16px;">
              <div class="card">
                <div class="section-head"><h3>🏆 Produits les plus commandés via QR Code</h3></div>
                <div class="table-wrap">
                  <table class="responsive-table">
                    <thead><tr><th>Produit</th><th>Qté commandée</th><th>Chiffre d'affaires</th></tr></thead>
                    <tbody>
                      ${
                        !analytics?.topProducts || analytics.topProducts.length === 0
                          ? '<tr><td colspan="3" class="muted-text">Aucune donnée sur cette période.</td></tr>'
                          : analytics.topProducts
                              .map(
                                (tp) => `<tr>
                                  <td><strong>${esc(tp.product_name_snapshot)}</strong></td>
                                  <td class="mono">${esc(tp.total_qty)}</td>
                                  <td class="mono">${esc(fmtMoney(tp.total_revenue, cur))}</td>
                                </tr>`
                              )
                              .join('')
                      }
                    </tbody>
                  </table>
                </div>
              </div>

              <div class="card">
                <div class="section-head"><h3>🪑 Tables les plus actives</h3></div>
                <div class="table-wrap">
                  <table class="responsive-table">
                    <thead><tr><th>Table</th><th>Commandes</th><th>Volume commandé</th></tr></thead>
                    <tbody>
                      ${
                        !analytics?.topTables || analytics.topTables.length === 0
                          ? '<tr><td colspan="3" class="muted-text">Aucune donnée sur cette période.</td></tr>'
                          : analytics.topTables
                              .map(
                                (tt) => `<tr>
                                  <td><strong>${esc(tt.table_name_snapshot)} (${esc(tt.table_code_snapshot)})</strong></td>
                                  <td class="mono">${esc(tt.orders_count)}</td>
                                  <td class="mono">${esc(fmtMoney(tt.revenue, cur))}</td>
                                </tr>`
                              )
                              .join('')
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        `
        : ''
    }
  `;
}

export function bindQrOrdersAndKdsModule(state, { cur, openModal, closeModal, refreshAllData, renderRoute }) {
  document.querySelectorAll('[data-qro-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtabs.qrOrders = btn.dataset.qroSubtab;
      renderRoute();
    });
  });

  document.querySelectorAll('[data-qro-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.qrOrderStatusFilter = btn.dataset.qroFilter;
      renderRoute();
    });
  });

  document.querySelectorAll('[data-qra-period]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.qrAnalyticsPeriod = btn.dataset.qraPeriod;
      try {
        const res = await apiFetch(`/api/qr/analytics?period=${encodeURIComponent(state.qrAnalyticsPeriod)}`);
        state.qrAnalytics = res.data;
        renderRoute();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-resolve-sr]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/qr/service-requests/${btn.dataset.resolveSr}/resolve`, { method: 'POST' });
        showToast('Demande client marquée comme traitée', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-qro-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const orderId = btn.dataset.qroStatus;
        const nextStatus = btn.dataset.nextStatus;
        await apiFetch(`/api/qr/orders/${orderId}/status`, {
          method: 'POST',
          body: { status: nextStatus },
        });
        showToast(`Statut commande mis à jour : ${nextStatus}`, 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-qro-reject]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const orderId = btn.dataset.qroReject;
      openModal(
        'Refuser la commande QR',
        `<form id="form-reject-qro" class="form-stack">
          <div class="field">
            <label>Motif du refus (visible par le client sur son téléphone)</label>
            <input id="qro-reject-reason" required placeholder="Ex: Rupture exceptionnelle de cet ingrédient..." />
          </div>
          <button type="submit" class="btn btn-danger btn-full">Confirmer le refus</button>
        </form>`
      );
      document.getElementById('form-reject-qro')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await apiFetch(`/api/qr/orders/${orderId}/status`, {
            method: 'POST',
            body: {
              status: 'rejected',
              reason: document.getElementById('qro-reject-reason').value.trim(),
            },
          });
          closeModal();
          showToast('Commande refusée', 'info');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  });

  document.querySelectorAll('[data-qro-pay]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const orderId = btn.dataset.qroPay;
      const orderNum = btn.dataset.orderNum;
      const orderTotal = Number(btn.dataset.orderTotal || 0);

      openModal(
        `Encaisser la commande ${orderNum}`,
        `<form id="form-pay-qro" class="form-stack">
          <div class="summary-lines">
            <div class="summary-line summary-total">
              <span>Montant à encaisser</span>
              <span class="mono">${esc(fmtMoney(orderTotal, cur))}</span>
            </div>
          </div>
          <div class="field">
            <label>Moyen de paiement</label>
            <select id="qro-pay-method">
              <option value="cash">💵 Espèces (Caisse)</option>
              <option value="wave">🌊 Wave Mobile Money</option>
              <option value="orange_money">🍊 Orange Money</option>
              <option value="card">💳 Carte Bancaire</option>
              <option value="mobile_money">📱 Autre Mobile Money</option>
            </select>
          </div>
          <div class="field">
            <label>Référence transaction (optionnel)</label>
            <input id="qro-pay-ref" placeholder="Ex: Réf Wave ou ticket TPE..." />
          </div>
          <p class="muted-text" style="font-size:12px;">
            L'encaissement valide définitivement la vente dans la session de caisse ouverte et déduit les stocks (directs ou par recette) une seule fois.
          </p>
          <button type="submit" class="btn btn-success btn-full">Valider l'encaissement &amp; déstocker</button>
        </form>`
      );

      document.getElementById('form-pay-qro')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await apiFetch(`/api/qr/orders/${orderId}/pay`, {
            method: 'POST',
            body: {
              paymentMethod: document.getElementById('qro-pay-method').value,
              reference: document.getElementById('qro-pay-ref').value.trim() || null,
            },
          });
          closeModal();
          showToast(`Commande ${orderNum} encaissée et comptabilisée !`, 'success');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  });

  document.querySelectorAll('[data-qro-print-kitchen]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = (state.qrOrders || []).find((o) => o.id === btn.dataset.qroPrintKitchen);
      if (order) printKitchenTicket(order);
    });
  });

  document.querySelectorAll('[data-qro-print-receipt]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const order = (state.qrOrders || []).find((o) => o.id === btn.dataset.qroPrintReceipt);
      if (order) printCustomerQrReceipt(order, state.company?.name, cur);
    });
  });
}

// -------------------------------------------------------------
// EXTENSION 2 : MODULE ABONNEMENT, COMPARATEUR & FACTURES CLIENT
// -------------------------------------------------------------
function computeClientPlanPrice(plan, cycle, cur) {
  const rate = cur === 'GNF' ? 15 : 1;
  let base = Number(plan.monthly_price || 0);
  if (cycle === 'quarterly') base = Number(plan.quarterly_price || base * 3);
  else if (cycle === 'semiannual') base = Number(plan.semiannual_price || base * 6);
  else if (cycle === 'yearly') base = Number(plan.yearly_price || base * 10);
  const setup = Number(plan.setup_fee || 0);
  return {
    basePrice: Math.round(base * rate),
    setupFee: Math.round(setup * rate),
  };
}

export function printSaasInvoiceModal(invoice, merchant) {
  printHtmlWindow(
    `Facture Abonnement ${invoice.invoice_number}`,
    `<div style="max-width:680px;margin:0 auto;border:1px solid #cbd5e1;padding:28px;border-radius:10px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:16px;margin-bottom:20px;">
        <div>
          <h1 style="color:#f97316;margin:0;">${esc(merchant?.brand_name || 'RESTOGEST SaaS')}</h1>
          <div style="font-size:13px;color:#475569;margin-top:4px;">
            ${esc(merchant?.legal_name || 'RESTOGEST CLOUD SAS')}<br/>
            ${esc(merchant?.address || 'Dakar & Conakry')}<br/>
            Email : ${esc(merchant?.support_email || 'facturation@myrestogest.com')}
          </div>
        </div>
        <div style="text-align:right;">
          <h2 style="margin:0;">FACTURE ABONNEMENT</h2>
          <div style="font-weight:bold;font-size:15px;margin-top:4px;">N° ${esc(invoice.invoice_number)}</div>
          <div style="font-size:12px;color:#475569;">Date d'émission : ${esc(fmtDate(invoice.issued_at))}</div>
          <span class="badge" style="background:#dcfce7;color:#166534;margin-top:6px;">FACTURE ACQUITTÉE (PAYÉE)</span>
        </div>
      </div>

      <div style="margin-bottom:20px;font-size:14px;">
        <strong>Facturé à l'établissement :</strong><br/>
        ${esc(invoice.customer_company_name)}<br/>
        ${invoice.customer_email ? `Email : ${esc(invoice.customer_email)}<br/>` : ''}
        ${invoice.customer_phone ? `Tél : ${esc(invoice.customer_phone)}` : ''}
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;font-size:14px;">
        <thead>
          <tr style="background:#f1f5f9;text-align:left;">
            <th style="padding:10px;border:1px solid #cbd5e1;">Désignation</th>
            <th style="padding:10px;border:1px solid #cbd5e1;">Période couverte</th>
            <th style="padding:10px;border:1px solid #cbd5e1;text-align:right;">Montant</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="padding:10px;border:1px solid #cbd5e1;">
              <strong>Forfait ${esc(invoice.plan_name)} (${esc(invoice.plan_code)})</strong><br/>
              Fréquence : ${esc(invoice.billing_period)}
            </td>
            <td style="padding:10px;border:1px solid #cbd5e1;">
              Du ${esc(fmtDate(invoice.period_start))}<br/>au ${esc(fmtDate(invoice.period_end))}
            </td>
            <td style="padding:10px;border:1px solid #cbd5e1;text-align:right;">
              ${esc(fmtMoney(invoice.subtotal_amount, invoice.currency))}
            </td>
          </tr>
          ${
            Number(invoice.setup_fee_amount) > 0
              ? `<tr>
                  <td colspan="2" style="padding:10px;border:1px solid #cbd5e1;">Frais de mise en service / installation</td>
                  <td style="padding:10px;border:1px solid #cbd5e1;text-align:right;">${esc(fmtMoney(invoice.setup_fee_amount, invoice.currency))}</td>
                </tr>`
              : ''
          }
          ${
            Number(invoice.discount_amount) > 0
              ? `<tr>
                  <td colspan="2" style="padding:10px;border:1px solid #cbd5e1;">Remise commerciale appliquée</td>
                  <td style="padding:10px;border:1px solid #cbd5e1;text-align:right;">-${esc(fmtMoney(invoice.discount_amount, invoice.currency))}</td>
                </tr>`
              : ''
          }
        </tbody>
      </table>

      <div style="display:flex;justify-content:space-between;align-items:center;border-top:2px solid #0f172a;padding-top:14px;font-size:16px;font-weight:bold;">
        <span>TOTAL TTC RÉGLÉ (${esc(invoice.payment_method)} • Réf: ${esc(invoice.payment_reference || '—')})</span>
        <span>${esc(fmtMoney(invoice.total_amount, invoice.currency))}</span>
      </div>
    </div>`
  );
}

export function renderSubscriptionModuleV12(state, { cur, statusBadge }) {
  const sub = state.subscriptionData?.subscription;
  const plans = state.subscriptionData?.plans || [];
  const settings = state.subscriptionData?.settings || {};
  const transactions = state.subscriptionData?.transactions || [];
  const invoices = state.subscriptionData?.invoices || [];
  const merch = state.subscriptionData?.merchantPaymentInfo || {};
  const cycle = state.billingCycle || 'monthly';

  const cycleLabels = {
    monthly: 'Mensuel (1 mois)',
    quarterly: 'Trimestriel (3 mois)',
    semiannual: 'Semestriel (6 mois)',
    yearly: 'Annuel (12 mois • 2 mois offerts)',
  };

  return `
    <div class="license-hero">
      <div>
        <div class="brand-badge" style="margin-bottom:8px;">
          <span class="brand-dot"></span>
          <span>Abonnement &amp; Licence SaaS RestoGest</span>
        </div>
        <h3 style="margin:0 0 4px;font-family:var(--font-display);font-size:20px;">
          ${sub ? esc(sub.plan_name || sub.plan_code) : 'Essai Gratuit Cloud'} — ${statusBadge(sub?.status || 'trial')}
        </h3>
        <p style="margin:0;color:#cbd5e1;font-size:13px;">
          Établissement : <strong>${esc(state.company?.name || 'Mon Établissement')}</strong>
          • Devise : <strong>${esc(cur)}</strong>
          • Jours restants : <strong>${sub?.daysRemaining ?? 14} j</strong>
          ${sub?.current_period_end ? ` • Échéance : ${esc(fmtDate(sub.current_period_end))}` : ''}
        </p>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">
        ${['monthly', 'quarterly', 'semiannual', 'yearly']
          .map(
            (c) =>
              `<button type="button" class="btn ${cycle === c ? 'btn-primary' : 'btn-outline'} btn-sm" data-bill-cycle="${c}">
                ${c === 'monthly' ? 'Mensuel' : c === 'quarterly' ? 'Trimestriel' : c === 'semiannual' ? 'Semestriel' : 'Annuel (-17%)'}
              </button>`
          )
          .join('')}
      </div>
    </div>

    <div class="pricing-grid" style="margin-bottom:20px;">
      ${plans
        .map((plan) => {
          const { basePrice, setupFee } = computeClientPlanPrice(plan, cycle, cur);
          const features = Array.isArray(plan.features) ? plan.features : [];
          const isPro = plan.code === 'PRO';
          const isCurrent = sub?.plan_code === plan.code && sub?.status === 'active';

          return `
            <div class="pricing-card ${isPro ? 'is-recommended' : ''}">
              <div class="section-head" style="margin-bottom:4px;">
                <h3>${esc(plan.name)}</h3>
                ${
                  isCurrent
                    ? '<span class="status-pill status-open">Plan Actif</span>'
                    : isPro
                      ? '<span class="status-pill status-info">Populaire</span>'
                      : ''
                }
              </div>
              <div class="muted-text" style="font-size:12px;margin-bottom:10px;">
                Jusqu'à <strong>${plan.max_users || 10}</strong> utilisateurs • <strong>${plan.max_tables || 50}</strong> tables QR • <strong>${plan.max_locations || 1}</strong> site(s)
              </div>
              <div>
                <div class="pricing-price">${esc(fmtMoney(basePrice, cur))}</div>
                <span class="muted-text">${esc(cycleLabels[cycle] || cycle)}</span>
                ${setupFee > 0 ? `<div style="font-size:11px;color:#fdba74;margin-top:2px;">+ Frais d'installation initiale : ${esc(fmtMoney(setupFee, cur))}</div>` : '<div style="font-size:11px;color:#10b981;margin-top:2px;">✓ Installation & mise en service offertes</div>'}
              </div>
              <ul class="pricing-features" style="margin:12px 0;">
                ${features.map((f) => `<li>${esc(f)}</li>`).join('')}
              </ul>
              <button
                type="button"
                class="btn ${isPro ? 'btn-primary' : 'btn-outline'} btn-full"
                data-open-sub-wizard="${esc(plan.code)}"
              >
                ${isCurrent ? 'Renouveler / Prolonger cet abonnement' : 'Choisir ce plan & Souscrire'}
              </button>
            </div>
          `;
        })
        .join('')}
    </div>

    <div class="two-col">
      <div class="card">
        <div class="section-head"><h3>📄 Mes Factures d'Abonnement (${invoices.length})</h3></div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead><tr><th>N° Facture</th><th>Formule</th><th>Montant</th><th>Date</th><th>Action</th></tr></thead>
            <tbody>
              ${
                invoices.length === 0
                  ? '<tr><td colspan="5" class="muted-text">Aucune facture émise pour le moment.</td></tr>'
                  : invoices
                      .map(
                        (inv) => `<tr>
                          <td class="mono"><strong>${esc(inv.invoice_number)}</strong></td>
                          <td>${esc(inv.plan_name)} (${esc(inv.billing_period)})</td>
                          <td class="mono">${esc(fmtMoney(inv.total_amount, inv.currency))}</td>
                          <td>${esc(fmtDate(inv.issued_at))}</td>
                          <td><button type="button" class="btn btn-outline btn-sm" data-print-saas-inv="${esc(inv.id)}">🖨️ Facture PDF</button></td>
                        </tr>`
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="section-head"><h3>🌍 Paramètres Devises &amp; Pays (Sénégal / Guinée)</h3></div>
        <form id="form-sub-company-settings" class="form-stack">
          <div class="field-row">
            <div class="field">
              <label>Devise de travail</label>
              <select id="scs-currency">
                <option value="XOF" ${cur === 'XOF' ? 'selected' : ''}>XOF — Franc CFA (Sénégal / UEMOA)</option>
                <option value="GNF" ${cur === 'GNF' ? 'selected' : ''}>GNF — Franc Guinéen (Guinée)</option>
              </select>
            </div>
            <div class="field">
              <label>Pays</label>
              <select id="scs-country">
                <option value="SN" ${(settings.country || 'SN') === 'SN' ? 'selected' : ''}>🇸🇳 Sénégal</option>
                <option value="GN" ${settings.country === 'GN' ? 'selected' : ''}>🇬🇳 Guinée</option>
              </select>
            </div>
          </div>
          <div class="field">
            <label>Numéro WhatsApp du Gérant (Rapports Z &amp; Commandes)</label>
            <input id="scs-whatsapp" value="${esc(settings.whatsapp_phone || '')}" placeholder="+221 77 000 00 00 ou +224 620 00 00 00" />
          </div>
          <button type="submit" class="btn btn-primary">Mettre à jour la devise &amp; les coordonnées</button>
        </form>

        <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--text-secondary);">
          <strong>Coordonnées officielles de règlement RESTOGEST :</strong><br/>
          Wave Business : <span class="mono">${esc(merch.wave_merchant_number || '+221 77 800 10 10')}</span> •
          Orange Money : <span class="mono">${esc(merch.orange_money_merchant_number || '+221 77 900 20 20')}</span><br/>
          Banque : ${esc(merch.bank_name || 'UBA / Orabank')} — IBAN : <span class="mono">${esc(merch.bank_iban || 'SN08 0010 2030 4050 6070 8090')}</span>
        </div>
      </div>
    </div>
  `;
}

export function bindSubscriptionModuleV12(state, { cur, openModal, closeModal, refreshAllData, renderRoute }) {
  document.querySelectorAll('[data-bill-cycle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.billingCycle = btn.dataset.billCycle;
      renderRoute();
    });
  });

  document.getElementById('form-sub-company-settings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const currency = document.getElementById('scs-currency').value;
      const country = document.getElementById('scs-country').value;
      const whatsappPhone = document.getElementById('scs-whatsapp').value.trim() || null;
      await apiFetch('/api/subscriptions/settings', {
        method: 'PUT',
        body: { currency, country, whatsappPhone },
      });
      if (state.company) state.company.currency = currency;
      showToast(`Devise (${currency}) enregistrée avec succès`, 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.querySelectorAll('[data-print-saas-inv]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        const res = await apiFetch(`/api/subscriptions/invoices/${btn.dataset.printSaasInv}`);
        printSaasInvoiceModal(res.data.invoice, res.data.merchant);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-open-sub-wizard]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const planCode = btn.dataset.openSubWizard;
      const plans = state.subscriptionData?.plans || [];
      const plan = plans.find((p) => p.code === planCode);
      if (!plan) return;

      const cycle = state.billingCycle || 'monthly';
      const { basePrice, setupFee } = computeClientPlanPrice(plan, cycle, cur);
      const total = basePrice + setupFee;

      openModal(
        `Souscription SaaS • ${plan.name}`,
        `<form id="form-saas-wizard" class="form-stack">
          <div class="summary-lines">
            <div class="summary-line"><span>1. Formule sélectionnée</span><strong>${esc(plan.name)} (${esc(plan.code)})</strong></div>
            <div class="summary-line"><span>2. Fréquence de facturation</span><strong>${esc(cycle)}</strong></div>
            <div class="summary-line"><span>3. Prix de l'abonnement</span><span class="mono">${esc(fmtMoney(basePrice, cur))}</span></div>
            <div class="summary-line"><span>4. Frais d'installation</span><span class="mono">${esc(fmtMoney(setupFee, cur))}</span></div>
            <div class="summary-line summary-total"><span>Total TTC à régler</span><span class="mono">${esc(fmtMoney(total, cur))}</span></div>
          </div>

          <div class="field">
            <label>Moyen de paiement</label>
            <select id="wiz-pay-method">
              <option value="wave">🌊 Wave Mobile Money (Activation immédiate)</option>
              <option value="orange_money">🍊 Orange Money (Activation immédiate)</option>
              <option value="mtn_momo">💛 MTN MoMo (Activation immédiate)</option>
              <option value="paydunya">⚡ PayDunya Checkout UEMOA</option>
              <option value="paytech">⚡ PayTech Sénégal</option>
              <option value="cinetpay">⚡ CinetPay Afrique</option>
              <option value="card_visa_uba">💳 Carte Bancaire Visa / Mastercard / UBA</option>
              <option value="bank_transfer">🏦 Virement Bancaire (Validation manuelle Super-Admin)</option>
              <option value="manual">🧾 Dépôt avec référence de preuve (Validation Super-Admin)</option>
            </select>
          </div>

          <div class="field">
            <label>Téléphone payeur ou contact</label>
            <input id="wiz-payer-phone" required placeholder="+221 77 000 00 00 ou +224 620 00 00 00" />
          </div>

          <div class="field" id="wiz-manual-ref-wrap" style="display:none;">
            <label>Référence du transfert / virement (Obligatoire pour paiement manuel)</label>
            <input id="wiz-manual-ref" placeholder="Ex: VIR-UBA-99281 ou REF-WAVE-112" />
          </div>

          <div class="field">
            <label>Code promotionnel (optionnel, ex: BIENVENUE10)</label>
            <input id="wiz-promo" placeholder="BIENVENUE10 (-10%)" />
          </div>

          <p class="muted-text" style="font-size:11px;">
            🔒 Sécurité bancaire : RestoGest ne vous demandera jamais votre code secret PIN Mobile Money.
          </p>

          <button type="submit" class="btn btn-success btn-full">Procéder au règlement &amp; activer la licence</button>
        </form>`
      );

      const methodSel = document.getElementById('wiz-pay-method');
      const manualWrap = document.getElementById('wiz-manual-ref-wrap');
      methodSel?.addEventListener('change', () => {
        const isManual = ['bank_transfer', 'manual'].includes(methodSel.value);
        if (manualWrap) manualWrap.style.display = isManual ? 'block' : 'none';
      });

      document.getElementById('form-saas-wizard')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const paymentMethod = document.getElementById('wiz-pay-method').value;
          const isManual = ['bank_transfer', 'manual'].includes(paymentMethod);
          const res = await apiFetch('/api/subscriptions/transactions', {
            method: 'POST',
            body: {
              planCode: plan.code,
              billingPeriod: cycle,
              paymentMethod,
              paymentMode: isManual ? 'manual_proof' : 'instant_gateway',
              payerPhone: document.getElementById('wiz-payer-phone').value.trim(),
              manualReference: document.getElementById('wiz-manual-ref')?.value.trim() || null,
              promoCode: document.getElementById('wiz-promo')?.value.trim() || null,
            },
          });
          closeModal();
          if (res.data.mode === 'confirmed') {
            showToast(`Abonnement ${plan.name} activé et facture générée !`, 'success');
          } else {
            showToast('Preuve de paiement enregistrée — en attente de validation Super-Admin.', 'info');
          }
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  });
}

// -------------------------------------------------------------
// EXTENSION 2 (SECTIONS 8, 9, 10) : ESPACE SUPER-ADMIN « FINANCES RESTOGEST »
// -------------------------------------------------------------
export function renderSaasFinancesAdminModule(state, { cur, statusBadge }) {
  const overview = state.saasAdminOverview;
  const subtab = state.subtabs.saasAdmin || 'transactions';

  if (!overview) {
    return `<div class="card"><p class="muted-text">Chargement des données financières SaaS RESTOGEST...</p></div>`;
  }

  const k = overview.kpis || {};
  const transactions = overview.transactions || [];
  const subscriptions = overview.subscriptions || [];
  const invoices = overview.invoices || [];
  const payouts = overview.payouts || [];
  const merch = overview.merchantSettings || {};

  return `
    <div class="card" style="margin-bottom:16px;border-left:4px solid var(--primary);">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <div>
          <h3 style="margin:0;">🏦 Finances RESTOGEST — Pilotage des Revenus SaaS</h3>
          <p class="muted-text" style="margin:4px 0 0;font-size:12px;">
            Séparation comptable stricte : ces montants concernent exclusivement les abonnements payés par les établissements clients à RESTOGEST.
          </p>
        </div>
        <button type="button" id="btn-export-saas-csv" class="btn btn-outline btn-sm">📥 Exporter Transactions (CSV)</button>
      </div>
    </div>

    <div class="kpi-grid">
      <div class="card kpi-card">
        <div class="kpi-label">Encaissé Confirmé (Brut)</div>
        <div class="kpi-value" style="color:var(--success)">${esc(fmtMoney(k.confirmedGrossRevenue || 0, 'XOF'))}</div>
        <div class="kpi-foot">${k.confirmedCount || 0} paiement(s) confirmé(s)</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Revenu Net Attendu (Après frais)</div>
        <div class="kpi-value" style="color:var(--primary)">${esc(fmtMoney(k.netExpectedRevenue || 0, 'XOF'))}</div>
        <div class="kpi-foot">Frais prestataires : ${esc(fmtMoney(k.totalProviderFees || 0, 'XOF'))}</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Reversements Reçus vs Solde à recevoir</div>
        <div class="kpi-value">${esc(fmtMoney(k.settledPayoutsTotal || 0, 'XOF'))}</div>
        <div class="kpi-foot">Non encore reversé : <strong>${esc(fmtMoney(k.unsettledBalance || 0, 'XOF'))}</strong></div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">MRR / ARR &amp; Abonnements</div>
        <div class="kpi-value">${esc(fmtMoney(k.mrr || 0, 'XOF'))} <span style="font-size:12px;">/mois</span></div>
        <div class="kpi-foot">ARR: ${esc(fmtMoney(k.arr || 0, 'XOF'))} • Actifs: ${k.activeSubscriptionsCount || 0} • Essai: ${k.trialSubscriptionsCount || 0}</div>
      </div>
    </div>

    <div class="subtabs">
      <button type="button" class="subtab ${subtab === 'transactions' ? 'active' : ''}" data-sa-subtab="transactions">
        💳 Paiements &amp; Approbations (${transactions.length})
      </button>
      <button type="button" class="subtab ${subtab === 'subscriptions' ? 'active' : ''}" data-sa-subtab="subscriptions">
        🏢 Abonnements Clients (${subscriptions.length})
      </button>
      <button type="button" class="subtab ${subtab === 'payouts' ? 'active' : ''}" data-sa-subtab="payouts">
        🏦 Reversements &amp; Comptes Marchands
      </button>
    </div>

    ${
      subtab === 'transactions'
        ? `
          <div class="card">
            <div class="section-head">
              <h3>Journal des Transactions d'Abonnement SaaS</h3>
              <span class="muted-text">En attente : ${esc(fmtMoney(k.pendingAmount || 0, 'XOF'))} (${k.pendingCount || 0})</span>
            </div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead>
                  <tr>
                    <th>Réf.</th>
                    <th>Client</th>
                    <th>Plan</th>
                    <th>Brut / Net</th>
                    <th>Méthode / Réf.</th>
                    <th>Statut</th>
                    <th>Actions Super-Admin</th>
                  </tr>
                </thead>
                <tbody>
                  ${
                    transactions.length === 0
                      ? '<tr><td colspan="7" class="muted-text">Aucune transaction enregistrée.</td></tr>'
                      : transactions
                          .map(
                            (tx) => `<tr>
                              <td class="mono"><strong>${esc(tx.transaction_ref)}</strong><div class="muted-text" style="font-size:10px;">${esc(fmtDate(tx.created_at))}</div></td>
                              <td><strong>${esc(tx.company_name)}</strong><div class="muted-text" style="font-size:11px;">${esc(tx.payer_phone || tx.company_email || '')}</div></td>
                              <td>${esc(tx.plan_code)} (${esc(tx.billing_period)})</td>
                              <td class="mono">
                                <strong>${esc(fmtMoney(tx.gross_amount, tx.currency))}</strong>
                                <div class="muted-text" style="font-size:10px;">Net: ${esc(fmtMoney(tx.net_expected_amount, tx.currency))}</div>
                              </td>
                              <td>${esc(tx.payment_method)} ${tx.manual_reference ? `<div class="mono" style="font-size:10px;color:#fdba74;">Réf: ${esc(tx.manual_reference)}</div>` : ''}</td>
                              <td><span class="status-pill ${tx.status === 'confirmed' ? 'status-open' : tx.status === 'pending' ? 'status-pending' : 'status-closed'}">${esc(tx.status)}</span></td>
                              <td>
                                ${
                                  tx.status === 'pending'
                                    ? `<div style="display:flex;gap:6px;">
                                        <button type="button" class="btn btn-success btn-sm" data-sa-confirm-tx="${esc(tx.id)}">✓ Valider</button>
                                        <button type="button" class="btn btn-danger btn-sm" data-sa-reject-tx="${esc(tx.id)}">✕ Rejeter</button>
                                      </div>`
                                    : '<span class="muted-text">Verrouillée</span>'
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
      subtab === 'subscriptions'
        ? `
          <div class="card">
            <div class="section-head"><h3>Parc des Établissements Abonnés</h3></div>
            <div class="table-wrap">
              <table class="responsive-table">
                <thead>
                  <tr>
                    <th>Établissement</th>
                    <th>Formule</th>
                    <th>Statut</th>
                    <th>Fin de période</th>
                    <th>Action Administrative (Auditée)</th>
                  </tr>
                </thead>
                <tbody>
                  ${subscriptions
                    .map(
                      (s) => `<tr>
                        <td><strong>${esc(s.company_name)}</strong><div class="muted-text" style="font-size:11px;">${esc(s.company_email || '')}</div></td>
                        <td>${esc(s.plan_name || s.plan_code)} (${esc(s.billing_period)})</td>
                        <td>${statusBadge(s.status)}</td>
                        <td>${esc(fmtDate(s.current_period_end))}</td>
                        <td>
                          <button type="button" class="btn btn-outline btn-sm" data-sa-override-sub="${esc(s.id)}" data-comp-name="${esc(s.company_name)}" data-curr-status="${esc(s.status)}">
                            ⚙️ Gérer / Prolonger
                          </button>
                        </td>
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
      subtab === 'payouts'
        ? `
          <div class="two-col">
            <div class="card">
              <div class="section-head"><h3>Enregistrer un Reversement Reçu (Payout)</h3></div>
              <form id="form-sa-create-payout" class="form-stack">
                <div class="field-row">
                  <div class="field">
                    <label>Prestataire source</label>
                    <input id="po-provider" required value="PayDunya / Wave Business" />
                  </div>
                  <div class="field">
                    <label>Compte récepteur RESTOGEST</label>
                    <input id="po-dest" required value="${esc(merch.bank_name || 'Compte UBA RESTOGEST')}" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Montant brut collecté (XOF)</label>
                    <input id="po-gross" type="number" min="1" required placeholder="100000" />
                  </div>
                  <div class="field">
                    <label>Frais retenus (XOF)</label>
                    <input id="po-fees" type="number" min="0" value="0" />
                  </div>
                </div>
                <div class="field">
                  <label>Notes / Référence bordereau bancaire</label>
                  <input id="po-notes" placeholder="Ex: Virement hebdomadaire PayDunya #882" />
                </div>
                <button type="submit" class="btn btn-primary">Enregistrer le reversement effectif</button>
              </form>

              <div style="margin-top:16px;">
                <h4>Historique des reversements (${payouts.length})</h4>
                <div class="table-wrap">
                  <table class="responsive-table">
                    <thead><tr><th>Réf.</th><th>Source → Compte</th><th>Net Reçu</th><th>Statut</th></tr></thead>
                    <tbody>
                      ${
                        payouts.length === 0
                          ? '<tr><td colspan="4" class="muted-text">Aucun reversement enregistré.</td></tr>'
                          : payouts
                              .map(
                                (p) => `<tr>
                                  <td class="mono">${esc(p.payout_ref)}</td>
                                  <td>${esc(p.payment_provider)} → ${esc(p.destination_account)}</td>
                                  <td class="mono"><strong>${esc(fmtMoney(p.net_settled_amount, p.currency))}</strong></td>
                                  <td><span class="status-pill status-open">${esc(p.status)}</span></td>
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
              <div class="section-head"><h3>Coordonnées Marchand du Propriétaire RESTOGEST</h3></div>
              <form id="form-sa-merchant-settings" class="form-stack">
                <div class="field-row">
                  <div class="field">
                    <label>Raison sociale</label>
                    <input id="ms-legal" required value="${esc(merch.legal_name || '')}" />
                  </div>
                  <div class="field">
                    <label>Email facturation</label>
                    <input id="ms-email" value="${esc(merch.support_email || '')}" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Numéro Marchand Wave</label>
                    <input id="ms-wave" value="${esc(merch.wave_merchant_number || '')}" />
                  </div>
                  <div class="field">
                    <label>Numéro Marchand Orange Money</label>
                    <input id="ms-om" value="${esc(merch.orange_money_merchant_number || '')}" />
                  </div>
                </div>
                <div class="field-row">
                  <div class="field">
                    <label>Banque réceptrice</label>
                    <input id="ms-bank" value="${esc(merch.bank_name || '')}" />
                  </div>
                  <div class="field">
                    <label>IBAN / RIB</label>
                    <input id="ms-iban" value="${esc(merch.bank_iban || '')}" />
                  </div>
                </div>
                <button type="submit" class="btn btn-primary">Mettre à jour les comptes récepteurs</button>
              </form>
            </div>
          </div>
        `
        : ''
    }
  `;
}

export function bindSaasFinancesAdminModule(state, { openModal, closeModal, refreshAllData, renderRoute }) {
  document.querySelectorAll('[data-sa-subtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.subtabs.saasAdmin = btn.dataset.saSubtab;
      renderRoute();
    });
  });

  document.getElementById('btn-export-saas-csv')?.addEventListener('click', () => {
    const txs = state.saasAdminOverview?.transactions || [];
    if (txs.length === 0) {
      showToast('Aucune transaction à exporter', 'warning');
      return;
    }
    const headers = ['Reference', 'Date', 'Etablissement', 'Plan', 'Periode', 'Devise', 'Montant_Brut', 'Frais', 'Montant_Net', 'Methode', 'Statut'];
    const rows = txs.map((t) => [
      t.transaction_ref,
      t.created_at,
      `"${String(t.company_name || '').replace(/"/g, '""')}"`,
      t.plan_code,
      t.billing_period,
      t.currency,
      t.gross_amount,
      t.provider_fee_amount,
      t.net_expected_amount,
      t.payment_method,
      t.status,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `finances-restogest-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.querySelectorAll('[data-sa-confirm-tx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/subscriptions/admin/transactions/${btn.dataset.saConfirmTx}/confirm`, {
          method: 'POST',
          body: { note: 'Confirmé depuis Finances RESTOGEST' },
        });
        showToast('Paiement confirmé, abonnement activé et facture émise !', 'success');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-sa-reject-tx]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await apiFetch(`/api/subscriptions/admin/transactions/${btn.dataset.saRejectTx}/reject`, {
          method: 'POST',
          body: { reason: 'Référence bancaire / Mobile Money non reçue' },
        });
        showToast('Transaction marquée comme échouée', 'info');
        await refreshAllData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  });

  document.querySelectorAll('[data-sa-override-sub]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const subId = btn.dataset.saOverrideSub;
      const compName = btn.dataset.compName;
      const currStatus = btn.dataset.currStatus;

      openModal(
        `Gestion Administrative • ${compName}`,
        `<form id="form-sa-override-sub" class="form-stack">
          <div class="field">
            <label>Statut de l'abonnement</label>
            <select id="sao-status">
              ${['trial', 'active', 'pending_payment', 'past_due', 'suspended', 'cancelled', 'expired']
                .map((st) => `<option value="${st}" ${currStatus === st ? 'selected' : ''}>${st}</option>`)
                .join('')}
            </select>
          </div>
          <div class="field">
            <label>Prolongation exceptionnelle (en jours, optionnel)</label>
            <input id="sao-days" type="number" min="0" max="365" value="0" />
          </div>
          <div class="field">
            <label>Motif obligatoire (Journalisé dans l'audit de sécurité)</label>
            <input id="sao-reason" required minlength="4" placeholder="Ex: Geste commercial / Validation contrat annuel..." />
          </div>
          <button type="submit" class="btn btn-primary btn-full">Appliquer et journaliser</button>
        </form>`
      );

      document.getElementById('form-sa-override-sub')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const days = parseInt(document.getElementById('sao-days').value || '0', 10);
          await apiFetch(`/api/subscriptions/admin/subscriptions/${subId}/status`, {
            method: 'POST',
            body: {
              status: document.getElementById('sao-status').value,
              extendDays: days > 0 ? days : undefined,
              reason: document.getElementById('sao-reason').value.trim(),
            },
          });
          closeModal();
          showToast('Abonnement mis à jour et action auditée', 'success');
          await refreshAllData();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });
  });

  document.getElementById('form-sa-create-payout')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/subscriptions/admin/payouts', {
        method: 'POST',
        body: {
          paymentProvider: document.getElementById('po-provider').value.trim(),
          destinationAccount: document.getElementById('po-dest').value.trim(),
          grossCollectedAmount: parseFloat(document.getElementById('po-gross').value || '0'),
          providerFeesAmount: parseFloat(document.getElementById('po-fees').value || '0'),
          notes: document.getElementById('po-notes').value.trim() || null,
        },
      });
      showToast('Reversement (payout) enregistré !', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  document.getElementById('form-sa-merchant-settings')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await apiFetch('/api/subscriptions/admin/merchant-settings', {
        method: 'PUT',
        body: {
          legalName: document.getElementById('ms-legal').value.trim(),
          supportEmail: document.getElementById('ms-email').value.trim(),
          waveMerchantNumber: document.getElementById('ms-wave').value.trim(),
          orangeMoneyMerchantNumber: document.getElementById('ms-om').value.trim(),
          bankName: document.getElementById('ms-bank').value.trim(),
          bankIban: document.getElementById('ms-iban').value.trim(),
        },
      });
      showToast('Coordonnées marchandes RESTOGEST mises à jour', 'success');
      await refreshAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}
