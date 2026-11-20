// =====================================================================
// RESTOGEST — INTERACTIONS & ANIMATIONS DE LA PAGE D'ACCUEIL (LANDING)
// =====================================================================

// Drapeau d'activation des témoignages : passer à `true` une fois de vrais avis clients collectés
const SHOW_TESTIMONIALS = false;

// Tarifs officiels issus du code serveur (migrations 010 & 011 / subscriptions.router.ts)
const OFFICIAL_PRICING = {
  XOF: {
    countryCode: 'SN',
    essentiel: '15 000 FCFA',
    pro: '29 000 FCFA',
    entreprise: '59 000 FCFA',
    setupZero: '0 FCFA de frais d’installation',
    setupEnt: '+ 25 000 FCFA d’installation initiale',
    paymentLine: 'Sénégal : Wave (+221 78 897 93 42), Orange Money ou carte UBA · Essai gratuit 14 jours · Activation après validation du paiement',
  },
  GNF: {
    countryCode: 'GN',
    essentiel: '225 000 GNF',
    pro: '435 000 GNF',
    entreprise: '885 000 GNF',
    setupZero: '0 GNF de frais d’installation',
    setupEnt: '+ 375 000 GNF d’installation initiale',
    paymentLine: 'Guinée : Orange Money Guinée, virement / solution mobile locale ou carte UBA · Essai gratuit 14 jours · Activation après validation du paiement',
  },
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function openAuthModal(tab = 'login', preselectCountry = null) {
  const backdrop = document.getElementById('auth-modal-backdrop');
  if (!backdrop) return;

  const targetTabBtn = document.querySelector(`[data-auth-tab="${tab}"]`);
  if (targetTabBtn) targetTabBtn.click();

  if (preselectCountry) {
    const countrySel = document.getElementById('reg-country');
    if (countrySel) {
      countrySel.value = preselectCountry;
      countrySel.dispatchEvent(new Event('change'));
    }
  }

  backdrop.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  setTimeout(() => {
    const focusTarget = tab === 'register' ? 'reg-company' : 'login-email';
    document.getElementById(focusTarget)?.focus();
  }, 60);
}

function closeAuthModal() {
  const backdrop = document.getElementById('auth-modal-backdrop');
  if (!backdrop) return;
  backdrop.classList.add('hidden');
  document.body.style.overflow = '';
}

function initNavbar() {
  const navbar = document.getElementById('lp-navbar');
  const burger = document.getElementById('lp-burger');
  const drawer = document.getElementById('lp-mobile-drawer');

  const syncScroll = () => {
    if (!navbar) return;
    navbar.classList.toggle('lp-nav--scrolled', window.scrollY > 18);
  };
  window.addEventListener('scroll', syncScroll, { passive: true });
  syncScroll();

  if (burger && drawer) {
    burger.addEventListener('click', () => {
      const open = drawer.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', String(open));
    });

    drawer.querySelectorAll('a, button').forEach((el) => {
      el.addEventListener('click', () => {
        drawer.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
      });
    });

    document.addEventListener('click', (e) => {
      if (!drawer.classList.contains('is-open')) return;
      if (!drawer.contains(e.target) && !burger.contains(e.target)) {
        drawer.classList.remove('is-open');
        burger.setAttribute('aria-expanded', 'false');
      }
    });
  }
}

function initAuthModalControls() {
  const backdrop = document.getElementById('auth-modal-backdrop');
  const closeBtn = document.getElementById('lp-auth-close');

  document.querySelectorAll('[data-open-auth]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.openAuth || 'login';
      const activeCur = document.querySelector('.lp-cur-btn.is-active')?.dataset.lpCurrency;
      const preselectCountry = activeCur === 'GNF' ? 'GN' : activeCur === 'XOF' ? 'SN' : null;
      openAuthModal(mode, mode === 'register' ? preselectCountry : null);
    });
  });

  // Tous les boutons démo secondaires déclenchent le bouton principal #btn-demo-quickstart géré par app.js
  document.querySelectorAll('[data-trigger-demo]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('btn-demo-quickstart')?.click();
    });
  });

  closeBtn?.addEventListener('click', closeAuthModal);

  backdrop?.addEventListener('click', (e) => {
    if (e.target === backdrop) closeAuthModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && backdrop && !backdrop.classList.contains('hidden')) {
      closeAuthModal();
    }
  });

  // Fermer la modale auth si l'utilisateur clique sur "Mot de passe oublié ?" pour laisser #modal-backdrop au premier plan
  document.getElementById('btn-forgot-password')?.addEventListener('click', () => {
    closeAuthModal();
  });
}

function initScrollReveal() {
  const nodes = Array.from(document.querySelectorAll('[data-reveal]'));
  if (nodes.length === 0) return;

  if (reducedMotion || typeof IntersectionObserver === 'undefined') {
    nodes.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  // Appliquer un décalage de 80ms par enfant dans chaque groupe .lp-stagger
  document.querySelectorAll('.lp-stagger').forEach((group) => {
    Array.from(group.querySelectorAll('[data-reveal]')).forEach((child, idx) => {
      child.style.transitionDelay = `${idx * 80}ms`;
    });
  });

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12, rootMargin: '0px 0px -30px 0px' }
  );

  nodes.forEach((el) => observer.observe(el));
}

function initPricingSwitch() {
  const buttons = document.querySelectorAll('[data-lp-currency]');
  const priceEls = {
    essentiel: document.getElementById('lp-price-essentiel'),
    pro: document.getElementById('lp-price-pro'),
    entreprise: document.getElementById('lp-price-entreprise'),
  };
  const setupZeroEls = document.querySelectorAll('[data-lp-setup="zero"]');
  const setupEntEl = document.getElementById('lp-setup-entreprise');
  const payLineEl = document.getElementById('lp-pricing-payment-line');

  const applyCurrency = (cur) => {
    const cfg = OFFICIAL_PRICING[cur] || OFFICIAL_PRICING.XOF;
    buttons.forEach((b) => {
      const active = b.dataset.lpCurrency === cur;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-pressed', String(active));
    });

    const amountNodes = Object.values(priceEls).filter(Boolean);
    if (reducedMotion) {
      if (priceEls.essentiel) priceEls.essentiel.textContent = cfg.essentiel;
      if (priceEls.pro) priceEls.pro.textContent = cfg.pro;
      if (priceEls.entreprise) priceEls.entreprise.textContent = cfg.entreprise;
      setupZeroEls.forEach((el) => (el.textContent = cfg.setupZero));
      if (setupEntEl) setupEntEl.textContent = cfg.setupEnt;
      if (payLineEl) payLineEl.textContent = cfg.paymentLine;
      return;
    }

    amountNodes.forEach((el) => el.classList.add('is-fading'));
    setTimeout(() => {
      if (priceEls.essentiel) priceEls.essentiel.textContent = cfg.essentiel;
      if (priceEls.pro) priceEls.pro.textContent = cfg.pro;
      if (priceEls.entreprise) priceEls.entreprise.textContent = cfg.entreprise;
      setupZeroEls.forEach((el) => (el.textContent = cfg.setupZero));
      if (setupEntEl) setupEntEl.textContent = cfg.setupEnt;
      if (payLineEl) payLineEl.textContent = cfg.paymentLine;
      amountNodes.forEach((el) => el.classList.remove('is-fading'));
    }, 180);
  };

  buttons.forEach((btn) => {
    btn.addEventListener('click', () => applyCurrency(btn.dataset.lpCurrency));
  });
}

function initFaqAccordion() {
  document.querySelectorAll('[data-faq-trigger]').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      const item = trigger.closest('.lp-faq-item');
      if (!item) return;
      const isOpen = item.classList.toggle('is-open');
      trigger.setAttribute('aria-expanded', String(isOpen));
    });
  });
}

function initTestimonialsCarousel() {
  const section = document.getElementById('lp-testimonials-section');
  if (!section) return;

  if (!SHOW_TESTIMONIALS) {
    section.hidden = true;
    section.classList.add('hidden');
    return;
  }

  section.hidden = false;
  section.classList.remove('hidden');

  const track = document.getElementById('lp-testimonials-track');
  if (!track || reducedMotion) return;

  const originals = Array.from(track.children);
  if (originals.length === 0) return;

  originals.forEach((card) => {
    const clone = card.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    track.appendChild(clone);
  });

  const SPEED_PX_PER_SEC = 38;
  let pos = 0;
  let lastTs = null;
  let paused = false;
  let dragging = false;
  let startX = 0;
  let startPos = 0;

  const halfWidth = () => track.scrollWidth / 2;

  const wrap = (v) => {
    const max = halfWidth();
    if (max <= 0) return 0;
    let r = v % max;
    if (r < 0) r += max;
    return r;
  };

  const step = (ts) => {
    if (lastTs === null) lastTs = ts;
    const dt = (ts - lastTs) / 1000;
    lastTs = ts;
    if (!paused && !dragging) {
      pos = wrap(pos + SPEED_PX_PER_SEC * dt);
      track.style.transform = `translateX(-${pos}px)`;
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);

  track.addEventListener('mouseenter', () => { paused = true; });
  track.addEventListener('mouseleave', () => { paused = false; });

  const onDown = (clientX) => {
    dragging = true;
    startX = clientX;
    startPos = pos;
    track.style.cursor = 'grabbing';
  };
  const onMove = (clientX) => {
    if (!dragging) return;
    pos = wrap(startPos - (clientX - startX));
    track.style.transform = `translateX(-${pos}px)`;
  };
  const onUp = () => {
    dragging = false;
    track.style.cursor = 'grab';
  };

  track.addEventListener('mousedown', (e) => onDown(e.clientX));
  window.addEventListener('mousemove', (e) => onMove(e.clientX));
  window.addEventListener('mouseup', onUp);

  track.addEventListener('touchstart', (e) => onDown(e.touches[0].clientX), { passive: true });
  track.addEventListener('touchmove', (e) => onMove(e.touches[0].clientX), { passive: true });
  track.addEventListener('touchend', onUp);
}

function initLegalModals() {
  document.querySelectorAll('[data-legal-modal]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.legalModal;
      const backdrop = document.getElementById('modal-backdrop');
      const title = document.getElementById('modal-title');
      const body = document.getElementById('modal-body');
      if (!backdrop || !title || !body) return;

      if (kind === 'mentions') {
        title.textContent = 'Mentions légales — RESTOGEST';
        body.innerHTML = `<p class="muted-text" style="line-height:1.6;">
          <strong>RESTOGEST Cloud</strong> (<code>myrestogest.com</code>) est une plateforme SaaS de gestion pour restaurants et pâtisseries opérant au Sénégal (XOF) et en Guinée (GNF).<br/><br/>
          Les mentions légales complètes (raison sociale, NINEA / RCCM, adresse du siège et coordonnées officielles) sont en cours de finalisation par l’éditeur.
        </p>`;
      } else {
        title.textContent = 'Conditions Générales de Vente (CGV)';
        body.innerHTML = `<p class="muted-text" style="line-height:1.6;">
          Chaque nouvel établissement bénéficie de <strong>14 jours d’essai gratuit</strong>. Les abonnements sont proposés au tarif officiel local en <strong>FCFA (XOF — Sénégal)</strong> ou <strong>GNF (Guinée)</strong> et réglables par Wave, Orange Money, virement ou carte UBA.<br/><br/>
          Le document complet des CGV est en cours de finalisation par l’éditeur.
        </p>`;
      }
      backdrop.classList.remove('hidden');
    });
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initNavbar();
  initAuthModalControls();
  initScrollReveal();
  initPricingSwitch();
  initFaqAccordion();
  initTestimonialsCarousel();
  initLegalModals();
});
