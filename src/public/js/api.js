const TOKEN_KEY = 'restogest_jwt_token';

let onUnauthorizedHandler = null;

export function setOnUnauthorized(handler) {
  onUnauthorizedHandler = handler;
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4500);
}

export function fmtMoney(val, currency = 'XOF') {
  const num = Number(val || 0);
  if (Number.isNaN(num)) return `0 ${currency}`;
  return `${num.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
}

export function fmtQty(val) {
  const num = Number(val || 0);
  if (Number.isNaN(num)) return '0';
  return num.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export async function apiFetch(url, options = {}) {
  const token = getToken();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (token && !options.skipAuth) {
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers,
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
    });
  } catch {
    const netErr = new Error('Impossible de joindre le serveur RESTOGEST. Vérifiez votre connexion internet et réessayez.');
    netErr.isNetworkError = true;
    throw netErr;
  }

  let payload = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !options.ignoreUnauthorized && onUnauthorizedHandler) {
      onUnauthorizedHandler('Votre session a expiré. Veuillez vous reconnecter.');
    }
    const issueMsg = payload?.issues?.[0]?.message || null;
    const rawMsg =
      issueMsg ||
      (typeof payload?.error === 'object' ? payload?.error?.message : null) ||
      payload?.message ||
      (typeof payload?.error === 'string' ? payload.error : null);
    let friendly = rawMsg || 'Une erreur est survenue. Veuillez réessayer.';
    if (res.status === 429 && !rawMsg) {
      friendly = 'Trop de tentatives. Veuillez patienter quelques minutes avant de réessayer.';
    } else if (res.status >= 500) {
      friendly = 'Le serveur rencontre un problème temporaire. Veuillez réessayer dans un instant.';
    }
    const err = new Error(friendly);
    err.status = res.status;
    throw err;
  }

  return payload;
}
