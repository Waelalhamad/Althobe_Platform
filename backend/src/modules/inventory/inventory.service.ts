import { randomUUID } from 'node:crypto';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { withIdempotency } from '../../shared/idempotency.js';
import {
  assertPermission,
  PERMISSIONS,
  type ActorContext,
  type WriteContext,
} from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import type { VariantView } from '../catalogue/catalogue.service.js';
import {
  MovementNotAllowedAtLocationError,
  ReservationNotFoundError,
  LocationInactiveError,
} from './inventory.errors.js';
import {
  applyMovements,
  changeReserved,
  redactBalance,
  redactMovement,
  toBalanceView,
  toMovementView,
  type LedgerDeps,
} from './inventory.ledger.js';
import { areReservationsAllowed } from './inventory.policy.js';
import * as repo from './inventory.repository.js';
import {
  adjustStockSchema,
  balanceQuerySchema,
  damageStockSchema,
  issueStockSchema,
  listBalancesSchema,
  movementsQuerySchema,
  receiveStockSchema,
  releaseStockSchema,
  reserveStockSchema,
  transferStockSchema,
  type AdjustStockInput,
  type BalanceQuery,
  type DamageStockInput,
  type IssueStockInput,
  type ListBalancesInput,
  type MovementsQuery,
  type ReceiveStockInput,
  type ReleaseStockInput,
  type ReserveStockInput,
  type TransferStockInput,
} from './inventory.schema.js';
import type { BalanceView, LedgerResult, MovementView } from './inventory.types.js';

export type { BalanceView, LedgerResult, MovementView } from './inventory.types.js';

export interface ReservationView {
  id: string;
  variantId: string;
  locationId: string;
  orderId: string;
  quantity: number;
  status: string;
  expiresAt: Date | null;
}

/**
 * InventoryService — the only way to change stock (docs/inventory.md).
 * Every write: permission → validation → idempotency → transaction → applyMovements.
 */
export function createInventoryService(db: Db, deps: LedgerDeps) {
  /**
   * Runs one stock write inside a transaction, at most once per idempotency key. Callers check the
   * permission and validate input first, so a denied or malformed request never opens a transaction.
   */
  async function write<T>(
    ctx: WriteContext,
    operation: string,
    request: unknown,
    fn: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return inTransaction(db, async (tx) =>
      withIdempotency(tx, { key: ctx.idempotencyKey, operation, request }, async () => fn(tx)),
    );
  }

  const canSeeCost = (ctx: ActorContext) => ctx.permissions.has(PERMISSIONS.inventory.costView);

  async function readMovements(input: MovementsQuery, ctx: ActorContext): Promise<MovementView[]> {
    assertPermission(ctx, PERMISSIONS.inventory.view);
    const data = parse(movementsQuerySchema, input);
    const rows = await repo.listMovements(db, data);
    const views = rows.map(toMovementView);
    return canSeeCost(ctx) ? views : views.map(redactMovement);
  }

  return {
    async receiveStock(input: ReceiveStockInput, ctx: WriteContext): Promise<LedgerResult> {
      assertPermission(ctx, PERMISSIONS.inventory.receive);
      const data = parse(receiveStockSchema, input);
      return write(ctx, 'inventory.receive', data, async (tx) =>
        applyMovements(
          tx,
          deps,
          [
            {
              variantId: data.variantId,
              locationId: data.locationId,
              type: 'PURCHASE',
              quantity: data.quantity,
              unitCost: data.unitCost,
              referenceType: data.referenceType,
              referenceId: data.referenceId ?? null,
              note: data.note ?? null,
            },
          ],
          ctx,
          { action: 'inventory.receive', entityType: 'variant', entityId: data.variantId },
        ),
      );
    },

    async issueStock(input: IssueStockInput, ctx: WriteContext): Promise<LedgerResult> {
      assertPermission(ctx, PERMISSIONS.inventory.issue);
      const data = parse(issueStockSchema, input);
      return write(ctx, 'inventory.issue', data, async (tx) =>
        applyMovements(
          tx,
          deps,
          [
            {
              variantId: data.variantId,
              locationId: data.locationId,
              type: 'SALE',
              quantity: -data.quantity,
              referenceType: data.referenceType,
              referenceId: data.referenceId ?? null,
              note: data.note ?? null,
            },
          ],
          ctx,
          { action: 'inventory.issue', entityType: 'variant', entityId: data.variantId },
        ),
      );
    },

    /** Both sides in one applyMovements call: atomic by construction. */
    async transferStock(input: TransferStockInput, ctx: WriteContext): Promise<LedgerResult> {
      assertPermission(ctx, PERMISSIONS.inventory.transfer);
      const data = parse(transferStockSchema, input);
      return write(ctx, 'inventory.transfer', data, async (tx) => {
        const transferId = randomUUID();
        return applyMovements(
          tx,
          deps,
          [
            {
              variantId: data.variantId,
              locationId: data.fromLocationId,
              type: 'TRANSFER_OUT',
              quantity: -data.quantity,
              referenceType: 'TRANSFER',
              referenceId: transferId,
              transferId,
              note: data.note ?? null,
            },
            {
              variantId: data.variantId,
              locationId: data.toLocationId,
              type: 'TRANSFER_IN',
              quantity: data.quantity,
              referenceType: 'TRANSFER',
              referenceId: transferId,
              transferId,
              note: data.note ?? null,
              pairedWith: 0,
            },
          ],
          ctx,
          { action: 'inventory.transfer', entityType: 'transfer', entityId: transferId },
        );
      });
    },

    /** A correction that is *not* a count. Counts go through a stocktake. */
    async adjustStock(input: AdjustStockInput, ctx: WriteContext): Promise<LedgerResult> {
      assertPermission(ctx, PERMISSIONS.inventory.adjust);
      const data = parse(adjustStockSchema, input);
      return write(ctx, 'inventory.adjust', data, async (tx) =>
        applyMovements(
          tx,
          deps,
          [
            {
              variantId: data.variantId,
              locationId: data.locationId,
              type: 'ADJUSTMENT',
              quantity: data.delta,
              unitCost: data.delta > 0 ? (data.unitCost ?? null) : null,
              referenceType: 'MANUAL',
              reason: data.reason,
            },
          ],
          ctx,
          { action: 'inventory.adjust', entityType: 'variant', entityId: data.variantId },
        ),
      );
    },

    async damageStock(input: DamageStockInput, ctx: WriteContext): Promise<LedgerResult> {
      assertPermission(ctx, PERMISSIONS.inventory.damage);
      const data = parse(damageStockSchema, input);
      return write(ctx, 'inventory.damage', data, async (tx) =>
        applyMovements(
          tx,
          deps,
          [
            {
              variantId: data.variantId,
              locationId: data.locationId,
              type: 'DAMAGE',
              quantity: -data.quantity,
              referenceType: 'MANUAL',
              reason: data.reason,
            },
          ],
          ctx,
          { action: 'inventory.damage', entityType: 'variant', entityId: data.variantId },
        ),
      );
    },

    async reserveStock(input: ReserveStockInput, ctx: WriteContext): Promise<ReservationView> {
      assertPermission(ctx, PERMISSIONS.inventory.reserve);
      const data = parse(reserveStockSchema, input);
      return write(ctx, 'inventory.reserve', data, async (tx) => {
        const [location] = await deps.locations.locationsByIds(tx, [data.locationId]);
        if (!location) throw new NotFoundError('location', data.locationId);
        if (!location.isActive) throw new LocationInactiveError(location.id);
        if (!areReservationsAllowed(location.kind)) {
          throw new MovementNotAllowedAtLocationError({
            locationId: location.id,
            kind: location.kind,
            movement: 'RESERVATION',
          });
        }

        await changeReserved(tx, data, data.quantity);
        const reservation = await tx.reservation.create({
          data: {
            variantId: data.variantId,
            locationId: data.locationId,
            orderId: data.orderId,
            quantity: data.quantity,
            expiresAt: data.expiresAt ?? null,
            createdById: ctx.userId,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.reserve',
          entityType: 'reservation',
          entityId: reservation.id,
          after: reservation,
        });
        return toReservationView(reservation);
      });
    },

    async releaseStock(input: ReleaseStockInput, ctx: WriteContext): Promise<ReservationView> {
      assertPermission(ctx, PERMISSIONS.inventory.release);
      const data = parse(releaseStockSchema, input);
      return write(ctx, 'inventory.release', data, async (tx) => {
        const reservation = await tx.reservation.findUnique({ where: { id: data.reservationId } });
        if (!reservation || reservation.status !== 'ACTIVE') {
          throw new ReservationNotFoundError(data.reservationId);
        }
        await changeReserved(tx, reservation, -reservation.quantity);
        const released = await tx.reservation.update({
          where: { id: reservation.id },
          data: { status: 'RELEASED', releasedAt: new Date() },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.release',
          entityType: 'reservation',
          entityId: reservation.id,
          before: reservation,
          after: released,
        });
        return toReservationView(released);
      });
    },

    // ── Reads ───────────────────────────────────────────────────────────────────────────────

    async getBalance(input: BalanceQuery, ctx: ActorContext): Promise<BalanceView> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const key = parse(balanceQuerySchema, input);
      const row = await repo.findBalance(db, key);
      const view = toBalanceView(
        row ?? { ...key, quantity: 0, reservedQuantity: 0, valueBaseAmount: 0n },
      );
      return canSeeCost(ctx) ? view : redactBalance(view);
    },

    async listBalances(
      input: ListBalancesInput,
      ctx: ActorContext,
    ): Promise<{ variant: VariantView; balance: BalanceView }[]> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const data = parse(listBalancesSchema, input);
      const rows = await repo.listBalances(db, data);
      const variants = await deps.catalogue.variantsByIds(
        db,
        rows.map((r) => r.variantId),
      );
      const variantById = new Map(variants.map((v) => [v.id, v]));
      return rows.flatMap((row) => {
        const variant = variantById.get(row.variantId);
        if (!variant) return [];
        const balance = toBalanceView(row);
        return [{ variant, balance: canSeeCost(ctx) ? balance : redactBalance(balance) }];
      });
    },

    getMovements: readMovements,

    /**
     * Stock on hand per location and product: pieces, and value in SYP for those allowed to see
     * cost. Products come from the catalogue through its service, never its tables.
     */
    async stockSummary(ctx: ActorContext): Promise<StockSummaryRow[]> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const balances = await db.inventoryBalance.findMany({
        where: { quantity: { gt: 0 } },
        select: { variantId: true, locationId: true, quantity: true, valueBaseAmount: true },
      });
      const variants = await deps.catalogue.variantsByIds(db, [
        ...new Set(balances.map((b) => b.variantId)),
      ]);
      const productOf = new Map(variants.map((v) => [v.id, v.product]));
      const rows = new Map<string, StockSummaryRow>();
      for (const b of balances) {
        const product = productOf.get(b.variantId);
        if (!product) continue;
        const key = `${b.locationId}:${product.id}`;
        const row = rows.get(key) ?? {
          locationId: b.locationId,
          productId: product.id,
          productCode: product.code,
          // The category and the design: "ثوب · سعودية · ملكي · … · أبيض" (ADR-011).
          productNameAr: product.title ? `${product.nameAr} · ${product.title}` : product.nameAr,
          variants: 0,
          quantity: 0,
          valueBaseAmount: 0n,
        };
        row.variants += 1;
        row.quantity += b.quantity;
        row.valueBaseAmount = (row.valueBaseAmount ?? 0n) + b.valueBaseAmount;
        rows.set(key, row);
      }
      const result = [...rows.values()].sort((a, b) => a.productCode.localeCompare(b.productCode));
      return canSeeCost(ctx) ? result : result.map((r) => ({ ...r, valueBaseAmount: null }));
    },

    /** Movements with their item, newest first — the history screen. Cursor: beforeSeq. */
    async getMovementHistory(
      input: MovementsQuery,
      ctx: ActorContext,
    ): Promise<{ movement: MovementView; variant: VariantView | null }[]> {
      const movements = await readMovements(input, ctx);
      const variants = await deps.catalogue.variantsByIds(db, [
        ...new Set(movements.map((m) => m.variantId)),
      ]);
      const byId = new Map(variants.map((v) => [v.id, v]));
      return movements.map((movement) => ({
        movement,
        variant: byId.get(movement.variantId) ?? null,
      }));
    },

    /** Scanner lookup: internal barcode → external barcode → SKU. Never guesses. */
    async resolveBarcode(code: string, ctx: ActorContext): Promise<VariantView> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      return deps.catalogue.lookupBarcode(db, code);
    },

    /** For the nightly integrity job and the tests. Empty arrays mean the ledger is consistent. */
    async verifyLedger() {
      return repo.findLedgerDrift(db);
    },
  };
}

export type InventoryService = ReturnType<typeof createInventoryService>;

export interface StockSummaryRow {
  locationId: string;
  productId: string;
  productCode: string;
  productNameAr: string;
  /** Variants of this product with stock at this location. */
  variants: number;
  quantity: number;
  /** SYP minor units; null when the actor cannot see cost. */
  valueBaseAmount: bigint | null;
}

function toReservationView(r: {
  id: string;
  variantId: string;
  locationId: string;
  orderId: string;
  quantity: number;
  status: string;
  expiresAt: Date | null;
}): ReservationView {
  return {
    id: r.id,
    variantId: r.variantId,
    locationId: r.locationId,
    orderId: r.orderId,
    quantity: r.quantity,
    status: r.status,
    expiresAt: r.expiresAt,
  };
}
