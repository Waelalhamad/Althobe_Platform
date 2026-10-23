import { randomUUID } from 'node:crypto';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Queryable, type Tx } from '../../shared/db.js';
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
  AdjustmentRequestStateError,
  SelfApprovalError,
  MovementNotAllowedAtLocationError,
  ReservationNotFoundError,
  LocationInactiveError,
  MovementNotUndoableError,
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
  decideAdjustmentSchema,
  damageStockSchema,
  issueStockSchema,
  listBalancesSchema,
  movementsQuerySchema,
  receiveStockSchema,
  releaseStockSchema,
  reserveStockSchema,
  transferStockSchema,
  undoMovementSchema,
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
import type {
  AdjustmentReason,
  BalanceView,
  LedgerResult,
  MovementView,
} from './inventory.types.js';

/** At most this much taken away by hand applies without a second person (F-03). */
const AUTO_PIECES = 3;
const AUTO_VALUE_BASE = 5_000n;

const ADJUSTMENT_LABEL: Record<AdjustmentReason, string> = {
  COUNT_DIFFERENCE: 'فرق جرد',
  DAMAGE: 'تالف',
  SAMPLE: 'عينة تسويق',
  INTERNAL_USE: 'استهلاك داخلي',
  GIFT: 'هدية / إكرامية',
};

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

  async function applyAdjustment(
    tx: Tx,
    data: ReturnType<typeof adjustStockSchema.parse>,
    ctx: ActorContext & { idempotencyKey?: string },
    requestedBy?: string,
  ): Promise<LedgerResult> {
    const label = ADJUSTMENT_LABEL[data.reasonCode];
    return applyMovements(
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
          reasonCode: data.reasonCode,
          reason: data.note ? `${label} — ${data.note}` : label,
          note: requestedBy ? `طلبه ${requestedBy}` : null,
        },
      ],
      ctx,
      { action: 'inventory.adjust', entityType: 'variant', entityId: data.variantId },
    );
  }

  async function decide(
    id: string,
    status: 'APPROVED' | 'REJECTED',
    input: unknown,
    ctx: WriteContext,
  ) {
    assertPermission(ctx, PERMISSIONS.inventory.adjustApprove);
    const { note } = parse(decideAdjustmentSchema, input ?? {});
    return write(ctx, `inventory.adjust.${status.toLowerCase()}`, { id, note }, async (tx) => {
      await tx.$queryRaw`SELECT id FROM adjustment_requests WHERE id = ${id}::uuid FOR UPDATE`;
      const request = await tx.adjustmentRequest.findUnique({
        where: { id },
        include: { requestedBy: { select: { nameAr: true } } },
      });
      if (!request) throw new NotFoundError('adjustment_request', id);
      if (request.status !== 'PENDING') throw new AdjustmentRequestStateError(id, request.status);
      if (request.requestedById === ctx.userId) throw new SelfApprovalError(id);
      let movementId: string | null = null;
      if (status === 'APPROVED') {
        const result = await applyAdjustment(
          tx,
          {
            variantId: request.variantId,
            locationId: request.locationId,
            delta: request.delta,
            reasonCode: request.reasonCode as AdjustmentReason,
            note: request.note ?? undefined,
          },
          ctx,
          request.requestedBy.nameAr,
        );
        movementId = result.movements[0]!.id;
      }
      await tx.adjustmentRequest.update({
        where: { id },
        data: {
          status,
          decidedById: ctx.userId,
          decidedAt: new Date(),
          decisionNote: note || null,
          movementId,
        },
      });
      await writeAudit(tx, {
        actorId: ctx.userId,
        action: `inventory.adjust.${status.toLowerCase()}`,
        entityType: 'adjustment_request',
        entityId: id,
        after: { movementId },
      });
      return { id, status, movementId };
    });
  }

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

    /**
     * A correction that is *not* a count (counts go through a stocktake), applied at once. The
     * app asks through `requestAdjustment`, which applies only small take-aways at once.
     */
    async adjustStock(input: AdjustStockInput, ctx: WriteContext): Promise<LedgerResult> {
      assertPermission(ctx, PERMISSIONS.inventory.adjust);
      const data = parse(adjustStockSchema, input);
      return write(ctx, 'inventory.adjust', data, async (tx) => applyAdjustment(tx, data, ctx));
    },

    /**
     * تعديل يدوي (developer report F-03). A small take-away (at most 3 pieces and 50 $) applies
     * at once; anything bigger, and any increase, waits for someone else with
     * inventory.adjust.approve and changes nothing until then.
     */
    async requestAdjustment(input: AdjustStockInput, ctx: WriteContext) {
      assertPermission(ctx, PERMISSIONS.inventory.adjust);
      const data = parse(adjustStockSchema, input);
      return write(ctx, 'inventory.adjust.request', data, async (tx) => {
        const balance = await repo.findBalance(tx, data);
        const average =
          balance && balance.quantity > 0 ? balance.valueBaseAmount / BigInt(balance.quantity) : 0n;
        const estimate = average * BigInt(Math.abs(data.delta));
        const small = data.delta < 0 && -data.delta <= AUTO_PIECES && estimate <= AUTO_VALUE_BASE;
        if (small) {
          const result = await applyAdjustment(tx, data, ctx);
          return { status: 'APPLIED' as const, movements: result.movements, requestId: null };
        }
        const request = await tx.adjustmentRequest.create({
          data: {
            variantId: data.variantId,
            locationId: data.locationId,
            delta: data.delta,
            reasonCode: data.reasonCode,
            note: data.note || null,
            valueEstimate: estimate,
            requestedById: ctx.userId,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.adjust.request',
          entityType: 'adjustment_request',
          entityId: request.id,
          after: { delta: data.delta, reasonCode: data.reasonCode, estimate },
        });
        return { status: 'PENDING' as const, movements: [], requestId: request.id };
      });
    },

    async listAdjustmentRequests(input: { status?: string }, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const rows = await db.adjustmentRequest.findMany({
        where: input.status ? { status: input.status } : {},
        orderBy: { requestedAt: 'desc' },
        take: 100,
        include: {
          requestedBy: { select: { nameAr: true } },
          decidedBy: { select: { nameAr: true } },
          location: { select: { nameAr: true } },
        },
      });
      const variants = await deps.catalogue.variantsByIds(db, [
        ...new Set(rows.map((r) => r.variantId)),
      ]);
      const byId = new Map(variants.map((v) => [v.id, v]));
      const costs = canSeeCost(ctx);
      return rows.map((r) => ({
        id: r.id,
        variant: byId.get(r.variantId) ?? null,
        location: r.location.nameAr,
        delta: r.delta,
        reasonCode: r.reasonCode,
        note: r.note,
        valueEstimate: costs ? r.valueEstimate : null,
        status: r.status,
        requestedBy: r.requestedBy.nameAr,
        requestedById: r.requestedById,
        requestedAt: r.requestedAt,
        decidedBy: r.decidedBy?.nameAr ?? null,
        decidedAt: r.decidedAt,
        decisionNote: r.decisionNote,
      }));
    },

    /** Someone other than the asker accepts: the adjustment applies now, against today's stock. */
    async approveAdjustment(id: string, input: unknown, ctx: WriteContext) {
      return decide(id, 'APPROVED', input, ctx);
    },

    async rejectAdjustment(id: string, input: unknown, ctx: WriteContext) {
      return decide(id, 'REJECTED', input, ctx);
    },

    /**
     * «تراجع» (owner only): undoes a manual adjustment, damage write-off or gift. The same type with the
     * opposite quantity and exactly the opposite value, so stock and the books return to what
     * they were. Refused once the pieces it would take back were sold or moved.
     */
    async undoMovement(id: string, input: unknown, ctx: WriteContext): Promise<LedgerResult> {
      assertPermission(ctx, PERMISSIONS.admin.undo);
      const { reason } = parse(undoMovementSchema, input);
      return write(ctx, 'inventory.undo', { id, reason }, async (tx) => {
        // Two undos of the same movement queue here; the second finds it already undone.
        await tx.$queryRaw`SELECT id FROM inventory_movements WHERE id = ${id}::uuid FOR UPDATE`;
        const original = await tx.inventoryMovement.findUnique({
          where: { id },
          include: { reversedBy: { select: { id: true } } },
        });
        if (!original) throw new NotFoundError('movement', id);
        if (original.reversesId) throw new MovementNotUndoableError(id, 'IS_UNDO');
        if (original.reversedBy) throw new MovementNotUndoableError(id, 'ALREADY_UNDONE');
        const manual =
          original.referenceType === 'MANUAL' &&
          (original.type === 'ADJUSTMENT' || original.type === 'DAMAGE');
        if (!manual && original.type !== 'GIFT') throw new MovementNotUndoableError(id, 'KIND');
        return applyMovements(
          tx,
          deps,
          [
            {
              variantId: original.variantId,
              locationId: original.locationId,
              type: original.type,
              quantity: -original.quantity,
              referenceType: 'MANUAL',
              referenceId: original.id,
              reasonCode: original.reasonCode as AdjustmentReason | null,
              reason,
              undo: { movementId: original.id, value: -original.valueBaseAmount },
            },
          ],
          ctx,
          { action: 'inventory.undo', entityType: 'movement', entityId: original.id },
        );
      });
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
     * Trusted call for retail (ADR-014): a POS sale takes its pieces out of the store (SALE), a
     * refund puts them back (RETURN) at the cost they left with. Runs inside the caller's
     * transaction, so the receipt and the stock change commit together or not at all.
     */
    async postRetailMovements(
      tx: Tx,
      input: {
        kind: 'SALE' | 'REFUND';
        locationId: string;
        saleId: string;
        lines: { variantId: string; quantity: number; unitCostBase?: bigint }[];
        note?: string | null;
      },
      ctx: { userId: string },
    ): Promise<MovementView[]> {
      const result = await applyMovements(
        tx,
        deps,
        input.lines.map((l) => ({
          variantId: l.variantId,
          locationId: input.locationId,
          type: input.kind === 'SALE' ? ('SALE' as const) : ('RETURN' as const),
          quantity: input.kind === 'SALE' ? -l.quantity : l.quantity,
          referenceType: input.kind === 'SALE' ? ('SALES_ORDER' as const) : ('RETURN' as const),
          referenceId: input.saleId,
          reason: input.kind === 'REFUND' ? (input.note ?? null) : null,
          note: input.kind === 'SALE' ? (input.note ?? null) : null,
          unitCost:
            input.kind === 'REFUND' && l.unitCostBase !== undefined
              ? { amount: l.unitCostBase, currency: 'USD' as const, rateToBase: '1' }
              : null,
        })),
        { userId: ctx.userId },
        {
          action: input.kind === 'SALE' ? 'retail.sale' : 'retail.refund',
          entityType: 'pos_sale',
          entityId: input.saleId,
        },
      );
      return result.movements;
    },

    /**
     * Trusted call for accounting (ADR-013): movements after `afterSeq` in ledger order, with
     * their values. Accounting posts them to the general ledger; it never reads this table itself.
     */
    async movementsAfter(q: Queryable, afterSeq: bigint, limit: number): Promise<MovementView[]> {
      const rows = await q.inventoryMovement.findMany({
        where: { seq: { gt: afterSeq } },
        orderBy: { seq: 'asc' },
        take: limit,
      });
      return rows.map(toMovementView);
    },

    /**
     * Trusted call for gifts (F-06): the GIFT movements of these sessions, each with whether it
     * was undone («تراجع»), so a gift report shows what really left.
     */
    async giftMovements(
      q: Queryable,
      sessionIds: string[],
    ): Promise<{ movement: MovementView; undone: boolean }[]> {
      if (sessionIds.length === 0) return [];
      const rows = await q.inventoryMovement.findMany({
        where: { type: 'GIFT', referenceType: 'SCAN_SESSION', referenceId: { in: sessionIds } },
        orderBy: { seq: 'asc' },
        include: { reversedBy: { select: { id: true } } },
      });
      return rows.map((r) => ({ movement: toMovementView(r), undone: r.reversedBy !== null }));
    },

    /** Trusted call for accounting's books check: total stock value per location, USD cents. */
    async valueByLocation(
      q: Queryable,
    ): Promise<{ locationId: string; valueBaseAmount: bigint }[]> {
      const rows = await q.inventoryBalance.groupBy({
        by: ['locationId'],
        _sum: { valueBaseAmount: true },
      });
      return rows.map((r) => ({
        locationId: r.locationId,
        valueBaseAmount: r._sum.valueBaseAmount ?? 0n,
      }));
    },

    /**
     * Stock on hand per location and product: pieces, and value in USD for those allowed to see
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
    ): Promise<
      { movement: MovementView; variant: VariantView | null; undoneById: string | null }[]
    > {
      const movements = await readMovements(input, ctx);
      const variants = await deps.catalogue.variantsByIds(db, [
        ...new Set(movements.map((m) => m.variantId)),
      ]);
      const byId = new Map(variants.map((v) => [v.id, v]));
      const undos = await db.inventoryMovement.findMany({
        where: { reversesId: { in: movements.map((m) => m.id) } },
        select: { id: true, reversesId: true },
      });
      const undoneBy = new Map(undos.map((u) => [u.reversesId!, u.id]));
      return movements.map((movement) => ({
        movement,
        variant: byId.get(movement.variantId) ?? null,
        undoneById: undoneBy.get(movement.id) ?? null,
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
  /** USD cents; null when the actor cannot see cost. */
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
