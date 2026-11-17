(function () {
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  const qrToken = pathParts[pathParts.length - 1] || '';

  const state = {
    qrToken,
    establishment: null,
    table: null,
    categories: [],
    products: [],
    selectedCategoryId: 'ALL',
    searchQuery: '',
    cart: [],
    activeProductForOptions: null,
    activeOptionQuantity: 1,
    activeTrackingToken: null,
    trackerIntervalId: null,
    pendingIdempotencyKey: null,
    isSubmittingOrder: false,
  };

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(amount, currency) {
    const cur = currency || state.establishment?.currency || 'XOF';
    const num = Math.round(Number(amount || 0));
    const formatted = num.toLocaleString('fr-FR');
    return cur === 'GNF' ? `${formatted} FG` : `${formatted} FCFA`;
  }

  function showToast(message) {
    const el = document.getElementById('menu-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 3600);
  }

  function getSavedTrackingToken() {
    const urlParams = new URLSearchParams(window.location.search);
    const fromQuery = urlParams.get('track');
    if (fromQuery) return fromQuery;
    try {
      return localStorage.getItem(`rg_track_${state.qrToken}`) || null;
    } catch {
      return null;
    }
  }

  function saveTrackingToken(token) {
    state.activeTrackingToken = token;
    try {
      localStorage.setItem(`rg_track_${state.qrToken}`, token);
    } catch {
      // ignore storage errors
    }
    const btn = document.getElementById('btn-open-tracker');
    if (btn && token) {
      btn.classList.remove('hidden');
    }
  }

  async function loadPublicMenu() {
    const mainEl = document.getElementById('menu-main-content');
    try {
      const res = await fetch(`/api/public/qr/menu/${encodeURIComponent(state.qrToken)}`);
      const payload = await res.json();

      if (!res.ok) {
        const msg = payload?.error?.message || 'Impossible de charger ce menu QR.';
        if (mainEl) {
          mainEl.innerHTML = `
            <div style="padding: 32px 20px; text-align: center; background: var(--bg-card); border-radius: 16px; border: 1px solid rgba(239,68,68,0.4);">
              <div style="font-size: 2.2rem; margin-bottom: 10px;">⚠️</div>
              <h2 style="font-size: 1.15rem; margin-bottom: 8px;">Accès non disponible</h2>
              <p style="color: var(--text-muted); font-size: 0.9rem;">${escapeHtml(msg)}</p>
            </div>
          `;
        }
        return;
      }

      const data = payload.data;
      state.establishment = data.establishment;
      state.table = data.table;
      state.categories = data.categories || [];
      state.products = data.products || [];

      renderHeader();
      renderCategories();
      renderProducts();
      updateCartUI();

      const savedTrack = getSavedTrackingToken();
      if (savedTrack) {
        saveTrackingToken(savedTrack);
      }
    } catch (err) {
      if (mainEl) {
        mainEl.innerHTML = `<p style="text-align:center;color:#fca5a5;padding:30px;">Erreur réseau : veuillez vérifier votre connexion.</p>`;
      }
    }
  }

  function renderHeader() {
    const est = state.establishment;
    const tbl = state.table;
    if (!est || !tbl) return;

    document.title = `${est.displayName} — Menu Digital (${tbl.name})`;

    const nameEl = document.getElementById('est-name');
    if (nameEl) nameEl.textContent = est.displayName;

    const tagEl = document.getElementById('est-tagline');
    if (tagEl) tagEl.textContent = est.tagline || 'Commandez depuis votre table';

    const avatarEl = document.getElementById('brand-avatar');
    if (avatarEl) {
      if (est.logoUrl) {
        avatarEl.innerHTML = `<img src="${escapeHtml(est.logoUrl)}" alt="${escapeHtml(est.displayName)}" />`;
      } else {
        const initials = est.displayName
          .split(/\s+/)
          .slice(0, 2)
          .map((w) => w[0] || '')
          .join('')
          .toUpperCase();
        avatarEl.textContent = initials || 'RG';
      }
    }

    const coverEl = document.getElementById('hero-cover');
    if (coverEl && est.coverImageUrl) {
      coverEl.src = est.coverImageUrl;
      coverEl.classList.remove('hidden');
    }

    const tableBadge = document.getElementById('table-badge');
    if (tableBadge) {
      if (tbl.tableType === 'takeaway_qr') {
        tableBadge.textContent = `🛍️ Commande À Emporter (${tbl.code})`;
      } else if (tbl.tableType === 'counter') {
        tableBadge.textContent = `🏪 Comptoir (${tbl.code})`;
      } else {
        tableBadge.textContent = `📍 ${tbl.name} (${tbl.code}) • ${tbl.zone}`;
      }
    }

    const addrBadge = document.getElementById('est-address-badge');
    if (addrBadge && est.address) {
      addrBadge.textContent = `🗺️ ${est.address}`;
      addrBadge.classList.remove('hidden');
    }

    const phoneBadge = document.getElementById('est-phone-badge');
    if (phoneBadge && est.phone) {
      phoneBadge.textContent = `📞 ${est.phone}`;
      phoneBadge.classList.remove('hidden');
    }

    const welcomeBox = document.getElementById('welcome-box');
    if (welcomeBox && est.welcomeMessage) {
      welcomeBox.textContent = est.welcomeMessage;
    }

    const btnCallWaiter = document.getElementById('btn-call-waiter');
    if (btnCallWaiter) {
      btnCallWaiter.classList.toggle('hidden', !est.allowCallWaiter);
    }

    const btnRequestBill = document.getElementById('btn-request-bill');
    if (btnRequestBill) {
      btnRequestBill.classList.toggle('hidden', !est.allowRequestBill);
    }

    const lblName = document.getElementById('lbl-customer-name');
    if (lblName) {
      lblName.textContent = est.requireCustomerName
        ? 'Votre nom ou prénom (obligatoire *)'
        : 'Votre nom ou prénom (optionnel)';
    }

    const lblPhone = document.getElementById('lbl-customer-phone');
    if (lblPhone) {
      lblPhone.textContent = est.requireCustomerPhone
        ? 'Téléphone / WhatsApp (obligatoire *)'
        : 'Téléphone / WhatsApp (optionnel)';
    }

    const orderTypeSel = document.getElementById('cart-order-type');
    if (orderTypeSel && tbl.tableType === 'takeaway_qr') {
      orderTypeSel.value = 'takeaway';
    }
  }

  function renderCategories() {
    const wrap = document.getElementById('category-chips');
    if (!wrap) return;

    const chips = [
      { id: 'ALL', name: '✨ Toute la carte' },
      ...state.categories.map((c) => ({ id: c.id, name: c.name })),
    ];

    wrap.innerHTML = chips
      .map(
        (c) => `
          <button
            type="button"
            class="cat-chip ${state.selectedCategoryId === c.id ? 'active' : ''}"
            data-cat-id="${escapeHtml(c.id)}"
          >
            ${escapeHtml(c.name)}
          </button>
        `
      )
      .join('');

    wrap.querySelectorAll('.cat-chip').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedCategoryId = btn.getAttribute('data-cat-id') || 'ALL';
        renderCategories();
        renderProducts();
      });
    });
  }

  function renderProducts() {
    const mainEl = document.getElementById('menu-main-content');
    if (!mainEl) return;

    const q = state.searchQuery.trim().toLowerCase();
    const filtered = state.products.filter((p) => {
      if (state.selectedCategoryId !== 'ALL' && p.categoryId !== state.selectedCategoryId) {
        return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.categoryName && p.categoryName.toLowerCase().includes(q))
      );
    });

    if (filtered.length === 0) {
      mainEl.innerHTML = `
        <div style="text-align:center;padding:40px 16px;color:var(--text-muted);">
          Aucun produit ne correspond à votre recherche.
        </div>
      `;
      return;
    }

    // Group by categoryName
    const grouped = new Map();
    for (const p of filtered) {
      const catTitle = p.categoryName || 'Carte & Spécialités';
      if (!grouped.has(catTitle)) grouped.set(catTitle, []);
      grouped.get(catTitle).push(p);
    }

    const htmlSections = [];
    for (const [catName, prods] of grouped.entries()) {
      const cardsHtml = prods
        .map((p) => {
          const hasOptions = Array.isArray(p.optionGroups) && p.optionGroups.length > 0;
          const canOrder = state.establishment?.qrOrderingEnabled !== false && p.isAvailable;

          return `
            <article class="product-card ${!p.isAvailable ? 'unavailable' : ''}">
              <div class="prod-info">
                <div class="prod-badges">
                  ${p.isPopular ? '<span class="badge-popular">★ Populaire</span>' : ''}
                  ${!p.isAvailable ? '<span class="badge-out">Épuisé / Indisponible</span>' : ''}
                  ${hasOptions ? '<span class="badge-options">Personnalisable</span>' : ''}
                  ${p.prepTimeMinutes ? `<span class="badge-options">⏱ ~${p.prepTimeMinutes} min</span>` : ''}
                </div>
                <div class="prod-name">${escapeHtml(p.name)}</div>
                ${p.description ? `<div class="prod-desc">${escapeHtml(p.description)}</div>` : ''}
                ${
                  Array.isArray(p.allergens) && p.allergens.length > 0
                    ? `<div class="prod-allergens">Allergènes : ${escapeHtml(p.allergens.join(', '))}</div>`
                    : ''
                }
                <div class="prod-price">${formatMoney(p.sellingPrice)}</div>
              </div>
              <div class="prod-side">
                ${
                  p.imageUrl
                    ? `<img class="prod-thumb" src="${escapeHtml(p.imageUrl)}" alt="${escapeHtml(p.name)}" />`
                    : ''
                }
                <button
                  type="button"
                  class="add-btn"
                  data-product-id="${escapeHtml(p.id)}"
                  ${!canOrder ? 'disabled' : ''}
                >
                  ${!p.isAvailable ? 'Indisponible' : hasOptions ? 'Choisir' : '+ Ajouter'}
                </button>
              </div>
            </article>
          `;
        })
        .join('');

      htmlSections.push(`
        <section class="cat-section">
          <div class="cat-title">
            <span>${escapeHtml(catName)}</span>
            <span style="font-size:0.78rem;color:var(--text-muted);">${prods.length} produit(s)</span>
          </div>
          <div class="products-grid">${cardsHtml}</div>
        </section>
      `);
    }

    mainEl.innerHTML = htmlSections.join('');

    mainEl.querySelectorAll('.add-btn[data-product-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const prodId = btn.getAttribute('data-product-id');
        const product = state.products.find((item) => item.id === prodId);
        if (!product) return;
        openProductOptionsModal(product);
      });
    });
  }

  function openProductOptionsModal(product) {
    state.activeProductForOptions = product;
    state.activeOptionQuantity = 1;

    const modal = document.getElementById('modal-product-options');
    const titleEl = document.getElementById('opt-modal-title');
    const descEl = document.getElementById('opt-modal-desc');
    const groupsContainer = document.getElementById('opt-groups-container');
    const customMsgWrap = document.getElementById('opt-custom-message-wrap');
    const customMsgInput = document.getElementById('opt-custom-message');
    const itemNoteInput = document.getElementById('opt-item-note');
    const qtyValEl = document.getElementById('opt-qty-val');

    if (!modal || !groupsContainer) return;

    if (titleEl) titleEl.textContent = product.name;
    if (descEl) descEl.textContent = product.description || `Prix de base : ${formatMoney(product.sellingPrice)}`;
    if (customMsgInput) customMsgInput.value = '';
    if (itemNoteInput) itemNoteInput.value = '';
    if (qtyValEl) qtyValEl.textContent = '1';

    const groups = Array.isArray(product.optionGroups) ? product.optionGroups : [];
    const allowsCustomCakeMsg = groups.some((g) => g.allowCustomText);
    if (customMsgWrap) {
      customMsgWrap.classList.toggle('hidden', !allowsCustomCakeMsg);
    }

    groupsContainer.innerHTML = groups
      .map((grp) => {
        const inputType = grp.selectionType === 'single' ? 'radio' : 'checkbox';
        const reqBadge = grp.isRequired
          ? `<span class="badge-out" style="background:rgba(249,115,22,0.2);color:#fdba74;border-color:rgba(249,115,22,0.45);">Obligatoire</span>`
          : `<span class="badge-options">Optionnel (max ${grp.maxChoices})</span>`;

        const choicesHtml = (grp.values || [])
          .map((val, idx) => {
            const checkedAttr = val.isDefault || (grp.isRequired && grp.selectionType === 'single' && idx === 0) ? 'checked' : '';
            const deltaLabel =
              val.priceDelta > 0
                ? `+${formatMoney(val.priceDelta)}`
                : val.priceDelta < 0
                  ? `${formatMoney(val.priceDelta)}`
                  : 'Inclus';

            return `
              <label class="option-choice-label">
                <span style="display:flex;align-items:center;gap:8px;">
                  <input
                    type="${inputType}"
                    name="opt_grp_${escapeHtml(grp.id)}"
                    value="${escapeHtml(val.id)}"
                    data-group-id="${escapeHtml(grp.id)}"
                    data-group-name="${escapeHtml(grp.name)}"
                    data-label="${escapeHtml(val.label)}"
                    data-price-delta="${Number(val.priceDelta || 0)}"
                    ${checkedAttr}
                  />
                  <span>${escapeHtml(val.label)}</span>
                </span>
                <span style="color:#fdba74;font-weight:600;font-size:0.8rem;">${deltaLabel}</span>
              </label>
            `;
          })
          .join('');

        return `
          <div class="option-group-box" data-group-box="${escapeHtml(grp.id)}">
            <div class="option-group-head">
              <strong style="font-size:0.9rem;">${escapeHtml(grp.name)}</strong>
              ${reqBadge}
            </div>
            <div>${choicesHtml}</div>
          </div>
        `;
      })
      .join('');

    groupsContainer.querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', updateOptionModalButtonTotal);
    });

    updateOptionModalButtonTotal();
    modal.classList.remove('hidden');
  }

  function getSelectedOptionsFromModal() {
    const groupsContainer = document.getElementById('opt-groups-container');
    if (!groupsContainer) return [];
    const checked = Array.from(groupsContainer.querySelectorAll('input:checked'));
    return checked.map((inp) => ({
      optionValueId: inp.value,
      groupId: inp.getAttribute('data-group-id') || '',
      groupName: inp.getAttribute('data-group-name') || '',
      label: inp.getAttribute('data-label') || '',
      priceDelta: Number(inp.getAttribute('data-price-delta') || 0),
    }));
  }

  function updateOptionModalButtonTotal() {
    const prod = state.activeProductForOptions;
    const btn = document.getElementById('btn-confirm-add-item');
    if (!prod || !btn) return;

    const selected = getSelectedOptionsFromModal();
    const deltaSum = selected.reduce((acc, o) => acc + o.priceDelta, 0);
    const unitPrice = Number(prod.sellingPrice) + deltaSum;
    const lineTotal = unitPrice * state.activeOptionQuantity;
    btn.textContent = `Ajouter au panier • ${formatMoney(lineTotal)}`;
  }

  function confirmAddItemFromModal() {
    const prod = state.activeProductForOptions;
    if (!prod) return;

    const selected = getSelectedOptionsFromModal();
    const groups = Array.isArray(prod.optionGroups) ? prod.optionGroups : [];

    for (const grp of groups) {
      const count = selected.filter((s) => s.groupId === grp.id).length;
      const minReq = grp.isRequired ? Math.max(1, Number(grp.minChoices || 1)) : Number(grp.minChoices || 0);
      const maxAllowed = grp.selectionType === 'single' ? 1 : Math.max(1, Number(grp.maxChoices || 10));
      if (count < minReq) {
        showToast(`Veuillez choisir une option pour "${grp.name}".`);
        return;
      }
      if (count > maxAllowed) {
        showToast(`Maximum ${maxAllowed} choix autorisé(s) pour "${grp.name}".`);
        return;
      }
    }

    const customMessage = (document.getElementById('opt-custom-message')?.value || '').trim();
    const itemNote = (document.getElementById('opt-item-note')?.value || '').trim();
    const deltaSum = selected.reduce((acc, o) => acc + o.priceDelta, 0);
    const unitPrice = Number(prod.sellingPrice) + deltaSum;

    state.cart.push({
      cartLineId: `${prod.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      productId: prod.id,
      productName: prod.name,
      quantity: state.activeOptionQuantity,
      unitPrice,
      selectedOptions: selected,
      customMessage: customMessage || null,
      itemNote: itemNote || null,
    });

    // Reset idempotency key whenever cart changes
    state.pendingIdempotencyKey = null;

    document.getElementById('modal-product-options')?.classList.add('hidden');
    updateCartUI();
    showToast(`"${prod.name}" ajouté au panier !`);
  }

  function updateCartUI() {
    const bar = document.getElementById('bottom-cart-bar');
    const countEl = document.getElementById('cart-bar-count');
    const totalEl = document.getElementById('cart-bar-total');
    const drawerTotalEl = document.getElementById('cart-drawer-total');
    const listEl = document.getElementById('cart-items-list');

    const totalQty = state.cart.reduce((acc, item) => acc + item.quantity, 0);
    const totalAmount = state.cart.reduce((acc, item) => acc + item.unitPrice * item.quantity, 0);

    if (bar) {
      bar.classList.toggle('hidden', totalQty === 0);
    }
    if (countEl) {
      countEl.textContent = `${totalQty} article${totalQty > 1 ? 's' : ''}`;
    }
    if (totalEl) {
      totalEl.textContent = formatMoney(totalAmount);
    }
    if (drawerTotalEl) {
      drawerTotalEl.textContent = formatMoney(totalAmount);
    }

    if (listEl) {
      if (state.cart.length === 0) {
        listEl.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:20px 0;">Votre panier est vide.</p>`;
      } else {
        listEl.innerHTML = state.cart
          .map((line) => {
            const optsSummary = (line.selectedOptions || [])
              .map((o) => `${o.groupName}: ${o.label}`)
              .join(' • ');
            return `
              <div class="cart-item-row">
                <div style="flex:1;">
                  <div style="font-weight:700;font-size:0.92rem;">${escapeHtml(line.productName)}</div>
                  ${optsSummary ? `<div style="font-size:0.78rem;color:#fdba74;margin-top:2px;">${escapeHtml(optsSummary)}</div>` : ''}
                  ${line.customMessage ? `<div style="font-size:0.78rem;color:#7dd3fc;margin-top:2px;">🎂 Message: ${escapeHtml(line.customMessage)}</div>` : ''}
                  ${line.itemNote ? `<div style="font-size:0.76rem;color:var(--text-muted);margin-top:2px;">Note: ${escapeHtml(line.itemNote)}</div>` : ''}
                  <div style="font-weight:700;font-size:0.86rem;margin-top:5px;">
                    ${formatMoney(line.unitPrice * line.quantity)}
                  </div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;">
                  <div class="qty-stepper">
                    <button type="button" data-cart-minus="${escapeHtml(line.cartLineId)}">−</button>
                    <span style="min-width:20px;text-align:center;font-weight:700;">${line.quantity}</span>
                    <button type="button" data-cart-plus="${escapeHtml(line.cartLineId)}">+</button>
                  </div>
                </div>
              </div>
            `;
          })
          .join('');

        listEl.querySelectorAll('button[data-cart-minus]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-cart-minus');
            const idx = state.cart.findIndex((c) => c.cartLineId === id);
            if (idx === -1) return;
            if (state.cart[idx].quantity > 1) {
              state.cart[idx].quantity -= 1;
            } else {
              state.cart.splice(idx, 1);
            }
            state.pendingIdempotencyKey = null;
            updateCartUI();
          });
        });

        listEl.querySelectorAll('button[data-cart-plus]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-cart-plus');
            const item = state.cart.find((c) => c.cartLineId === id);
            if (!item) return;
            item.quantity += 1;
            state.pendingIdempotencyKey = null;
            updateCartUI();
          });
        });
      }
    }
  }

  async function submitQrOrder() {
    if (state.isSubmittingOrder || state.cart.length === 0) return;

    const customerName = (document.getElementById('cart-customer-name')?.value || '').trim();
    const customerPhone = (document.getElementById('cart-customer-phone')?.value || '').trim();
    const customerNote = (document.getElementById('cart-customer-note')?.value || '').trim();
    const orderType = document.getElementById('cart-order-type')?.value || 'dine_in';

    if (state.establishment?.requireCustomerName && !customerName) {
      showToast('Veuillez renseigner votre nom.');
      return;
    }
    if (state.establishment?.requireCustomerPhone && !customerPhone) {
      showToast('Veuillez renseigner votre numéro de téléphone.');
      return;
    }

    if (!state.pendingIdempotencyKey) {
      state.pendingIdempotencyKey = `qr_${state.qrToken.slice(0, 10)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    }

    const submitBtn = document.getElementById('btn-submit-qr-order');
    state.isSubmittingOrder = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = '⏳ Envoi de votre commande...';
    }

    try {
      const res = await fetch(`/api/public/qr/menu/${encodeURIComponent(state.qrToken)}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderType,
          customerName: customerName || null,
          customerPhone: customerPhone || null,
          customerNote: customerNote || null,
          idempotencyKey: state.pendingIdempotencyKey,
          items: state.cart.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            selectedOptionValueIds: (line.selectedOptions || []).map((o) => o.optionValueId),
            customMessage: line.customMessage || null,
            itemNote: line.itemNote || null,
          })),
        }),
      });

      const payload = await res.json();
      if (!res.ok) {
        showToast(payload?.error?.message || 'Erreur lors de la validation de votre commande.');
        return;
      }

      const created = payload.data;
      state.cart = [];
      state.pendingIdempotencyKey = null;
      updateCartUI();
      document.getElementById('modal-cart-drawer')?.classList.add('hidden');

      if (created?.tracking_token) {
        saveTrackingToken(created.tracking_token);
        openOrderTracker(created.tracking_token);
      }
      showToast(`🎉 Commande ${created.order_number} envoyée en cuisine !`);
    } catch (err) {
      showToast('Erreur réseau lors de l’envoi de la commande.');
    } finally {
      state.isSubmittingOrder = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = '✅ Confirmer et envoyer en cuisine';
      }
    }
  }

  async function openOrderTracker(trackingToken) {
    const token = trackingToken || state.activeTrackingToken;
    if (!token) {
      showToast('Aucune commande active à suivre.');
      return;
    }

    const modal = document.getElementById('modal-order-tracker');
    if (modal) modal.classList.remove('hidden');

    await fetchAndRenderTrackingStatus(token);

    if (state.trackerIntervalId) clearInterval(state.trackerIntervalId);
    state.trackerIntervalId = setInterval(() => {
      if (!modal || modal.classList.contains('hidden')) {
        clearInterval(state.trackerIntervalId);
        return;
      }
      fetchAndRenderTrackingStatus(token);
    }, 5000);
  }

  async function fetchAndRenderTrackingStatus(trackingToken) {
    const bodyEl = document.getElementById('tracker-body-content');
    if (!bodyEl) return;

    try {
      const res = await fetch(`/api/public/qr/orders/${encodeURIComponent(trackingToken)}`);
      const payload = await res.json();
      if (!res.ok || !payload.data) {
        bodyEl.innerHTML = `<p style="color:#fca5a5;">Impossible de retrouver cette commande.</p>`;
        return;
      }

      const { order, establishment, items } = payload.data;
      const stepsOrder = [
        { key: 'received', label: '1. Reçue' },
        { key: 'accepted', label: '2. Acceptée' },
        { key: 'preparing', label: '3. Cuisine' },
        { key: 'ready', label: '4. Prête' },
        { key: 'served', label: '5. Servie' },
      ];
      const currentIdx = stepsOrder.findIndex((s) => s.key === order.status);

      const stepsHtml = stepsOrder
        .map((st, idx) => {
          let cls = '';
          if (idx < currentIdx) cls = 'done';
          else if (idx === currentIdx) cls = 'current';
          return `<div class="status-step ${cls}">${escapeHtml(st.label)}</div>`;
        })
        .join('');

      const statusBanner =
        order.status === 'rejected' || order.status === 'cancelled'
          ? `<div style="padding:12px;border-radius:10px;background:rgba(239,68,68,0.18);border:1px solid rgba(239,68,68,0.45);color:#fca5a5;margin-bottom:12px;">
               <strong>Commande ${order.status === 'rejected' ? 'refusée' : 'annulée'}</strong>
               ${order.rejectionReason ? `<div style="margin-top:4px;font-size:0.84rem;">Motif : ${escapeHtml(order.rejectionReason)}</div>` : ''}
             </div>`
          : '';

      const itemsHtml = (items || [])
        .map((it) => {
          const optText = (it.options || []).map((o) => `${o.groupName}: ${o.label}`).join(' • ');
          return `
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border-subtle);font-size:0.86rem;">
              <div>
                <strong>${it.quantity}x ${escapeHtml(it.productName)}</strong>
                ${optText ? `<div style="font-size:0.75rem;color:#fdba74;">${escapeHtml(optText)}</div>` : ''}
                ${it.customMessage ? `<div style="font-size:0.75rem;color:#7dd3fc;">🎂 ${escapeHtml(it.customMessage)}</div>` : ''}
              </div>
              <div style="font-weight:700;">${formatMoney(it.subtotal, establishment.currency)}</div>
            </div>
          `;
        })
        .join('');

      bodyEl.innerHTML = `
        <div style="padding:12px;border-radius:12px;background:rgba(15,23,42,0.7);border:1px solid var(--border-subtle);margin-bottom:12px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="color:var(--text-muted);font-size:0.8rem;">N° de commande</span>
            <strong style="font-family:'Space Grotesk',sans-serif;color:#fdba74;">${escapeHtml(order.orderNumber)}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
            <span style="color:var(--text-muted);font-size:0.8rem;">Table / Mode</span>
            <span style="font-weight:600;font-size:0.85rem;">${escapeHtml(order.tableName)} (${escapeHtml(order.tableCode)})</span>
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
            <span style="color:var(--text-muted);font-size:0.8rem;">Règlement</span>
            <span style="font-weight:700;font-size:0.82rem;color:${order.paymentStatus === 'paid' ? '#6ee7b7' : '#fcd34d'};">
              ${order.paymentStatus === 'paid' ? '✅ Payée' : '⏳ À régler à table / caisse'}
            </span>
          </div>
        </div>

        ${statusBanner}
        <div class="status-steps">${stepsHtml}</div>

        <h4 style="font-size:0.9rem;margin:14px 0 8px;">Détail de votre commande</h4>
        <div>${itemsHtml}</div>

        <div style="display:flex;justify-content:space-between;margin-top:14px;font-weight:800;font-size:1rem;">
          <span>Total</span>
          <span style="color:#fdba74;">${formatMoney(order.totalAmount, establishment.currency)}</span>
        </div>
      `;
    } catch {
      // ignore transient error
    }
  }

  async function triggerServiceRequest(requestType) {
    try {
      const res = await fetch(`/api/public/qr/menu/${encodeURIComponent(state.qrToken)}/service-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestType }),
      });
      const payload = await res.json();
      if (!res.ok) {
        showToast(payload?.error?.message || 'Impossible d’envoyer la demande.');
        return;
      }
      if (requestType === 'call_waiter') {
        showToast('🔔 Un serveur a été notifié et arrive à votre table !');
      } else {
        showToast('🧾 Demande d’addition envoyée à la caisse !');
      }
    } catch {
      showToast('Erreur réseau.');
    }
  }

  // Event Listeners
  document.getElementById('menu-search-input')?.addEventListener('input', (e) => {
    state.searchQuery = e.target.value || '';
    renderProducts();
  });

  document.getElementById('btn-close-opt-modal')?.addEventListener('click', () => {
    document.getElementById('modal-product-options')?.classList.add('hidden');
  });

  document.getElementById('opt-qty-minus')?.addEventListener('click', () => {
    if (state.activeOptionQuantity > 1) {
      state.activeOptionQuantity -= 1;
      const el = document.getElementById('opt-qty-val');
      if (el) el.textContent = String(state.activeOptionQuantity);
      updateOptionModalButtonTotal();
    }
  });

  document.getElementById('opt-qty-plus')?.addEventListener('click', () => {
    if (state.activeOptionQuantity < 50) {
      state.activeOptionQuantity += 1;
      const el = document.getElementById('opt-qty-val');
      if (el) el.textContent = String(state.activeOptionQuantity);
      updateOptionModalButtonTotal();
    }
  });

  document.getElementById('btn-confirm-add-item')?.addEventListener('click', confirmAddItemFromModal);

  document.getElementById('btn-open-cart')?.addEventListener('click', () => {
    document.getElementById('modal-cart-drawer')?.classList.remove('hidden');
  });

  document.getElementById('btn-close-cart-modal')?.addEventListener('click', () => {
    document.getElementById('modal-cart-drawer')?.classList.add('hidden');
  });

  document.getElementById('btn-submit-qr-order')?.addEventListener('click', submitQrOrder);

  document.getElementById('btn-call-waiter')?.addEventListener('click', () => {
    triggerServiceRequest('call_waiter');
  });

  document.getElementById('btn-request-bill')?.addEventListener('click', () => {
    triggerServiceRequest('request_bill');
  });

  document.getElementById('btn-open-tracker')?.addEventListener('click', () => {
    openOrderTracker(state.activeTrackingToken);
  });

  document.getElementById('btn-close-tracker-modal')?.addEventListener('click', () => {
    document.getElementById('modal-order-tracker')?.classList.add('hidden');
  });

  document.getElementById('btn-refresh-tracker')?.addEventListener('click', () => {
    if (state.activeTrackingToken) {
      fetchAndRenderTrackingStatus(state.activeTrackingToken);
      showToast('Statut actualisé.');
    }
  });

  loadPublicMenu();
})();
