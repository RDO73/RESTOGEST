const LEGACY_TOKEN_KEY = 'restogest_jwt_token';
const CSRF_COOKIE_NAME = 'restogest_csrf';

// Nettoyage de l'ancien stockage localStorage (migration vers cookie HttpOnly)
try {
  localStorage.removeItem(LEGACY_TOKEN_KEY);
} catch {
  // ignore
}

let sessionAuthenticated = false;
let onUnauthorizedHandler = null;

export function setOnUnauthorized(handler) {
  onUnauthorizedHandler = handler;
}

export function getToken() {
  return sessionAuthenticated ? 'cookie-session' : null;
}

export function setToken(token) {
  sessionAuthenticated = Boolean(token);
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // ignore
  }
}

export function getCsrfToken() {
  const cookies = document.cookie ? document.cookie.split(';') : [];
  for (const part of cookies) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === CSRF_COOKIE_NAME && rest.length > 0) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return null;
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
  const method = (options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !options.skipAuth) {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
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
    const netErr = new Error('Impossible de joindre le serveur MyRestoGest. Vérifiez votre connexion internet et réessayez.');
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
