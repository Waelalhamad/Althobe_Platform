import { ALL_PERMISSIONS, PERMISSIONS, type Permission } from '../../shared/permissions.js';

// docs/security.md → starting roles. A role is only a bundle of permissions; code never checks a
// role name. Role management in the UI arrives in Phase 3; until then roles are defined here.

const P = PERMISSIONS;
const inventoryAll = Object.values(P.inventory);

export const ROLES = {
  owner: ALL_PERMISSIONS,
  // docs/security.md: everything except admin.* — only the owner manages accounts.
  manager: ALL_PERMISSIONS.filter((p) => !p.startsWith('admin.')),
  inventory_manager: [...inventoryAll, P.products.read, P.products.write],
  warehouse_keeper: [
    P.inventory.view,
    P.inventory.receive,
    P.inventory.issue,
    P.inventory.transfer,
    P.inventory.damage,
    P.inventory.stocktakeCount,
    P.products.read,
  ],
  store_staff: [P.inventory.view, P.products.read],
  accountant: [P.inventory.view, P.inventory.costView, P.products.read],
} satisfies Record<string, readonly Permission[]>;

export type RoleName = keyof typeof ROLES;
export const ROLE_NAMES = Object.keys(ROLES) as RoleName[];

export function isRoleName(name: string): name is RoleName {
  return Object.hasOwn(ROLES, name);
}

export function permissionsFor(roles: readonly string[]): Set<Permission> {
  const permissions = new Set<Permission>();
  for (const role of roles) {
    if (isRoleName(role)) for (const p of ROLES[role]) permissions.add(p);
  }
  return permissions;
}
