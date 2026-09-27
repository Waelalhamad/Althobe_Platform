import { Prisma, type InventoryMovement } from '@prisma/client';
import type { Queryable, Tx } from '../../shared/db.js';
import type { BalanceKey } from './inventory.types.js';

export interface LockedBalance extends BalanceKey {
  id: string;
  quantity: number;
  reservedQuantity: number;
  valueBaseAmount: bigint;
}

/** Deterministic lock order — (location_id, variant_id) ascending — so transfers cannot deadlock. */
export function compareBalanceKeys(a: BalanceKey, b: BalanceKey): number {
  if (a.locationId !== b.locationId) return a.locationId < b.locationId ? -1 : 1;
  if (a.variantId !== b.variantId) return a.variantId < b.variantId ? -1 : 1;
  return 0;
}

export function balanceKeyOf(key: BalanceKey): string {
  return `${key.locationId}:${key.variantId}`;
}

export function uniqueSortedKeys(keys: BalanceKey[]): BalanceKey[] {
  const map = new Map<string, BalanceKey>();
  for (const key of keys) {
    map.set(balanceKeyOf(key), { variantId: key.variantId, locationId: key.locationId });
  }
  return [...map.values()].sort(compareBalanceKeys);
}

/** Creates any missing zero balance rows, so every key has a row to lock. */
export async function ensureBalances(tx: Tx, keys: BalanceKey[]): Promise<void> {
  await tx.inventoryBalance.createMany({ data: keys, skipDuplicates: true });
}

/**
 * SELECT … FOR UPDATE on every balance row, in sorted order. Postgres acquires row locks as the
 * sorted rows are emitted, so the ORDER BY is the lock order.
 */
export async function lockBalances(
  tx: Tx,
  keys: BalanceKey[],
): Promise<Map<string, LockedBalance>> {
  if (keys.length === 0) return new Map();
  const tuples = keys.map((k) => Prisma.sql`(${k.variantId}::uuid, ${k.locationId}::uuid)`);
  const rows = await tx.$queryRaw<
    {
      id: string;
      variant_id: string;
      location_id: string;
      quantity: number;
      reserved_quantity: number;
      value_base_amount: bigint;
    }[]
  >`
    SELECT id, variant_id, location_id, quantity, reserved_quantity, value_base_amount
    FROM inventory_balances
    WHERE (variant_id, location_id) IN (${Prisma.join(tuples)})
    ORDER BY location_id, variant_id
    FOR UPDATE`;

  return new Map(
    rows.map((r) => [
      balanceKeyOf({ variantId: r.variant_id, locationId: r.location_id }),
      {
        id: r.id,
        variantId: r.variant_id,
        locationId: r.location_id,
        quantity: r.quantity,
        reservedQuantity: r.reserved_quantity,
        valueBaseAmount: r.value_base_amount,
      },
    ]),
  );
}

export async function insertMovements(
  tx: Tx,
  rows: Prisma.InventoryMovementCreateManyInput[],
): Promise<InventoryMovement[]> {
  const created = await tx.inventoryMovement.createManyAndReturn({ data: rows });
  // seq is assigned in insertion order; sort so results line up with the entries given.
  return created.sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
}

export async function updateBalance(tx: Tx, balance: LockedBalance): Promise<void> {
  await tx.inventoryBalance.update({
    where: { id: balance.id },
    data: {
      quantity: balance.quantity,
      reservedQuantity: balance.reservedQuantity,
      valueBaseAmount: balance.valueBaseAmount,
      version: { increment: 1 },
    },
  });
}

export async function findBalance(q: Queryable, key: BalanceKey) {
  return q.inventoryBalance.findUnique({
    where: { variantId_locationId: { variantId: key.variantId, locationId: key.locationId } },
  });
}

export async function listBalances(
  q: Queryable,
  args: { locationId: string; variantIds?: string[]; inStockOnly: boolean; limit: number },
) {
  return q.inventoryBalance.findMany({
    where: {
      locationId: args.locationId,
      ...(args.variantIds ? { variantId: { in: args.variantIds } } : {}),
      ...(args.inStockOnly ? { quantity: { gt: 0 } } : {}),
    },
    orderBy: { variantId: 'asc' },
    take: args.limit,
  });
}

export async function listMovements(
  q: Queryable,
  args: { variantId?: string; locationId?: string; beforeSeq?: bigint; limit: number },
) {
  return q.inventoryMovement.findMany({
    where: {
      ...(args.variantId ? { variantId: args.variantId } : {}),
      ...(args.locationId ? { locationId: args.locationId } : {}),
      ...(args.beforeSeq !== undefined ? { seq: { lt: args.beforeSeq } } : {}),
    },
    orderBy: { seq: 'desc' },
    take: args.limit,
  });
}

export async function movementsByReference(
  q: Queryable,
  referenceType: InventoryMovement['referenceType'],
  referenceId: string,
) {
  return q.inventoryMovement.findMany({
    where: { referenceType, referenceId },
    orderBy: { seq: 'asc' },
  });
}

/**
 * Ledger integrity (docs/inventory.md → Source of truth):
 *  - every balance equals the sum of its movements, in quantity and in value;
 *  - every movement's balance_after equals the running total at that point.
 */
export async function findLedgerDrift(q: Queryable) {
  const balances = await q.$queryRaw<
    {
      variant_id: string;
      location_id: string;
      quantity: number;
      ledger_quantity: bigint;
      value: bigint;
      ledger_value: bigint;
    }[]
  >`
    SELECT b.variant_id, b.location_id, b.quantity,
           COALESCE(SUM(m.quantity), 0)::bigint          AS ledger_quantity,
           b.value_base_amount                           AS value,
           COALESCE(SUM(m.value_base_amount), 0)::bigint AS ledger_value
    FROM inventory_balances b
    LEFT JOIN inventory_movements m
      ON m.variant_id = b.variant_id AND m.location_id = b.location_id
    GROUP BY b.id
    HAVING b.quantity <> COALESCE(SUM(m.quantity), 0)
        OR b.value_base_amount <> COALESCE(SUM(m.value_base_amount), 0)`;

  const runningTotals = await q.$queryRaw<{ id: string; balance_after: number; running: bigint }[]>`
    SELECT id, balance_after, running FROM (
      SELECT id, balance_after,
             SUM(quantity) OVER (PARTITION BY variant_id, location_id ORDER BY seq) AS running
      FROM inventory_movements
    ) t
    WHERE balance_after <> running`;

  return { balances, runningTotals };
}
