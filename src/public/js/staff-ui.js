import { apiFetch, esc, fmtDate, fmtMoney, showToast } from './api.js';

export function renderStaffModule(state) {
  const staff = state.staffMembers || [];
  const presets = state.staffPresets?.presets || [];
  const permDefs = state.staffPresets?.permissions || [];
  const activity = state.staffActivity || [];
  const filterUserId = state.staffActivityUserFilter || '';

  const groupedPerms = permDefs.reduce((acc, p) => {
    (acc[p.group] ||= []).push(p);
    return acc;
  }, {});

  const defaultPreset = presets.find((p) => p.code === 'cashier') || presets[0];

  return `
    <div class="kpi-grid" style="margin-bottom:16px;">
      <div class="card kpi-card">
        <div class="kpi-label">Membres de l'équipe</div>
        <div class="kpi-value">${staff.length}</div>
        <div class="kpi-foot">${staff.filter((m) => m.isActive).length} actif(s) • ${staff.filter((m) => !m.isActive).length} suspendu(s)</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Comptes individuels</div>
        <div class="kpi-value" style="color:var(--success)">100 %</div>
        <div class="kpi-foot">Identifiants personnels + droits contrôlés côté serveur</div>
      </div>
      <div class="card kpi-card">
        <div class="kpi-label">Activités tracées</div>
        <div class="kpi-value">${activity.length}</div>
        <div class="kpi-foot">Journal d'audit immuable par employé</div>
      </div>
    </div>

    <div class="two-col" style="margin-bottom:16px;">
      <div class="card">
        <div class="section-head">
          <div>
            <h3>Ajouter un employé</h3>
            <p class="muted-text" style="margin:4px 0 0;font-size:12px;">
              Créez un compte individuel avec un rôle métier et des permissions adaptées. Ne partagez jamais votre mot de passe propriétaire.
            </p>
          </div>
        </div>
        <form id="staff-create-form" class="form-stack">
          <div class="field-row">
            <div class="field">
              <label for="st-fullname">Nom complet</label>
              <input id="st-fullname" required minlength="2" placeholder="Ex: Fatou Sarr" />
            </div>
            <div class="field">
              <label for="st-email">Adresse e-mail de connexion</label>
              <input id="st-email" type="email" required placeholder="fatou@monresto.sn" />
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="st-password">Mot de passe initial (8 car. min.)</label>
              <div style="display:flex;gap:6px;">
                <input id="st-password" type="text" required minlength="8" placeholder="Employe2026!" style="flex:1;" />
                <button type="button" id="btn-gen-staff-pwd" class="btn btn-outline btn-sm">Aléatoire</button>
              </div>
            </div>
            <div class="field">
              <label for="st-preset">Rôle métier</label>
              <select id="st-preset">
                ${presets
                  .map(
                    (p) =>
                      `<option value="${esc(p.code)}" ${defaultPreset?.code === p.code ? 'selected' : ''}>${esc(p.name)}</option>`
                  )
                  .join('')}
              </select>
            </div>
          </div>
          <p id="st-preset-desc" class="muted-text" style="margin:0;font-size:12px;">
            ${esc(defaultPreset?.description || '')}
          </p>

          <details style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;">
            <summary style="cursor:pointer;font-weight:600;font-size:13px;">Personnaliser les autorisations (optionnel)</summary>
            <div id="st-perms-box" style="margin-top:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:10px;">
              ${Object.entries(groupedPerms)
                .map(
                  ([group, list]) => `
                  <div style="font-size:12px;">
                    <div style="font-weight:700;margin-bottom:4px;color:var(--primary);">${esc(group)}</div>
                    ${list
                      .map((perm) => {
                        const checked =
                          defaultPreset?.permissions?.all === true || defaultPreset?.permissions?.[perm.key] === true;
                        return `<label style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px;cursor:pointer;">
                          <input type="checkbox" class="st-perm-cb" value="${esc(perm.key)}" ${checked ? 'checked' : ''} style="margin-top:2px;" />
                          <span>${esc(perm.label)}</span>
                        </label>`;
                      })
                      .join('')}
                  </div>`
                )
                .join('')}
            </div>
          </details>

          <button type="submit" class="btn btn-primary">Créer le compte employé</button>
        </form>

        ${
          state.lastCreatedStaff
            ? `<div style="margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.4);font-size:13px;">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
                  <strong>Compte créé : ${esc(state.lastCreatedStaff.fullName)} (${esc(state.lastCreatedStaff.roleName)})</strong>
                  <button type="button" id="btn-copy-staff-creds" class="btn btn-success btn-sm">Copier les accès</button>
                </div>
                <div class="mono" style="margin-top:6px;font-size:12px;">
                  E-mail : <strong>${esc(state.lastCreatedStaff.email)}</strong> &nbsp;|&nbsp; Mot de passe : <strong>${esc(state.lastCreatedStaff.password)}</strong>
                </div>
              </div>`
            : ''
        }
      </div>

      <div class="card">
        <div class="section-head"><h3>Membres de l'établissement (${staff.length})</h3></div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead>
              <tr><th>Employé</th><th>Rôle &amp; Accès</th><th>Statut</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${
                staff.length === 0
                  ? '<tr><td colspan="4" class="muted-text">Aucun membre trouvé.</td></tr>'
                  : staff
                      .map((m) => {
                        const isSelf = m.id === state.user?.id;
                        const permCount = m.permissions?.all
                          ? 'Tous les modules'
                          : `${Object.values(m.permissions || {}).filter(Boolean).length} autorisation(s)`;
                        return `<tr>
                          <td data-label="Employé">
                            <strong>${esc(m.fullName)}</strong> ${isSelf ? '<span class="status-pill status-info">Vous</span>' : ''}
                            <div class="muted-text" style="font-size:11px;">${esc(m.email)}</div>
                            ${m.lastActivityAt ? `<div class="muted-text" style="font-size:10px;">Dernière activité : ${esc(fmtDate(m.lastActivityAt))}</div>` : ''}
                          </td>
                          <td data-label="Rôle">
                            <strong>${esc(m.roleName)}</strong>
                            <div class="muted-text" style="font-size:11px;">${esc(permCount)}</div>
                          </td>
                          <td data-label="Statut">
                            <span class="status-pill ${m.isActive ? 'status-open' : 'status-closed'}">${m.isActive ? 'Actif' : 'Suspendu'}</span>
                          </td>
                          <td data-label="Actions">
                            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                              <button type="button" class="btn btn-outline btn-sm" data-staff-edit="${esc(m.id)}">Modifier</button>
                              ${
                                !isSelf
                                  ? m.isActive
                                    ? `<button type="button" class="btn btn-danger btn-sm" data-staff-toggle="${esc(m.id)}" data-next-active="false">Suspendre</button>`
                                    : `<button type="button" class="btn btn-success btn-sm" data-staff-toggle="${esc(m.id)}" data-next-active="true">Réactiver</button>`
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

    <div class="card">
      <div class="section-head">
        <h3>Historique d'activité de l'équipe</h3>
        <select id="staff-activity-filter" class="input-inline" style="max-width:220px;">
          <option value="">Tous les membres</option>
          ${staff
            .map(
              (m) =>
                `<option value="${esc(m.id)}" ${filterUserId === m.id ? 'selected' : ''}>${esc(m.fullName)} (${esc(m.roleName)})</option>`
            )
            .join('')}
        </select>
      </div>
      <div class="table-wrap">
        <table class="responsive-table">
          <thead><tr><th>Date</th><th>Employé</th><th>Action</th><th>Module</th></tr></thead>
          <tbody>
            ${
              activity.length === 0
                ? '<tr><td colspan="4" class="muted-text">Aucune activité enregistrée pour ce filtre.</td></tr>'
                : activity
                    .map(
                      (ev) => `<tr>
                        <td data-label="Date" class="mono" style="font-size:11px;">${esc(fmtDate(ev.created_at))}</td>
                        <td data-label="Employé"><strong>${esc(ev.user_name || 'Système')}</strong><div class="muted-text" style="font-size:11px;">${esc(ev.user_email || '')}</div></td>
                        <td data-label="Action"><strong>${esc(ev.action)}</strong></td>
                        <td data-label="Module" class="mono" style="font-size:11px;">${esc(ev.table_name || '—')}</td>
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

export function bindStaffModule(state, { openModal, closeModal, confirmActionModal, refreshAllData, withFormSubmit }) {
  const presets = state.staffPresets?.presets || [];
  const permDefs = state.staffPresets?.permissions || [];

  const syncPresetCheckboxes = (presetCode, container) => {
    const preset = presets.find((p) => p.code === presetCode);
    if (!preset || !container) return;
    const descEl = document.getElementById('st-preset-desc');
    if (descEl && container.id === 'st-perms-box') descEl.textContent = preset.description || '';
    container.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.checked = preset.permissions?.all === true || preset.permissions?.[cb.value] === true;
    });
  };

  document.getElementById('st-preset')?.addEventListener('change', (e) => {
    syncPresetCheckboxes(e.target.value, document.getElementById('st-perms-box'));
  });

  document.getElementById('btn-gen-staff-pwd')?.addEventListener('click', () => {
    const inp = document.getElementById('st-password');
    if (inp) inp.value = `Resto-${Math.random().toString(36).slice(2, 8).toUpperCase()}26!`;
  });

  document.getElementById('btn-copy-staff-creds')?.addEventListener('click', async () => {
    if (!state.lastCreatedStaff) return;
    const txt = `Accès MyRestoGest (${state.company?.name || ''})\nURL : ${window.location.origin}/\nNom : ${state.lastCreatedStaff.fullName}\nRôle : ${state.lastCreatedStaff.roleName}\nE-mail : ${state.lastCreatedStaff.email}\nMot de passe : ${state.lastCreatedStaff.password}`;
    try {
      await navigator.clipboard.writeText(txt);
      showToast('Identifiants copiés dans le presse-papiers', 'success');
    } catch {
      showToast('Copiez manuellement les identifiants affichés.', 'info');
    }
  });

  const createForm = document.getElementById('staff-create-form');
  createForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await withFormSubmit(createForm, async () => {
      const presetCode = document.getElementById('st-preset').value;
      const preset = presets.find((p) => p.code === presetCode);
      const checkedPerms = {};
      if (preset?.permissions?.all === true) {
        checkedPerms.all = true;
      } else {
        document.querySelectorAll('#st-perms-box .st-perm-cb:checked').forEach((cb) => {
          checkedPerms[cb.value] = true;
        });
      }
      const password = document.getElementById('st-password').value;
      const res = await apiFetch('/api/staff', {
        method: 'POST',
        body: {
          fullName: document.getElementById('st-fullname').value.trim(),
          email: document.getElementById('st-email').value.trim(),
          password,
          rolePreset: presetCode,
          roleName: preset?.name || 'Employé',
          permissions: checkedPerms,
        },
      });
      state.lastCreatedStaff = { ...res.data, password };
      showToast(`Compte créé pour ${res.data.fullName}`, 'success');
      await refreshAllData({ force: true });
    });
  });

  document.querySelectorAll('[data-staff-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const member = (state.staffMembers || []).find((m) => m.id === btn.dataset.staffEdit);
      if (!member) return;
      const grouped = permDefs.reduce((acc, p) => {
        (acc[p.group] ||= []).push(p);
        return acc;
      }, {});
      openModal(
        `Modifier ${member.fullName}`,
        `
          <form id="staff-edit-form" class="form-stack">
            <div class="field">
              <label for="ste-name">Nom complet</label>
              <input id="ste-name" required minlength="2" value="${esc(member.fullName)}" />
            </div>
            <div class="field-row">
              <div class="field">
                <label for="ste-preset">Rôle métier</label>
                <select id="ste-preset">
                  ${presets
                    .map(
                      (p) =>
                        `<option value="${esc(p.code)}" ${member.roleCode === p.code ? 'selected' : ''}>${esc(p.name)}</option>`
                    )
                    .join('')}
                </select>
              </div>
              <div class="field">
                <label for="ste-pwd">Nouveau mot de passe (optionnel)</label>
                <input id="ste-pwd" type="text" minlength="8" placeholder="Laisser vide pour ne pas changer" />
              </div>
            </div>
            <div id="ste-perms-box" style="max-height:240px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:10px;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;">
              ${Object.entries(grouped)
                .map(
                  ([group, list]) => `<div style="font-size:12px;">
                    <div style="font-weight:700;margin-bottom:4px;color:var(--primary);">${esc(group)}</div>
                    ${list
                      .map((perm) => {
                        const checked = member.permissions?.all === true || member.permissions?.[perm.key] === true;
                        return `<label style="display:flex;align-items:flex-start;gap:6px;margin-bottom:4px;cursor:pointer;">
                          <input type="checkbox" class="ste-perm-cb" value="${esc(perm.key)}" ${checked ? 'checked' : ''} style="margin-top:2px;" />
                          <span>${esc(perm.label)}</span>
                        </label>`;
                      })
                      .join('')}
                  </div>`
                )
                .join('')}
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button type="button" id="btn-ste-cancel" class="btn btn-outline">Annuler</button>
              <button type="submit" class="btn btn-primary">Enregistrer les modifications</button>
            </div>
          </form>
        `
      );
      document.getElementById('btn-ste-cancel')?.addEventListener('click', closeModal);
      document.getElementById('ste-preset')?.addEventListener('change', (e) => {
        syncPresetCheckboxes(e.target.value, document.getElementById('ste-perms-box'));
      });
      const editForm = document.getElementById('staff-edit-form');
      editForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await withFormSubmit(editForm, async () => {
          const presetCode = document.getElementById('ste-preset').value;
          const preset = presets.find((p) => p.code === presetCode);
          const perms = {};
          if (preset?.permissions?.all === true) {
            perms.all = true;
          } else {
            document.querySelectorAll('#ste-perms-box .ste-perm-cb:checked').forEach((cb) => {
              perms[cb.value] = true;
            });
          }
          const newPwd = document.getElementById('ste-pwd').value.trim();
          await apiFetch(`/api/staff/${member.id}`, {
            method: 'PUT',
            body: {
              fullName: document.getElementById('ste-name').value.trim(),
              rolePreset: presetCode,
              roleName: preset?.name || member.roleName,
              permissions: perms,
              ...(newPwd ? { password: newPwd } : {}),
            },
          });
          closeModal();
          showToast('Profil employé mis à jour', 'success');
          await refreshAllData({ force: true });
        });
      });
    });
  });

  document.querySelectorAll('[data-staff-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const nextActive = btn.dataset.nextActive === 'true';
      const member = (state.staffMembers || []).find((m) => m.id === btn.dataset.staffToggle);
      confirmActionModal({
        title: nextActive ? 'Réactiver ce compte employé ?' : 'Suspendre ce compte employé ?',
        message: nextActive
          ? `${member?.fullName || 'Cet employé'} pourra de nouveau se connecter avec ses autorisations.`
          : `${member?.fullName || 'Cet employé'} sera immédiatement déconnecté et ne pourra plus accéder à l'établissement.`,
        confirmLabel: nextActive ? 'Réactiver' : 'Suspendre',
        variant: nextActive ? 'success' : 'danger',
        onConfirm: async () => {
          await apiFetch(`/api/staff/${btn.dataset.staffToggle}/status`, {
            method: 'POST',
            body: { isActive: nextActive },
          });
          showToast(nextActive ? 'Employé réactivé' : 'Employé suspendu', 'success');
          await refreshAllData({ force: true });
        },
      });
    });
  });

  document.getElementById('staff-activity-filter')?.addEventListener('change', async (e) => {
    state.staffActivityUserFilter = e.target.value;
    try {
      const q = state.staffActivityUserFilter
        ? `?userId=${encodeURIComponent(state.staffActivityUserFilter)}&limit=80`
        : '?limit=80';
      const res = await apiFetch(`/api/staff/activity${q}`);
      state.staffActivity = res.data || [];
      await refreshAllData({ force: true });
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

export function renderCustomersModule(state, cur, canWrite) {
  const customers = state.customers || [];
  const search = (state.customerSearch || '').toLowerCase();
  const filtered = customers.filter(
    (c) =>
      !search ||
      String(c.full_name || '').toLowerCase().includes(search) ||
      String(c.phone || '').toLowerCase().includes(search) ||
      String(c.email || '').toLowerCase().includes(search)
  );

  return `
    <div class="${canWrite ? 'two-col' : ''}">
      ${
        canWrite
          ? `<div class="card">
              <div class="section-head"><h3>Nouveau client</h3></div>
              <form id="customer-create-form" class="form-stack">
                <div class="field">
                  <label for="cust-name">Nom complet</label>
                  <input id="cust-name" required minlength="2" placeholder="Ex: Moussa Diop" />
                </div>
                <div class="field-row">
                  <div class="field">
                    <label for="cust-phone">Téléphone</label>
                    <input id="cust-phone" placeholder="+221 77 ..." />
                  </div>
                  <div class="field">
                    <label for="cust-email">E-mail (optionnel)</label>
                    <input id="cust-email" type="email" placeholder="client@exemple.sn" />
                  </div>
                </div>
                <button type="submit" class="btn btn-primary">Enregistrer le client</button>
              </form>
            </div>`
          : ''
      }

      <div class="card">
        <div class="section-head">
          <h3>Fichier clients (${filtered.length})</h3>
          <input id="cust-search-input" class="input-inline" style="max-width:220px;" placeholder="Rechercher nom / tél..." value="${esc(state.customerSearch || '')}" />
        </div>
        <div class="table-wrap">
          <table class="responsive-table">
            <thead>
              <tr><th>Client</th><th>Contact</th><th>Commandes</th><th>Total dépensé</th><th>Fidélité</th>${canWrite ? '<th></th>' : ''}</tr>
            </thead>
            <tbody>
              ${
                filtered.length === 0
                  ? `<tr><td colspan="${canWrite ? 6 : 5}" class="muted-text">Aucun client enregistré.</td></tr>`
                  : filtered
                      .map(
                        (c) => `<tr>
                          <td data-label="Client"><strong>${esc(c.full_name)}</strong></td>
                          <td data-label="Contact">${esc(c.phone || '—')}<div class="muted-text" style="font-size:11px;">${esc(c.email || '')}</div></td>
                          <td data-label="Commandes" class="mono">${Number(c.orders_count || 0)}</td>
                          <td data-label="Total" class="mono">${esc(fmtMoney(c.total_spent || 0, cur))}</td>
                          <td data-label="Fidélité" class="mono">${Number(c.loyalty_points || 0)} pts</td>
                          ${
                            canWrite
                              ? `<td data-label="Action"><button type="button" class="btn btn-outline btn-sm" data-cust-edit="${esc(c.id)}">Modifier</button></td>`
                              : ''
                          }
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

export function bindCustomersModule(state, { openModal, closeModal, refreshAllData, renderRoute, withFormSubmit }) {
  document.getElementById('cust-search-input')?.addEventListener('input', (e) => {
    state.customerSearch = e.target.value;
    renderRoute();
    const inp = document.getElementById('cust-search-input');
    if (inp) {
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  });

  const form = document.getElementById('customer-create-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await withFormSubmit(form, async () => {
      const res = await apiFetch('/api/customers', {
        method: 'POST',
        body: {
          fullName: document.getElementById('cust-name').value.trim(),
          phone: document.getElementById('cust-phone').value.trim(),
          email: document.getElementById('cust-email').value.trim(),
        },
      });
      state.customers = [res.data, ...(state.customers || [])];
      showToast('Client enregistré avec succès', 'success');
      await refreshAllData({ force: true });
    });
  });

  document.querySelectorAll('[data-cust-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cust = (state.customers || []).find((c) => c.id === btn.dataset.custEdit);
      if (!cust) return;
      openModal(
        `Modifier ${cust.full_name}`,
        `
          <form id="customer-edit-form" class="form-stack">
            <div class="field">
              <label for="ce-name">Nom complet</label>
              <input id="ce-name" required minlength="2" value="${esc(cust.full_name)}" />
            </div>
            <div class="field-row">
              <div class="field">
                <label for="ce-phone">Téléphone</label>
                <input id="ce-phone" value="${esc(cust.phone || '')}" />
              </div>
              <div class="field">
                <label for="ce-email">E-mail</label>
                <input id="ce-email" type="email" value="${esc(cust.email || '')}" />
              </div>
            </div>
            <div class="field">
              <label for="ce-pts">Points de fidélité</label>
              <input id="ce-pts" type="number" min="0" value="${Number(cust.loyalty_points || 0)}" />
            </div>
            <div style="display:flex;gap:8px;justify-content:flex-end;">
              <button type="button" id="btn-ce-cancel" class="btn btn-outline">Annuler</button>
              <button type="submit" class="btn btn-primary">Enregistrer</button>
            </div>
          </form>
        `
      );
      document.getElementById('btn-ce-cancel')?.addEventListener('click', closeModal);
      const editForm = document.getElementById('customer-edit-form');
      editForm?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await withFormSubmit(editForm, async () => {
          await apiFetch(`/api/customers/${cust.id}`, {
            method: 'PUT',
            body: {
              fullName: document.getElementById('ce-name').value.trim(),
              phone: document.getElementById('ce-phone').value.trim(),
              email: document.getElementById('ce-email').value.trim(),
              loyaltyPoints: parseInt(document.getElementById('ce-pts').value || '0', 10),
            },
          });
          closeModal();
          showToast('Fiche client mise à jour', 'success');
          await refreshAllData({ force: true });
        });
      });
    });
  });
}
