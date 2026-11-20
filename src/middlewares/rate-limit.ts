import type { Request, Response, NextFunction } from 'express';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 5;

interface AttemptBucket {
  failures: number;
  firstFailureAt: number;
}

const failureStore = new Map<string, AttemptBucket>();

function extractClientKey(req: Request, scope: string): string {
  const forwarded = req.headers['x-forwarded-for'];
  const ip =
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
    req.socket?.remoteAddress ||
    'unknown';
  const email =
    typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 120) : '';
  return `${scope}|${ip}|${email}`;
}

function getActiveBucket(key: string): AttemptBucket | null {
  const bucket = failureStore.get(key);
  if (!bucket) return null;
  if (Date.now() - bucket.firstFailureAt > WINDOW_MS) {
    failureStore.delete(key);
    return null;
  }
  return bucket;
}

export function checkLoginRateLimit(scope: 'client_login' | 'admin_login') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = extractClientKey(req, scope);
    const bucket = getActiveBucket(key);
    if (bucket && bucket.failures >= MAX_FAILURES) {
      const retryAfterSec = Math.max(
        1,
        Math.ceil((WINDOW_MS - (Date.now() - bucket.firstFailureAt)) / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        success: false,
        error: 'Trop de tentatives de connexion échouées. Veuillez réessayer dans 15 minutes.',
      });
      return;
    }
    next();
  };
}

export function recordLoginFailure(req: Request, scope: 'client_login' | 'admin_login'): number {
  const key = extractClientKey(req, scope);
  const existing = getActiveBucket(key);
  if (!existing) {
    failureStore.set(key, { failures: 1, firstFailureAt: Date.now() });
    return 1;
  }
  existing.failures += 1;
  return existing.failures;
}

export function resetLoginFailures(req: Request, scope: 'client_login' | 'admin_login'): void {
  const key = extractClientKey(req, scope);
  failureStore.delete(key);
}

export function clearRateLimitStoreForTests(): void {
  failureStore.clear();
}
