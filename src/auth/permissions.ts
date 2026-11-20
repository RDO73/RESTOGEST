export type PermissionKey =
  | 'dashboard:read'
  | 'tables:read'
  | 'tables:write'
  | 'qr_orders:read'
  | 'qr_orders:write'
  | 'pos:read'
  | 'pos:write'
  | 'pos:pay'
  | 'catalog:read'
  | 'catalog:write'
  | 'inventory:read'
  | 'inventory:write'
  | 'purchases:read'
  | 'purchases:write'
  | 'cash:read'
  | 'cash:write'
  | 'customers:read'
  | 'customers:write'
  | 'reports:read'
  | 'staff:manage'
  | 'settings:manage';

export type PermissionsMap = {
  all?: boolean;
} & Partial<Record<PermissionKey, boolean>>;

export interface PermissionDefinition {
  key: PermissionKey;
  label: string;
  group: string;
}

export const ALL_PERMISSIONS: PermissionDefinition[] = [
  { key: 'dashboard:read', label: 'Voir le tableau de bord global', group: 'Pilotage' },
  { key: 'reports:read', label: 'Consulter les rapports & statistiques', group: 'Pilotage' },
  { key: 'tables:read', label: 'Consulter le plan de salle & QR codes', group: 'Salle & Tables' },
  { key: 'tables:write', label: 'Créer / modifier tables & menu QR', group: 'Salle & Tables' },
  { key: 'qr_orders:read', label: 'Consulter commandes QR & écran cuisine (KDS)', group: 'Cuisine & QR' },
  { key: 'qr_orders:write', label: 'Mettre à jour statuts cuisine & appels serveur', group: 'Cuisine & QR' },
  { key: 'pos:read', label: 'Consulter les ventes et commandes', group: 'Ventes & POS' },
  { key: 'pos:write', label: 'Créer et modifier des commandes / tickets', group: 'Ventes & POS' },
  { key: 'pos:pay', label: 'Encaisser, finaliser et annuler des ventes', group: 'Ventes & POS' },
  { key: 'cash:read', label: 'Consulter la caisse, les Z et les dépenses', group: 'Caisse & Trésorerie' },
  { key: 'cash:write', label: 'Ouvrir / clôturer la caisse et enregistrer dépenses', group: 'Caisse & Trésorerie' },
  { key: 'catalog:read', label: 'Consulter les produits, catégories & recettes', group: 'Catalogue' },
  { key: 'catalog:write', label: 'Créer / modifier produits, catégories & recettes', group: 'Catalogue' },
  { key: 'inventory:read', label: 'Consulter les niveaux, alertes & mouvements de stock', group: 'Stocks' },
  { key: 'inventory:write', label: 'Enregistrer ajustements, pertes & entrées stock', group: 'Stocks' },
  { key: 'purchases:read', label: 'Consulter achats & fournisseurs', group: 'Achats' },
  { key: 'purchases:write', label: 'Créer / réceptionner achats & fournisseurs', group: 'Achats' },
  { key: 'customers:read', label: 'Consulter le fichier clients', group: 'Clients' },
  { key: 'customers:write', label: 'Créer / modifier des clients', group: 'Clients' },
  { key: 'staff:manage', label: 'Gérer les employés, rôles et journaux équipe', group: 'Administration' },
  { key: 'settings:manage', label: 'Gérer les paramètres et l’abonnement', group: 'Administration' },
];

export const ALL_PERMISSION_KEYS = new Set<PermissionKey>(ALL_PERMISSIONS.map((p) => p.key));

export interface RolePreset {
  code: string;
  name: string;
  description: string;
  defaultRoute: string;
  permissions: PermissionsMap;
}

export const ROLE_PRESETS: RolePreset[] = [
  {
    code: 'owner',
    name: 'Propriétaire',
    description: 'Accès complet à l’ensemble de l’établissement, aux finances, aux employés et aux paramètres.',
    defaultRoute: 'dashboard',
    permissions: { all: true },
  },
  {
    code: 'cashier',
    name: 'Caissier',
    description: 'Encaissements POS, ouverture/clôture de caisse, dépenses autorisées et suivi des tickets.',
    defaultRoute: 'pos',
    permissions: {
      'pos:read': true,
      'pos:write': true,
      'pos:pay': true,
      'cash:read': true,
      'cash:write': true,
      'qr_orders:read': true,
      'qr_orders:write': true,
      'catalog:read': true,
      'tables:read': true,
      'customers:read': true,
      'customers:write': true,
    },
  },
  {
    code: 'waiter',
    name: 'Serveur',
    description: 'Prise de commandes sur tables, consultation de la carte et suivi des appels clients.',
    defaultRoute: 'tables',
    permissions: {
      'tables:read': true,
      'qr_orders:read': true,
      'qr_orders:write': true,
      'pos:read': true,
      'pos:write': true,
      'catalog:read': true,
      'customers:read': true,
    },
  },
  {
    code: 'kitchen',
    name: 'Responsable de cuisine',
    description: 'Écran cuisine (KDS), préparation des commandes, consultation des recettes et niveaux de stock.',
    defaultRoute: 'qr-orders',
    permissions: {
      'qr_orders:read': true,
      'qr_orders:write': true,
      'catalog:read': true,
      'inventory:read': true,
    },
  },
  {
    code: 'stock_manager',
    name: 'Gestionnaire de stock',
    description: 'Suivi des stocks, alertes, ajustements, pertes, fournisseurs et réceptions d’achats.',
    defaultRoute: 'inventory',
    permissions: {
      'inventory:read': true,
      'inventory:write': true,
      'purchases:read': true,
      'purchases:write': true,
      'catalog:read': true,
      'catalog:write': true,
    },
  },
  {
    code: 'accountant',
    name: 'Comptable',
    description: 'Consultation des chiffres d’affaires, rapports Z, dépenses, achats et valorisation des stocks (lecture seule).',
    defaultRoute: 'dashboard',
    permissions: {
      'dashboard:read': true,
      'reports:read': true,
      'cash:read': true,
      'pos:read': true,
      'purchases:read': true,
      'inventory:read': true,
      'customers:read': true,
    },
  },
  {
    code: 'floor_manager',
    name: 'Responsable de salle',
    description: 'Supervision des tables, commandes, service en salle, clients et encaissements.',
    defaultRoute: 'tables',
    permissions: {
      'dashboard:read': true,
      'tables:read': true,
      'tables:write': true,
      'qr_orders:read': true,
      'qr_orders:write': true,
      'pos:read': true,
      'pos:write': true,
      'pos:pay': true,
      'catalog:read': true,
      'customers:read': true,
      'customers:write': true,
    },
  },
];

export function getRolePreset(code: string): RolePreset | undefined {
  const norm = String(code || '').trim().toLowerCase();
  return ROLE_PRESETS.find((p) => p.code === norm);
}

export function sanitizePermissions(input: Record<string, any> | null | undefined): PermissionsMap {
  if (!input || typeof input !== 'object') return {};
  if (input.all === true) return { all: true };
  const clean: PermissionsMap = {};
  for (const key of ALL_PERMISSION_KEYS) {
    if (input[key] === true) {
      clean[key] = true;
    }
  }
  return clean;
}

export function hasPermission(
  permissions: PermissionsMap | null | undefined,
  required: PermissionKey | PermissionKey[],
  role?: string
): boolean {
  if (String(role || '').toUpperCase() === 'SUPER_ADMIN') return true;
  if (!permissions || typeof permissions !== 'object') return false;
  if (permissions.all === true) return true;
  const list = Array.isArray(required) ? required : [required];
  return list.some((perm) => permissions[perm] === true);
}

export function inferRoleCode(roleName?: string | null, permissions?: PermissionsMap | null): string {
  if (permissions?.all === true) return 'owner';
  const low = String(roleName || '').trim().toLowerCase();
  if (low.includes('propri') || low.includes('directeur') || low.includes('pdg') || low === 'owner') return 'owner';
  if (low.includes('caiss')) return 'cashier';
  if (low.includes('serveur') || low.includes('waiter')) return 'waiter';
  if (low.includes('cuisin') || low.includes('chef') || low.includes('kitchen')) return 'kitchen';
  if (low.includes('stock') || low.includes('magasin')) return 'stock_manager';
  if (low.includes('comptab') || low.includes('financ')) return 'accountant';
  if (low.includes('salle') || low.includes('floor')) return 'floor_manager';
  return 'staff';
}

export function getDefaultRouteForRole(roleCode: string, permissions?: PermissionsMap | null): string {
  const preset = getRolePreset(roleCode);
  if (preset) return preset.defaultRoute;
  if (permissions?.all === true || permissions?.['dashboard:read']) return 'dashboard';
  if (permissions?.['pos:read'] || permissions?.['pos:write']) return 'pos';
  if (permissions?.['tables:read']) return 'tables';
  if (permissions?.['qr_orders:read']) return 'qr-orders';
  if (permissions?.['inventory:read']) return 'inventory';
  if (permissions?.['cash:read']) return 'cash';
  if (permissions?.['catalog:read']) return 'catalog';
  return 'dashboard';
}
