import type { InventoryMovement, Prisma } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import type { Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { divRoundHalfUp, toBaseAmount, type Currency } from '../../shared/money.js';
import type { CatalogueService } from '../catalogue/catalogue.service.js';
import type { LocationsService, LocationView } from '../locations/locations.service.js';
import {
  InsufficientAvailableStockError,
  InsufficientStockError,
  LocationInactiveError,
  MovementNotAllowedAtLocationError,
  VariantInactiveError,
} from './inventory.errors.js';
import { isMovementAllowed } from './inventory.policy.js';
import * as repo from './inventory.repository.js';
import type {
  BalanceKey,
  BalanceView,
  LedgerResult,
  MovementEntry,
  MovementView,
} from './inventory.types.js';

export interface LedgerDeps {
  catalogue: CatalogueService;
  locations: LocationsService;
}

export interface LedgerContext {
  userId: string;
  idempotencyKey?: string | null;
}

export interface LedgerAudit {
  action: string;
  entityType: string;
  entityId?: string | null;
}

/**
 * The only code in the system that writes inventory_movements or inventory_balances.
 * Must be called inside a transaction. See docs/inventory.md → "Every mutation follows this sequence".
 *
 *  1. check variants and locations exist and are active, and the location policy allows each movement
 *  2. create missing balance rows, then lock every affected row in (location, variant) order
 *  3. apply each entry in order against the locked state: stock rules, moving-average value
 *  4. insert the movements, update the balances, write one audit entry
 *
 * Any rule failure throws, and the caller's transaction rolls everything back.
 */
export async function applyMovements(
  tx: Tx,
  deps: LedgerDeps,
  entries: MovementEntry[],
  ctx: LedgerContext,
  audit: LedgerAudit,
): Promise<LedgerResult> {
  if (entries.length === 0) return { movements: [], balances: [] };

  const keys = repo.uniqueSortedKeys(entries);
  await assertReferencesUsable(tx, deps, entries);

  await repo.ensureBalances(tx, keys);
  const state = await repo.lockBalances(tx, keys);

  const rows: Prisma.InventoryMovementCreateManyInput[] = [];
  const values: bigint[] = [];

  entries.forEach((entry, index) => {
    const balance = state.get(repo.balanceKeyOf(entry))!;
    const { value, unitCostBase } = valueOf(entry, balance, values);

    balance.quantity += entry.quantity;
    balance.valueBaseAmount += value;
    values[index] = value;

    rows.push({
      variantId: entry.variantId,
      locationId: entry.locationId,
      type: entry.type,
      quantity: entry.quantity,
      balanceAfter: balance.quantity,
      referenceType: entry.referenceType,
      referenceId: entry.referenceId ?? null,
      transferId: entry.transferId ?? null,
      reason: entry.reason ?? null,
      note: entry.note ?? null,
      unitCostAmount: entry.unitCost?.amount ?? null,
      unitCostCurrency: entry.unitCost?.currency ?? null,
      rateToBase: entry.unitCost?.rateToBase ?? null,
      unitCostBaseAmount: unitCostBase,
      valueBaseAmount: value,
      createdById: ctx.userId,
      idempotencyKey: ctx.idempotencyKey ?? null,
    });
  });

  const movements = await repo.insertMovements(tx, rows);
  for (const key of keys) await repo.updateBalance(tx, state.get(repo.balanceKeyOf(key))!);

  const result: LedgerResult = {
    movements: movements.map(toMovementView),
    balances: keys.map((key) => toBalanceView(state.get(repo.balanceKeyOf(key))!)),
  };

  await writeAudit(tx, {
    actorId: ctx.userId,
    action: audit.action,
    entityType: audit.entityType,
    entityId: audit.entityId ?? null,
    after: {
      movements: result.movements.map((m) => ({
        id: m.id,
        type: m.type,
        variantId: m.variantId,
        locationId: m.locationId,
        quantity: m.quantity,
        balanceAfter: m.balanceAfter,
      })),
    },
  });

  return result;
}

/**
 * Changes reserved quantity without moving stock. Same locking discipline as applyMovements.
 * Positive delta reserves (needs available stock); negative delta releases.
 */
export async function changeReserved(tx: Tx, key: BalanceKey, delta: number): Promise<BalanceView> {
  const state = await repo.lockBalances(tx, [key]);
  const balance = state.get(repo.balanceKeyOf(key));
  const quantity = balance?.quantity ?? 0;
  const reserved = balance?.reservedQuantity ?? 0;

  if (delta > 0 && (!balance || quantity - reserved < delta)) {
    throw new InsufficientAvailableStockError({
      ...key,
      requested: delta,
      quantity,
      reserved,
      available: quantity - reserved,
    });
  }
  if (!balance) throw new NotFoundError('balance', repo.balanceKeyOf(key));

  balance.reservedQuantity += delta;
  await repo.updateBalance(tx, balance);
  return toBalanceView(balance);
}

async function assertReferencesUsable(tx: Tx, deps: LedgerDeps, entries: MovementEntry[]) {
  const variantIds = [...new Set(entries.map((e) => e.variantId))];
  const locationIds = [...new Set(entries.map((e) => e.locationId))];
  // Sequential on purpose: an interactive transaction is one connection; Prisma does not support
  // parallel queries on it.
  const variants = await deps.catalogue.variantsByIds(tx, variantIds);
  const locations = await deps.locations.locationsByIds(tx, locationIds);

  const variantById = new Map(variants.map((v) => [v.id, v]));
  const locationById = new Map<string, LocationView>(locations.map((l) => [l.id, l]));

  for (const id of variantIds) {
    const variant = variantById.get(id);
    if (!variant) throw new NotFoundError('variant', id);
    if (!variant.isActive || !variant.product.isActive) throw new VariantInactiveError(id);
  }
  for (const id of locationIds) {
    const location = locationById.get(id);
    if (!location) throw new NotFoundError('location', id);
    if (!location.isActive) throw new LocationInactiveError(id);
  }
  for (const entry of entries) {
    const location = locationById.get(entry.locationId)!;
    if (!isMovementAllowed(location.kind, entry.type)) {
      throw new MovementNotAllowedAtLocationError({
        locationId: location.id,
        kind: location.kind,
        movement: entry.type,
      });
    }
  }
}

/**
 * Stock rule check and value for one entry, against the locked balance *before* the entry applies.
 * Value is held as a total per balance (SYP minor units); the average is derived, never stored,
 * so repeated averaging cannot accumulate rounding error.
 */
function valueOf(
  entry: MovementEntry,
  balance: repo.LockedBalance,
  previousValues: bigint[],
): { value: bigint; unitCostBase: bigint } {
  const qty = entry.quantity;

  if (qty < 0) {
    const need = -qty;
    const available = balance.quantity - balance.reservedQuantity;
    if (need > balance.quantity) {
      throw new InsufficientStockError({
        ...keyOf(entry),
        requested: need,
        quantity: balance.quantity,
      });
    }
    // No outflow may take reserved stock — it is promised to someone. That holds for corrections
    // too (adjustment, stocktake): the database check reserved <= quantity forbids it anyway.
    if (need > available) {
      throw new InsufficientAvailableStockError({
        ...keyOf(entry),
        requested: need,
        quantity: balance.quantity,
        reserved: balance.reservedQuantity,
        available,
      });
    }
    // Taking the last unit takes the whole remaining value, so no rounding residue is left behind.
    const value =
      need === balance.quantity
        ? -balance.valueBaseAmount
        : -divRoundHalfUp(balance.valueBaseAmount * BigInt(need), BigInt(balance.quantity));
    return { value, unitCostBase: divRoundHalfUp(-value, BigInt(need)) };
  }

  if (entry.pairedWith !== undefined) {
    // The value leaves the source and arrives at the destination unchanged.
    const value = -previousValues[entry.pairedWith]!;
    return { value, unitCostBase: divRoundHalfUp(value, BigInt(qty)) };
  }

  if (entry.unitCost) {
    const unitCostBase = toBaseAmount(entry.unitCost.amount, entry.unitCost.rateToBase);
    return { value: unitCostBase * BigInt(qty), unitCostBase };
  }

  const average =
    balance.quantity > 0 ? divRoundHalfUp(balance.valueBaseAmount, BigInt(balance.quantity)) : 0n;
  return { value: average * BigInt(qty), unitCostBase: average };
}

function keyOf(key: BalanceKey): BalanceKey {
  return { variantId: key.variantId, locationId: key.locationId };
}

export function toBalanceView(b: {
  variantId: string;
  locationId: string;
  quantity: number;
  reservedQuantity: number;
  valueBaseAmount: bigint;
}): BalanceView {
  return {
    variantId: b.variantId,
    locationId: b.locationId,
    quantity: b.quantity,
    reservedQuantity: b.reservedQuantity,
    availableQuantity: b.quantity - b.reservedQuantity,
    valueBaseAmount: b.valueBaseAmount,
    averageCostBaseAmount:
      b.quantity > 0 ? divRoundHalfUp(b.valueBaseAmount, BigInt(b.quantity)) : 0n,
  };
}

export function toMovementView(m: InventoryMovement): MovementView {
  return {
    id: m.id,
    seq: m.seq,
    variantId: m.variantId,
    locationId: m.locationId,
    type: m.type,
    quantity: m.quantity,
    balanceAfter: m.balanceAfter,
    referenceType: m.referenceType,
    referenceId: m.referenceId,
    transferId: m.transferId,
    reason: m.reason,
    note: m.note,
    unitCost:
      m.unitCostAmount !== null && m.unitCostCurrency !== null && m.rateToBase !== null
        ? {
            amount: m.unitCostAmount,
            currency: m.unitCostCurrency as Currency,
            rateToBase: m.rateToBase.toString(),
          }
        : null,
    unitCostBaseAmount: m.unitCostBaseAmount,
    valueBaseAmount: m.valueBaseAmount,
    createdById: m.createdById,
    createdAt: m.createdAt,
  };
}

/** Strips every cost figure for actors without inventory.cost.view. */
export function redactBalance(b: BalanceView): BalanceView {
  return { ...b, valueBaseAmount: null, averageCostBaseAmount: null };
}

export function redactMovement(m: MovementView): MovementView {
  return { ...m, unitCost: null, unitCostBaseAmount: null, valueBaseAmount: null };
}
