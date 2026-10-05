import { PermissionDeniedError } from './errors.js';

// The permission set from docs/security.md and docs/inventory.md. Code checks permissions,
// never role names.
export const PERMISSIONS = {
  inventory: {
    view: 'inventory.view',
    receive: 'inventory.receive',
    issue: 'inventory.issue',
    transfer: 'inventory.transfer',
    damage: 'inventory.damage',
    adjust: 'inventory.adjust',
    reserve: 'inventory.reserve',
    release: 'inventory.release',
    return: 'inventory.return',
    stocktakeCount: 'inventory.stocktake.count',
    stocktakeApply: 'inventory.stocktake.apply',
    costView: 'inventory.cost.view',
  },
  products: {
    read: 'products.read',
    write: 'products.write',
  },
  // Selling prices (ADR-009). Everyone with products.read sees them; few may change them.
  prices: {
    write: 'prices.write',
  },
  admin: {
    users: 'admin.users.write',
  },
} as const;

type ValuesOf<T> = T[keyof T];
export type Permission = ValuesOf<{
  [K in keyof typeof PERMISSIONS]: ValuesOf<(typeof PERMISSIONS)[K]>;
}>;

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(PERMISSIONS).flatMap(
  (group) => Object.values(group) as Permission[],
);

// Who is acting. Until authentication exists (Phase 2) callers build this directly; afterwards
// it comes from the session. How it is checked does not change.
export interface ActorContext {
  userId: string;
  permissions: ReadonlySet<Permission>;
}

// Stock writes additionally carry an idempotency key, so a retried request never acts twice.
export interface WriteContext extends ActorContext {
  idempotencyKey: string;
}

export function assertPermission(ctx: ActorContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) throw new PermissionDeniedError(permission);
}
