import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  OWNER_SUPER_ADMIN_USER_ID,
  requireAuth,
  requirePermission,
} from '../../middlewares/auth-middleware.js';
import { adminPool, ensureDatabaseReady } from '../../db/pool.js';
import { config } from '../../config/env.js';
import { hashPassword } from '../../auth/password.js';
import {
  ALL_PERMISSIONS,
  ROLE_PRESETS,
  getRolePreset,
  inferRoleCode,
  sanitizePermissions,
  type PermissionsMap,
} from '../../auth/permissions.js';
import {
  enforceSubscriptionQuota,
  requireActiveSubscriptionWriteAccess,
  withCompanyQuotaLock,
} from '../subscriptions/subscription-guard.service.js';

export const staffRouter = Router();

staffRouter.use(requireAuth);
staffRouter.use(requireActiveSubscriptionWriteAccess);
staffRouter.use(requirePermission('staff:manage'));

function buildUniqueRoleName(baseName: string, userIdShort: string, isCustom: boolean): string {
  const clean = baseName.trim().slice(0, 80) || 'Employé';
  if (!isCustom) return clean;
  return `${clean} (${userIdShort})`.slice(0, 100);
}

// 1. Catalogue des rôles prédéfinis et permissions atomiques
staffRouter.get('/presets', (_req, res) => {
  res.json({
    success: true,
    data: {
      presets: ROLE_PRESETS,
      permissions: ALL_PERMISSIONS,
    },
  });
});

// 2. Liste des employés de l'établissement (strictement isolé par companyId)
staffRouter.get('/', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const companyId = req.auth!.companyId;
    const result = await adminPool.query(
      `SELECT u.id, u.email, u.full_name, u.is_active AS user_active, u.created_at,
              cu.is_active AS membership_active, cu.joined_at,
              r.id AS role_id, r.name AS role_name, r.permissions AS role_permissions,
              (
                SELECT MAX(al.created_at)
                FROM public.audit_logs al
                WHERE al.company_id = cu.company_id AND al.user_id = u.id
              ) AS last_activity_at
       FROM public.company_users cu
       JOIN public.users u ON u.id = cu.user_id
       LEFT JOIN public.roles r ON r.company_id = cu.company_id AND r.id = cu.role_id
       WHERE cu.company_id = $1
       ORDER BY (COALESCE((r.permissions->>'all')::boolean, false)) DESC, cu.joined_at ASC`,
      [companyId]
    );

    const staff = result.rows.map((row) => {
      const perms = sanitizePermissions(row.role_permissions);
      return {
        id: row.id,
        email: row.email,
        fullName: row.full_name,
        isActive: Boolean(row.user_active && row.membership_active),
        joinedAt: row.joined_at,
        lastActivityAt: row.last_activity_at,
        roleId: row.role_id,
        roleName: row.role_name || 'Employé',
        roleCode: inferRoleCode(row.role_name, perms),
        isOwner: perms.all === true,
        permissions: perms,
      };
    });

    res.json({ success: true, data: staff });
  } catch (error) {
    next(error);
  }
});

const createStaffSchema = z.object({
  fullName: z.string().min(2, 'Le nom complet est requis (2 car. min.)').max(150),
  email: z.string().email('Adresse e-mail invalide').max(200),
  password: z.string().min(8, 'Le mot de passe doit contenir au moins 8 caractères').max(128),
  rolePreset: z.string().max(50).optional(),
  roleName: z.string().min(2).max(100).optional(),
  permissions: z.record(z.any()).optional(),
});

// 3. Création d'un compte employé individuel rattaché à l'établissement
staffRouter.post('/', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const companyId = req.auth!.companyId;
    const actorUserId = req.auth!.userId;
    const data = createStaffSchema.parse(req.body);

    const normalizedEmail = data.email.trim().toLowerCase();
    if (normalizedEmail === config.superAdmin.email.trim().toLowerCase()) {
      res.status(403).json({
        success: false,
        error: 'Ce compte système ne peut pas être rattaché comme employé.',
      });
      return;
    }

    const preset = data.rolePreset ? getRolePreset(data.rolePreset) : undefined;

    let resolvedPerms: PermissionsMap;
    let resolvedRoleLabel: string;
    let isCustomPerms = false;

    if (data.permissions && Object.keys(data.permissions).length > 0) {
      resolvedPerms = sanitizePermissions(data.permissions);
      // Empêcher l'attribution implicite de SUPER_ADMIN ; "all: true" réservé au preset owner
      if (resolvedPerms.all === true && preset?.code !== 'owner') {
        delete resolvedPerms.all;
      }
      resolvedRoleLabel = data.roleName?.trim() || preset?.name || 'Employé personnalisé';
      isCustomPerms = true;
    } else if (preset) {
      resolvedPerms = sanitizePermissions(preset.permissions);
      resolvedRoleLabel = data.roleName?.trim() || preset.name;
    } else {
      const fallback = getRolePreset('waiter')!;
      resolvedPerms = sanitizePermissions(fallback.permissions);
      resolvedRoleLabel = data.roleName?.trim() || fallback.name;
    }

    const passwordHash = await hashPassword(data.password);

    await withCompanyQuotaLock(`users:${companyId}`, async () => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');

        await enforceSubscriptionQuota(client, companyId, 'users');

        const existingUser = await client.query(
          `SELECT id, email, full_name, is_active, created_at
           FROM public.users
           WHERE LOWER(email) = $1
           LIMIT 1`,
          [normalizedEmail]
        );

        let targetUser: { id: string; email: string; full_name: string; created_at?: any };
        let isReattached = false;

        if (existingUser.rows.length > 0) {
          const foundUser = existingUser.rows[0];

          // Interdire formellement le rattachement du compte Super-Admin plateforme
          if (foundUser.id === OWNER_SUPER_ADMIN_USER_ID) {
            await client.query('ROLLBACK');
            res.status(403).json({
              success: false,
              error: 'Ce compte système ne peut pas être rattaché comme employé.',
            });
            return;
          }

          // Vérifier si le compte a été suspendu globalement par le Super-Admin plateforme
          if (!foundUser.is_active) {
            const saSuspendRes = await client.query(
              `SELECT action
               FROM public.audit_logs
               WHERE record_id = $1::uuid
                 AND action IN ('SUPER_ADMIN_USER_SUSPENDED', 'SUPER_ADMIN_USER_ACTIVATED')
               ORDER BY created_at DESC
               LIMIT 1`,
              [foundUser.id]
            );
            if (saSuspendRes.rows[0]?.action === 'SUPER_ADMIN_USER_SUSPENDED') {
              await client.query('ROLLBACK');
              res.status(403).json({
                success: false,
                error: 'Ce compte utilisateur a été suspendu par l’administration de la plateforme.',
              });
              return;
            }
          }

          // 1. Vérifier si l'utilisateur est déjà membre actif de cet établissement
          const currentMembership = await client.query(
            `SELECT is_active FROM public.company_users WHERE company_id = $1 AND user_id = $2 LIMIT 1`,
            [companyId, foundUser.id]
          );
          if (currentMembership.rows.length > 0 && currentMembership.rows[0].is_active === true) {
            await client.query('ROLLBACK');
            res.status(409).json({
              success: false,
              error: 'Cet employé fait déjà partie de l’équipe active de votre établissement.',
            });
            return;
          }

          // 2. Interdire le rattachement d'un utilisateur appartenant à un autre établissement
          const otherCompanyMembership = await client.query(
            `SELECT COUNT(*)::INT AS cnt
             FROM public.company_users
             WHERE user_id = $1 AND company_id <> $2`,
            [foundUser.id, companyId]
          );
          if (Number(otherCompanyMembership.rows[0]?.cnt || 0) > 0) {
            await client.query('ROLLBACK');
            res.status(409).json({
              success: false,
              error: 'Un compte utilisateur existe déjà avec cette adresse e-mail dans un autre établissement.',
            });
            return;
          }

          // 3. Vérifier que cette identité a légitimement appartenu à CET établissement par le passé
          const priorHistoryCheck = await client.query(
            `SELECT
               (SELECT COUNT(*)::INT FROM public.company_users WHERE company_id = $1 AND user_id = $2) +
               (SELECT COUNT(*)::INT FROM public.audit_logs WHERE company_id = $1 AND (record_id = $2::uuid OR user_id = $2::uuid)) +
               (SELECT COUNT(*)::INT FROM public.user_sessions WHERE company_id = $1 AND user_id = $2) +
               (SELECT COUNT(*)::INT FROM public.sales WHERE company_id = $1 AND user_id = $2) +
               (SELECT COUNT(*)::INT FROM public.cash_sessions WHERE company_id = $1 AND (opened_by = $2 OR closed_by = $2)) +
               (SELECT COUNT(*)::INT FROM public.stock_movements WHERE company_id = $1 AND user_id = $2) AS prior_links`,
            [companyId, foundUser.id]
          );
          const hasPriorLinkToThisCompany = Number(priorHistoryCheck.rows[0]?.prior_links || 0) > 0;

          if (!hasPriorLinkToThisCompany) {
            await client.query('ROLLBACK');
            res.status(409).json({
              success: false,
              error: 'Un compte utilisateur existe déjà avec cette adresse e-mail.',
            });
            return;
          }

          // 4. Réactivation légitime de l'ancien employé dans cet établissement :
          // - Aucun doublon dans public.users
          // - Préservation du nom complet existant (full_name non écrasé)
          // - Révocation de toutes les anciennes sessions
          // - Mise à jour du mot de passe d'accès fourni
          isReattached = true;
          const preservedFullName = foundUser.full_name || data.fullName.trim();
          await client.query(
            `UPDATE public.users SET is_active = TRUE, updated_at = NOW() WHERE id = $1`,
            [foundUser.id]
          );
          await client.query(
            `INSERT INTO public.user_credentials (user_id, password_hash, algo)
             VALUES ($1, $2, 'argon2id')
             ON CONFLICT (user_id) DO UPDATE
             SET password_hash = EXCLUDED.password_hash, updated_at = NOW()`,
            [foundUser.id, passwordHash]
          );
          await client.query(
            `UPDATE public.user_sessions
             SET revoked_at = NOW()
             WHERE user_id = $1 AND revoked_at IS NULL`,
            [foundUser.id]
          );

          targetUser = {
            id: foundUser.id,
            email: foundUser.email,
            full_name: preservedFullName,
            created_at: foundUser.created_at,
          };
        } else {
          const userInsert = await client.query(
            `INSERT INTO public.users (email, full_name, is_active)
             VALUES ($1, $2, TRUE)
             RETURNING id, email, full_name, created_at`,
            [normalizedEmail, data.fullName.trim()]
          );
          targetUser = userInsert.rows[0];

          await client.query(
            `INSERT INTO public.user_credentials (user_id, password_hash, algo)
             VALUES ($1, $2, 'argon2id')`,
            [targetUser.id, passwordHash]
          );
        }

        // Créer un rôle dédié à l'employé ou réutiliser le rôle exact de l'entreprise
        const finalRoleName = buildUniqueRoleName(
          resolvedRoleLabel,
          String(targetUser.id).slice(0, 6),
          isCustomPerms
        );

        let roleId: string;
        const existingRole = await client.query(
          `SELECT id, permissions FROM public.roles WHERE company_id = $1 AND name = $2 LIMIT 1`,
          [companyId, finalRoleName]
        );

        if (existingRole.rows.length > 0 && !isCustomPerms) {
          roleId = existingRole.rows[0].id;
          await client.query(
            `UPDATE public.roles SET permissions = $2::jsonb WHERE id = $1`,
            [roleId, JSON.stringify(resolvedPerms)]
          );
        } else {
          roleId = crypto.randomUUID();
          const safeRoleName = existingRole.rows.length > 0
            ? `${finalRoleName.slice(0, 85)} #${String(targetUser.id).slice(0, 6)}-${Date.now().toString().slice(-3)}`
            : finalRoleName;
          await client.query(
            `INSERT INTO public.roles (id, company_id, name, permissions)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [roleId, companyId, safeRoleName, JSON.stringify(resolvedPerms)]
          );
        }

        await client.query(
          `INSERT INTO public.company_users (company_id, user_id, role_id, is_active)
           VALUES ($1, $2, $3, TRUE)
           ON CONFLICT (company_id, user_id) DO UPDATE
           SET role_id = EXCLUDED.role_id, is_active = TRUE`,
          [companyId, targetUser.id, roleId]
        );

        await client.query(
          `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
           VALUES ($1, $2, $3, 'company_users', $4, $5::jsonb)`,
          [
            companyId,
            actorUserId,
            isReattached ? 'STAFF_MEMBER_REATTACHED' : 'STAFF_MEMBER_CREATED',
            targetUser.id,
            JSON.stringify({
              email: normalizedEmail,
              fullName: targetUser.full_name,
              roleName: resolvedRoleLabel,
              roleCode: inferRoleCode(resolvedRoleLabel, resolvedPerms),
              reattached: isReattached,
            }),
          ]
        );

        await client.query('COMMIT');

        res.status(201).json({
          success: true,
          message: isReattached
            ? `Compte employé réactivé et rattaché pour ${targetUser.full_name}`
            : `Compte employé créé pour ${targetUser.full_name}`,
          data: {
            id: targetUser.id,
            email: targetUser.email,
            fullName: targetUser.full_name,
            isActive: true,
            reattached: isReattached,
            roleId,
            roleName: resolvedRoleLabel,
            roleCode: inferRoleCode(resolvedRoleLabel, resolvedPerms),
            isOwner: resolvedPerms.all === true,
            permissions: resolvedPerms,
          },
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  } catch (error) {
    next(error);
  }
});

const updateStaffSchema = z.object({
  fullName: z.string().min(2).max(150).optional(),
  rolePreset: z.string().max(50).optional(),
  roleName: z.string().min(2).max(100).optional(),
  permissions: z.record(z.any()).optional(),
  password: z.string().min(8).max(128).optional(),
});

// 4. Modification d'un employé (nom, rôle, permissions, réinitialisation mot de passe)
staffRouter.put('/:userId', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const companyId = req.auth!.companyId;
    const actorUserId = req.auth!.userId;
    const targetUserId = z.string().uuid().parse(req.params.userId);
    const data = updateStaffSchema.parse(req.body);

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');

      const memberRes = await client.query(
        `SELECT cu.user_id, cu.role_id, u.email, u.full_name, r.name AS role_name, r.permissions AS role_permissions
         FROM public.company_users cu
         JOIN public.users u ON u.id = cu.user_id
         LEFT JOIN public.roles r ON r.company_id = cu.company_id AND r.id = cu.role_id
         WHERE cu.company_id = $1 AND cu.user_id = $2
         LIMIT 1`,
        [companyId, targetUserId]
      );
      if (memberRes.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, error: 'Employé introuvable dans cet établissement.' });
        return;
      }

      const current = memberRes.rows[0];
      const nextFullName = data.fullName?.trim() || current.full_name;

      if (data.fullName) {
        await client.query(
          `UPDATE public.users SET full_name = $2, updated_at = NOW() WHERE id = $1`,
          [targetUserId, nextFullName]
        );
      }

      if (data.password) {
        const newHash = await hashPassword(data.password);
        await client.query(
          `UPDATE public.user_credentials SET password_hash = $2, updated_at = NOW() WHERE user_id = $1`,
          [targetUserId, newHash]
        );
      }

      let nextRoleName = current.role_name || 'Employé';
      let nextPerms = sanitizePermissions(current.role_permissions);

      if (data.rolePreset || data.permissions || data.roleName) {
        const preset = data.rolePreset ? getRolePreset(data.rolePreset) : undefined;
        if (data.permissions) {
          nextPerms = sanitizePermissions(data.permissions);
        } else if (preset) {
          nextPerms = sanitizePermissions(preset.permissions);
        }

        // Empêcher le propriétaire de se retirer ses propres droits d'administration
        if (targetUserId === actorUserId && nextPerms.all !== true && nextPerms['staff:manage'] !== true) {
          await client.query('ROLLBACK');
          res.status(400).json({
            success: false,
            error: 'Vous ne pouvez pas retirer vos propres droits de gestion de l’équipe.',
          });
          return;
        }

        nextRoleName = data.roleName?.trim() || preset?.name || nextRoleName;
        const dedicatedRoleName = `${nextRoleName.slice(0, 80)} (${targetUserId.slice(0, 6)})`;

        // Vérifier si le rôle actuel est partagé avec d'autres utilisateurs de l'entreprise
        const sharedCountRes = await client.query(
          `SELECT COUNT(*)::INT AS cnt FROM public.company_users WHERE company_id = $1 AND role_id = $2`,
          [companyId, current.role_id]
        );
        const isShared = Number(sharedCountRes.rows[0]?.cnt || 0) > 1;

        if (!isShared && current.role_id) {
          await client.query(
            `UPDATE public.roles SET permissions = $2::jsonb WHERE company_id = $1 AND id = $3`,
            [companyId, JSON.stringify(nextPerms), current.role_id]
          );
          // Mettre à jour le nom si non en conflit
          const nameConflict = await client.query(
            `SELECT 1 FROM public.roles WHERE company_id = $1 AND name = $2 AND id <> $3`,
            [companyId, nextRoleName, current.role_id]
          );
          const targetRoleName = nameConflict.rows.length > 0 ? dedicatedRoleName : nextRoleName;
          await client.query(
            `UPDATE public.roles SET name = $2 WHERE company_id = $1 AND id = $3`,
            [companyId, targetRoleName, current.role_id]
          );
        } else {
          const newRoleId = crypto.randomUUID();
          const nameConflict = await client.query(
            `SELECT 1 FROM public.roles WHERE company_id = $1 AND name = $2`,
            [companyId, nextRoleName]
          );
          const safeName = nameConflict.rows.length > 0 ? dedicatedRoleName : nextRoleName;
          await client.query(
            `INSERT INTO public.roles (id, company_id, name, permissions)
             VALUES ($1, $2, $3, $4::jsonb)`,
            [newRoleId, companyId, safeName, JSON.stringify(nextPerms)]
          );
          await client.query(
            `UPDATE public.company_users SET role_id = $3 WHERE company_id = $1 AND user_id = $2`,
            [companyId, targetUserId, newRoleId]
          );
        }
      }

      await client.query(
        `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
         VALUES ($1, $2, 'STAFF_MEMBER_UPDATED', 'company_users', $3, $4::jsonb)`,
        [
          companyId,
          actorUserId,
          targetUserId,
          JSON.stringify({
            fullName: nextFullName,
            roleName: nextRoleName,
            roleCode: inferRoleCode(nextRoleName, nextPerms),
            passwordChanged: Boolean(data.password),
          }),
        ]
      );

      await client.query('COMMIT');

      res.json({
        success: true,
        message: 'Profil et autorisations de l’employé mis à jour.',
        data: {
          id: targetUserId,
          email: current.email,
          fullName: nextFullName,
          roleName: nextRoleName,
          roleCode: inferRoleCode(nextRoleName, nextPerms),
          isOwner: nextPerms.all === true,
          permissions: nextPerms,
        },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// 5. Suspension ou réactivation d'un employé (avec révocation immédiate des sessions)
staffRouter.post('/:userId/status', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const companyId = req.auth!.companyId;
    const actorUserId = req.auth!.userId;
    const targetUserId = z.string().uuid().parse(req.params.userId);
    const { isActive, reason } = z
      .object({ isActive: z.boolean(), reason: z.string().max(300).optional() })
      .parse(req.body);

    if (targetUserId === actorUserId && !isActive) {
      res.status(400).json({
        success: false,
        error: 'Vous ne pouvez pas suspendre votre propre compte propriétaire.',
      });
      return;
    }

    await withCompanyQuotaLock(`users:${companyId}`, async () => {
      const client = await adminPool.connect();
      try {
        await client.query('BEGIN');

        const memberRes = await client.query(
          `SELECT cu.user_id, cu.is_active, u.email, u.full_name, u.is_active AS user_active
           FROM public.company_users cu
           JOIN public.users u ON u.id = cu.user_id
           WHERE cu.company_id = $1 AND cu.user_id = $2
           LIMIT 1`,
          [companyId, targetUserId]
        );
        if (memberRes.rows.length === 0) {
          await client.query('ROLLBACK');
          res.status(404).json({ success: false, error: 'Employé introuvable dans cet établissement.' });
          return;
        }

        const wasActive = Boolean(memberRes.rows[0].is_active && memberRes.rows[0].user_active);
        if (isActive && !wasActive) {
          await enforceSubscriptionQuota(client, companyId, 'users');
        }

        await client.query(
          `UPDATE public.company_users SET is_active = $3 WHERE company_id = $1 AND user_id = $2`,
          [companyId, targetUserId, isActive]
        );

        // Si l'utilisateur n'appartient qu'à cet établissement, synchroniser users.is_active
        const otherMemberships = await client.query(
          `SELECT COUNT(*)::INT AS cnt FROM public.company_users WHERE user_id = $1 AND company_id <> $2`,
          [targetUserId, companyId]
        );
        if (Number(otherMemberships.rows[0]?.cnt || 0) === 0) {
          await client.query(
            `UPDATE public.users SET is_active = $2, updated_at = NOW() WHERE id = $1`,
            [targetUserId, isActive]
          );
        }

        if (!isActive) {
          await client.query(
            `UPDATE public.user_sessions
             SET revoked_at = NOW()
             WHERE company_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
            [companyId, targetUserId]
          );
        }

        await client.query(
          `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
           VALUES ($1, $2, $3, 'company_users', $4, $5::jsonb)`,
          [
            companyId,
            actorUserId,
            isActive ? 'STAFF_MEMBER_ACTIVATED' : 'STAFF_MEMBER_SUSPENDED',
            targetUserId,
            JSON.stringify({
              targetEmail: memberRes.rows[0].email,
              isActive,
              reason: reason || null,
            }),
          ]
        );

        await client.query('COMMIT');

        res.json({
          success: true,
          message: isActive ? 'Compte employé réactivé.' : 'Compte employé suspendu et déconnecté.',
          data: {
            userId: targetUserId,
            isActive,
          },
        });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  } catch (error) {
    next(error);
  }
});

// 5b. Suppression ou retrait d'un employé de l'établissement (libère une place dans le quota d'utilisateurs)
staffRouter.delete('/:userId', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const companyId = req.auth!.companyId;
    const actorUserId = req.auth!.userId;
    const targetUserId = z.string().uuid().parse(req.params.userId);

    if (targetUserId === actorUserId) {
      res.status(400).json({
        success: false,
        error: 'Vous ne pouvez pas supprimer votre propre compte propriétaire.',
      });
      return;
    }

    const client = await adminPool.connect();
    try {
      await client.query('BEGIN');

      const memberRes = await client.query(
        `SELECT cu.user_id, u.email, u.full_name
         FROM public.company_users cu
         JOIN public.users u ON u.id = cu.user_id
         WHERE cu.company_id = $1 AND cu.user_id = $2
         LIMIT 1`,
        [companyId, targetUserId]
      );
      if (memberRes.rows.length === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ success: false, error: 'Employé introuvable dans cet établissement.' });
        return;
      }

      await client.query(
        `UPDATE public.user_sessions
         SET revoked_at = NOW()
         WHERE company_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [companyId, targetUserId]
      );

      await client.query(
        `DELETE FROM public.company_users WHERE company_id = $1 AND user_id = $2`,
        [companyId, targetUserId]
      );

      await client.query(
        `INSERT INTO public.audit_logs (company_id, user_id, action, table_name, record_id, new_values)
         VALUES ($1, $2, 'STAFF_MEMBER_REMOVED', 'company_users', $3, $4::jsonb)`,
        [
          companyId,
          actorUserId,
          targetUserId,
          JSON.stringify({
            targetEmail: memberRes.rows[0].email,
            targetFullName: memberRes.rows[0].full_name,
          }),
        ]
      );

      await client.query('COMMIT');
      res.json({
        success: true,
        message: 'Employé retiré de l’établissement et place libérée dans votre quota.',
        data: { userId: targetUserId, removed: true },
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// 6. Historique des activités de l'équipe (scopé strictement à company_id)
staffRouter.get('/activity', async (req, res, next) => {
  try {
    await ensureDatabaseReady();
    const companyId = req.auth!.companyId;
    const userIdFilter = req.query.userId ? z.string().uuid().parse(String(req.query.userId)) : null;
    const limitRaw = Number(req.query.limit || 80);
    const limit = Number.isFinite(limitRaw) ? Math.max(10, Math.min(200, Math.floor(limitRaw))) : 80;

    const params: any[] = [companyId];
    let where = `al.company_id = $1`;
    if (userIdFilter) {
      params.push(userIdFilter);
      where += ` AND al.user_id = $${params.length}`;
    }
    params.push(limit);

    const result = await adminPool.query(
      `SELECT al.id, al.created_at, al.action, al.table_name, al.record_id,
              u.id AS user_id, u.full_name AS user_name, u.email AS user_email
       FROM public.audit_logs al
       LEFT JOIN public.users u ON u.id = al.user_id
       WHERE ${where}
       ORDER BY al.created_at DESC
       LIMIT $${params.length}`,
      params
    );

    res.json({ success: true, data: result.rows });
  } catch (error) {
    next(error);
  }
});
