import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';

export function errorHandler(
  err: any,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // Validation d'input Zod
  if (err instanceof ZodError) {
    res.status(400).json({
      success: false,
      error: "Erreur de validation des données d'entrée",
      issues: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
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
          message: err.message,
        });
        return;

      case '23505': // unique_violation
        res.status(409).json({
          success: false,
          error: "Conflit d'unicité : une ressource avec ces caractéristiques existe déjà",
          detail: err.detail,
        });
        return;

      case '23503': // foreign_key_violation
        res.status(400).json({
          success: false,
          error: "Violation de contrainte d'intégrité relationnelle",
          detail: err.detail,
        });
        return;

      case '23514': // check_violation
        res.status(400).json({
          success: false,
          error: 'Violation de règle métier (Check Constraint)',
          message: err.message,
        });
        return;

      case '42501': // insufficient_privilege
        res.status(403).json({
          success: false,
          error: 'Accès interdit : privilèges insuffisants ou ressource protégée par RLS',
          message: err.message,
        });
        return;

      case 'P0001': // raise_exception (nos exceptions métier personnalisées)
        if (/session.*(invalide|révoquée|expirée|introuvable)/i.test(err.message || '')) {
          res.status(401).json({
            success: false,
            error: 'Session invalide, expirée ou révoquée',
            message: err.message,
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

  console.error('[UNHANDLED SERVER ERROR]', err);

  res.status(500).json({
    success: false,
    error: 'Erreur interne du serveur',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
}
