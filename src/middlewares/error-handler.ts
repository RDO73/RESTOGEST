import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const isProd = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);

  // Validation d'input Zod
  if (err instanceof ZodError) {
    const firstIssueMsg = err.errors[0]?.message;
    res.status(400).json({
      success: false,
      error: firstIssueMsg || "Erreur de validation des données d'entrée",
      issues: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  // Erreurs applicatives typées (Quotas d'abonnement, Mode lecture seule, Version CGU/CGV)
  if (typeof err?.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500) {
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.code || 'APPLICATION_RULE_ERROR',
        message: err.message || 'Opération refusée.',
        ...(err.resourceType ? { resourceType: err.resourceType } : {}),
        ...(err.planCode ? { planCode: err.planCode } : {}),
        ...(typeof err.currentCount === 'number' ? { currentCount: err.currentCount } : {}),
        ...(typeof err.maxAllowed === 'number' ? { maxAllowed: err.maxAllowed } : {}),
      },
      message: err.message,
    });
    return;
  }

  // Erreurs levées par PostgreSQL
  if (err.code) {
    switch (err.code) {
      case '22P02': // invalid_text_representation (ex: UUID invalide)
        res.status(400).json({
          success: false,
          error: 'Format de paramètre invalide',
          ...(isProd ? {} : { message: err.message }),
        });
        return;

      case '23505': // unique_violation
        res.status(409).json({
          success: false,
          error: "Conflit d'unicité : une ressource avec ces caractéristiques existe déjà",
          ...(isProd ? {} : { detail: err.detail }),
        });
        return;

      case '23503': // foreign_key_violation
        res.status(400).json({
          success: false,
          error: "Opération refusée : référence associée introuvable ou utilisée",
          ...(isProd ? {} : { detail: err.detail }),
        });
        return;

      case '23514': // check_violation
        res.status(400).json({
          success: false,
          error: 'Valeur non conforme aux règles métier',
          ...(isProd ? {} : { message: err.message }),
        });
        return;

      case '42501': // insufficient_privilege
        res.status(403).json({
          success: false,
          error: 'Accès interdit : privilèges insuffisants',
          ...(isProd ? {} : { message: err.message }),
        });
        return;

      case 'P0001': // raise_exception (nos exceptions métier personnalisées)
        if (/session.*(invalide|révoquée|expirée|introuvable)/i.test(err.message || '')) {
          res.status(401).json({
            success: false,
            error: 'Session invalide, expirée ou révoquée',
          });
          return;
        }
        res.status(422).json({
          success: false,
          error: 'Règle métier non satisfaite',
          message: err.message,
        });
        return;
    }
  }

  console.error('[UNHANDLED SERVER ERROR]', isProd ? err?.message || 'Internal error' : err);

  res.status(500).json({
    success: false,
    error: 'Erreur interne du serveur',
    ...(isProd ? {} : { message: err?.message }),
  });
}
