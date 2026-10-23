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
    // Developer report F-03: an adjustment past the limit waits for someone else to accept it.
    adjustApprove: 'inventory.adjust.approve',
  },
  products: {
    read: 'products.read',
    write: 'products.write',
  },
  // Selling prices (ADR-009, ADR-012). Everyone with products.read sees them; few may change them.
  prices: {
    write: 'prices.write',
  },
  // The books (ADR-013): read the ledger and reports; post vouchers and reversals; close a month
  // and edit the chart of accounts.
  accounting: {
    view: 'accounting.view',
    post: 'accounting.post',
    close: 'accounting.close',
  },
  // The store's point of sale (ADR-014): ring up sales and run one's own shift; refunds,
  // discounts and closing someone else's shift are for a manager.
  retail: {
    sell: 'retail.sell',
    manage: 'retail.manage',
  },
  // Payroll (ADR-015). employees.read sees who works here, not what they earn; payroll.manage
  // sees salaries and advances, keeps the employee list, and pays.
  employees: {
    read: 'employees.read',
  },
  payroll: {
    manage: 'payroll.manage',
  },
  // Suppliers and customers (ADR-016): read balances and statements; add them, pay and collect.
  parties: {
    read: 'parties.read',
    manage: 'parties.manage',
  },
  admin: {
    users: 'admin.users.write',
    // Renaming warehouses and the store.
    locations: 'admin.locations.write',
    // The exchange rates (ADR-012).
    rates: 'admin.rates.write',
    // «تراجع»: undo a manual adjustment or a damage write-off, exactly.
    undo: 'admin.undo',
    // Gifts (developer report F-06): only the owner gives them.
    gifts: 'admin.gifts',
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
