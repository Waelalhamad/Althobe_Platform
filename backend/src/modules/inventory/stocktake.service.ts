import type { StocktakeScope, StocktakeStatus } from '@prisma/client';
import { z } from 'zod';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/ids.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import type { VariantView } from '../catalogue/catalogue.service.js';
import {
  LocationInactiveError,
  SecondApproverRequiredError,
  StocktakeStateError,
  UncountedLinesError,
  VariantInactiveError,
  VariantNotInStocktakeError,
} from './inventory.errors.js';
import { applyMovements, redactMovement, type LedgerDeps } from './inventory.ledger.js';
import type { MovementView } from './inventory.types.js';

// docs/inventory.md → "Stocktake". A count is evidence, not an adjustment:
//   DRAFT → COUNTING (expected snapshotted) → REVIEW (every line counted or confirmed zero)
//         → APPLIED (one STOCKTAKE movement per difference, applied by a second person)

const createSchema = z
  .object({
    locationId: z.uuid(),
    scope: z.enum(['FULL', 'PARTIAL']),
    variantIds: z.array(z.uuid()).min(1).max(5000).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .refine((s) => (s.scope === 'PARTIAL') === (s.variantIds !== undefined), {
    message: 'A partial stocktake lists its variants; a full one does not',
    path: ['variantIds'],
  });
const refSchema = z.object({ stocktakeId: z.uuid() });
const scanSchema = z.object({
  stocktakeId: z.uuid(),
  barcode: z.string().trim().min(1).max(64),
  scanId: z.string().trim().min(8).max(64),
});
const setCountSchema = z.object({
  stocktakeId: z.uuid(),
  variantId: z.uuid(),
  countedQuantity: z.number().int().min(0).max(1_000_000),
});
const reviewSchema = z.object({
  stocktakeId: z.uuid(),
  confirmUncountedAsZero: z.boolean().default(false),
});

export interface StocktakeLineView {
  variant: VariantView;
  expectedQuantity: number;
  countedQuantity: number | null;
  difference: number | null;
}

export interface StocktakeView {
  id: string;
  locationId: string;
  scope: StocktakeScope;
  status: StocktakeStatus;
  note: string | null;
  snapshotAt: Date | null;
  createdById: string;
  appliedById: string | null;
  appliedAt: Date | null;
  lines: StocktakeLineView[];
  /** Movements at this location after the snapshot. Non-zero means the count may have straddled them. */
  movementsSinceSnapshot: number;
}

interface StocktakeRow {
  id: string;
  location_id: string;
  scope: StocktakeScope;
  status: StocktakeStatus;
  snapshot_seq: bigint | null;
  created_by: string;
}

export function createStocktakeService(db: Db, deps: LedgerDeps) {
  async function lock(tx: Tx, id: string, mode: 'share' | 'update', expected: StocktakeStatus[]) {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<StocktakeRow[]>`
            SELECT id, location_id, scope, status, snapshot_seq, created_by
            FROM stocktakes WHERE id = ${id}::uuid FOR UPDATE`
        : await tx.$queryRaw<StocktakeRow[]>`
            SELECT id, location_id, scope, status, snapshot_seq, created_by
            FROM stocktakes WHERE id = ${id}::uuid FOR SHARE`;
    const stocktake = rows[0];
    if (!stocktake) throw new NotFoundError('stocktake', id);
    if (!expected.includes(stocktake.status))
      throw new StocktakeStateError(id, stocktake.status, expected);
    return stocktake;
  }

  /** What the ledger said for this variant at the snapshot — for variants found during counting. */
  async function expectedAtSnapshot(tx: Tx, st: StocktakeRow, variantId: string): Promise<number> {
    const [row] = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(quantity), 0)::bigint AS total FROM inventory_movements
      WHERE location_id = ${st.location_id}::uuid AND variant_id = ${variantId}::uuid
        AND seq <= ${st.snapshot_seq ?? 0n}`;
    return Number(row?.total ?? 0n);
  }

  /** Adds `delta` to the counted quantity (or sets it, with mode 'set'), creating the line if allowed. */
  async function count(
    tx: Tx,
    st: StocktakeRow,
    variantId: string,
    mode: 'add' | 'set',
    amount: number,
  ) {
    const existing = await tx.stocktakeLine.findUnique({
      where: { stocktakeId_variantId: { stocktakeId: st.id, variantId } },
    });
    if (!existing && st.scope === 'PARTIAL') throw new VariantNotInStocktakeError(st.id, variantId);
    const expected = existing
      ? existing.expectedQuantity
      : await expectedAtSnapshot(tx, st, variantId);

    if (mode === 'set') {
      await tx.$executeRaw`
        INSERT INTO stocktake_lines (id, stocktake_id, variant_id, expected_quantity, counted_quantity, created_at, updated_at)
        VALUES (${uuidv7()}::uuid, ${st.id}::uuid, ${variantId}::uuid, ${expected}, ${amount}, now(), now())
        ON CONFLICT (stocktake_id, variant_id)
        DO UPDATE SET counted_quantity = ${amount}, updated_at = now()`;
    } else {
      await tx.$executeRaw`
        INSERT INTO stocktake_lines (id, stocktake_id, variant_id, expected_quantity, counted_quantity, created_at, updated_at)
        VALUES (${uuidv7()}::uuid, ${st.id}::uuid, ${variantId}::uuid, ${expected}, ${amount}, now(), now())
        ON CONFLICT (stocktake_id, variant_id)
        DO UPDATE SET counted_quantity = COALESCE(stocktake_lines.counted_quantity, 0) + ${amount},
                      updated_at = now()`;
    }
  }

  async function view(q: Db | Tx, id: string): Promise<StocktakeView> {
    const st = await q.stocktake.findUnique({
      where: { id },
      include: { lines: { orderBy: { createdAt: 'asc' } } },
    });
    if (!st) throw new NotFoundError('stocktake', id);
    const variants = await deps.catalogue.variantsByIds(
      q,
      st.lines.map((l) => l.variantId),
    );
    const variantById = new Map(variants.map((v) => [v.id, v]));
    const movementsSinceSnapshot =
      st.snapshotSeq === null
        ? 0
        : await q.inventoryMovement.count({
            where: {
              locationId: st.locationId,
              seq: { gt: st.snapshotSeq },
              NOT: { referenceType: 'STOCKTAKE', referenceId: st.id },
            },
          });
    return {
      id: st.id,
      locationId: st.locationId,
      scope: st.scope,
      status: st.status,
      note: st.note,
      snapshotAt: st.snapshotAt,
      createdById: st.createdById,
      appliedById: st.appliedById,
      appliedAt: st.appliedAt,
      movementsSinceSnapshot,
      lines: st.lines.flatMap((line) => {
        const variant = variantById.get(line.variantId);
        if (!variant) return [];
        return [
          {
            variant,
            expectedQuantity: line.expectedQuantity,
            countedQuantity: line.countedQuantity,
            difference:
              line.countedQuantity === null ? null : line.countedQuantity - line.expectedQuantity,
          },
        ];
      }),
    };
  }

  return {
    async createStocktake(
      input: z.input<typeof createSchema>,
      ctx: ActorContext,
    ): Promise<StocktakeView> {
      assertPermission(ctx, PERMISSIONS.inventory.stocktakeCount);
      const data = parse(createSchema, input);
      return inTransaction(db, async (tx) => {
        const [location] = await deps.locations.locationsByIds(tx, [data.locationId]);
        if (!location) throw new NotFoundError('location', data.locationId);
        if (!location.isActive) throw new LocationInactiveError(location.id);

        const variantIds = [...new Set(data.variantIds ?? [])];
        if (variantIds.length) {
          const found = await deps.catalogue.variantsByIds(tx, variantIds);
          for (const id of variantIds) {
            const variant = found.find((v) => v.id === id);
            if (!variant) throw new NotFoundError('variant', id);
            if (!variant.isActive) throw new VariantInactiveError(id);
          }
        }

        const stocktake = await tx.stocktake.create({
          data: {
            locationId: data.locationId,
            scope: data.scope,
            note: data.note ?? null,
            createdById: ctx.userId,
            lines: { create: variantIds.map((variantId) => ({ variantId })) },
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.stocktake.create',
          entityType: 'stocktake',
          entityId: stocktake.id,
          after: { ...stocktake, variantIds },
        });
        return view(tx, stocktake.id);
      });
    },

    /**
     * Freezes what the ledger expects. Balance rows at the location are share-locked while the
     * snapshot is taken, so no stock write at this location can land half in and half out of it.
     */
    async startCounting(
      input: z.input<typeof refSchema>,
      ctx: ActorContext,
    ): Promise<StocktakeView> {
      assertPermission(ctx, PERMISSIONS.inventory.stocktakeCount);
      const { stocktakeId } = parse(refSchema, input);
      return inTransaction(db, async (tx) => {
        const st = await lock(tx, stocktakeId, 'update', ['DRAFT']);
        const balances = await tx.$queryRaw<{ variant_id: string; quantity: number }[]>`
          SELECT variant_id, quantity FROM inventory_balances
          WHERE location_id = ${st.location_id}::uuid
          ORDER BY variant_id
          FOR SHARE`;
        const [seqRow] = await tx.$queryRaw<{ seq: bigint }[]>`
          SELECT COALESCE(MAX(seq), 0)::bigint AS seq FROM inventory_movements
          WHERE location_id = ${st.location_id}::uuid`;
        const snapshotSeq = seqRow?.seq ?? 0n;
        const quantityOf = new Map(balances.map((b) => [b.variant_id, b.quantity]));

        if (st.scope === 'FULL') {
          const inStock = balances.filter((b) => b.quantity > 0);
          await tx.stocktakeLine.createMany({
            data: inStock.map((b) => ({
              stocktakeId,
              variantId: b.variant_id,
              expectedQuantity: b.quantity,
            })),
          });
        } else {
          const lines = await tx.stocktakeLine.findMany({ where: { stocktakeId } });
          for (const line of lines) {
            await tx.stocktakeLine.update({
              where: { id: line.id },
              data: { expectedQuantity: quantityOf.get(line.variantId) ?? 0 },
            });
          }
        }

        await tx.stocktake.update({
          where: { id: stocktakeId },
          data: { status: 'COUNTING', snapshotAt: new Date(), snapshotSeq },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.stocktake.start',
          entityType: 'stocktake',
          entityId: stocktakeId,
          after: { snapshotSeq },
        });
        return view(tx, stocktakeId);
      });
    },

    async scanCount(
      input: z.input<typeof scanSchema>,
      ctx: ActorContext,
    ): Promise<{ duplicate: boolean; line: StocktakeLineView }> {
      assertPermission(ctx, PERMISSIONS.inventory.stocktakeCount);
      const data = parse(scanSchema, input);
      return inTransaction(db, async (tx) => {
        const st = await lock(tx, data.stocktakeId, 'share', ['COUNTING']);
        const variant = await deps.catalogue.lookupBarcode(tx, data.barcode);

        const recorded = await tx.stocktakeScanEvent.createMany({
          data: [
            {
              stocktakeId: st.id,
              scanId: data.scanId,
              barcode: data.barcode,
              variantId: variant.id,
              createdById: ctx.userId,
            },
          ],
          skipDuplicates: true,
        });
        const duplicate = recorded.count === 0;
        if (!duplicate) await count(tx, st, variant.id, 'add', 1);

        const line = await tx.stocktakeLine.findUniqueOrThrow({
          where: { stocktakeId_variantId: { stocktakeId: st.id, variantId: variant.id } },
        });
        return {
          duplicate,
          line: {
            variant,
            expectedQuantity: line.expectedQuantity,
            countedQuantity: line.countedQuantity,
            difference:
              line.countedQuantity === null ? null : line.countedQuantity - line.expectedQuantity,
          },
        };
      });
    },

    async setCount(
      input: z.input<typeof setCountSchema>,
      ctx: ActorContext,
    ): Promise<StocktakeView> {
      assertPermission(ctx, PERMISSIONS.inventory.stocktakeCount);
      const data = parse(setCountSchema, input);
      return inTransaction(db, async (tx) => {
        const st = await lock(tx, data.stocktakeId, 'share', ['COUNTING']);
        const [variant] = await deps.catalogue.variantsByIds(tx, [data.variantId]);
        if (!variant) throw new NotFoundError('variant', data.variantId);
        await count(tx, st, data.variantId, 'set', data.countedQuantity);
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.stocktake.set_count',
          entityType: 'stocktake',
          entityId: st.id,
          after: { variantId: data.variantId, countedQuantity: data.countedQuantity },
        });
        return view(tx, st.id);
      });
    },

    /** Uncounted lines are never silently zero: the counter confirms them, or counts them. */
    async submitForReview(
      input: z.input<typeof reviewSchema>,
      ctx: ActorContext,
    ): Promise<StocktakeView> {
      assertPermission(ctx, PERMISSIONS.inventory.stocktakeCount);
      const data = parse(reviewSchema, input);
      return inTransaction(db, async (tx) => {
        const st = await lock(tx, data.stocktakeId, 'update', ['COUNTING']);
        const uncounted = await tx.stocktakeLine.findMany({
          where: { stocktakeId: st.id, countedQuantity: null },
          select: { variantId: true },
        });
        if (uncounted.length && !data.confirmUncountedAsZero) {
          throw new UncountedLinesError(
            st.id,
            uncounted.map((l) => l.variantId),
          );
        }
        if (uncounted.length) {
          await tx.stocktakeLine.updateMany({
            where: { stocktakeId: st.id, countedQuantity: null },
            data: { countedQuantity: 0 },
          });
        }
        await tx.stocktake.update({ where: { id: st.id }, data: { status: 'REVIEW' } });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.stocktake.review',
          entityType: 'stocktake',
          entityId: st.id,
          after: { confirmedAsZero: uncounted.map((l) => l.variantId) },
        });
        return view(tx, st.id);
      });
    },

    async getStocktake(
      input: z.input<typeof refSchema>,
      ctx: ActorContext,
    ): Promise<StocktakeView> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const { stocktakeId } = parse(refSchema, input);
      return view(db, stocktakeId);
    },

    /**
     * Posts the differences as a delta against the *current* balance — never overwrites it with
     * the counted figure — so movements that happened while counting are preserved.
     */
    async applyStocktake(
      input: z.input<typeof refSchema>,
      ctx: ActorContext,
    ): Promise<{ stocktake: StocktakeView; movements: MovementView[] }> {
      assertPermission(ctx, PERMISSIONS.inventory.stocktakeApply);
      const { stocktakeId } = parse(refSchema, input);
      return inTransaction(db, async (tx) => {
        const st = await lock(tx, stocktakeId, 'update', ['REVIEW']);
        if (st.created_by === ctx.userId) throw new SecondApproverRequiredError(st.id);

        const lines = await tx.stocktakeLine.findMany({
          where: { stocktakeId },
          orderBy: { createdAt: 'asc' },
        });
        const entries = lines
          .map((line) => ({ line, delta: (line.countedQuantity ?? 0) - line.expectedQuantity }))
          .filter(({ delta }) => delta !== 0)
          .map(({ line, delta }) => ({
            variantId: line.variantId,
            locationId: st.location_id,
            type: 'STOCKTAKE' as const,
            quantity: delta,
            referenceType: 'STOCKTAKE' as const,
            referenceId: st.id,
            reason: `Stocktake: expected ${line.expectedQuantity}, counted ${line.countedQuantity ?? 0}`,
          }));

        const result = await applyMovements(tx, deps, entries, ctx, {
          action: 'inventory.stocktake.apply',
          entityType: 'stocktake',
          entityId: st.id,
        });
        await tx.stocktake.update({
          where: { id: st.id },
          data: { status: 'APPLIED', appliedById: ctx.userId, appliedAt: new Date() },
        });
        const canSeeCost = ctx.permissions.has(PERMISSIONS.inventory.costView);
        return {
          stocktake: await view(tx, st.id),
          movements: canSeeCost ? result.movements : result.movements.map(redactMovement),
        };
      });
    },

    /** Recent stocktakes, newest first — the list screen and resuming a count. */
    async listStocktakes(input: { locationId?: string }, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const rows = await db.stocktake.findMany({
        where: input.locationId ? { locationId: input.locationId } : {},
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { _count: { select: { lines: true } } },
      });
      return rows.map(({ _count, ...st }) => ({ ...st, lineCount: _count.lines }));
    },

    async cancelStocktake(input: z.input<typeof refSchema>, ctx: ActorContext): Promise<void> {
      assertPermission(ctx, PERMISSIONS.inventory.stocktakeCount);
      const { stocktakeId } = parse(refSchema, input);
      await inTransaction(db, async (tx) => {
        await lock(tx, stocktakeId, 'update', ['DRAFT', 'COUNTING', 'REVIEW']);
        await tx.stocktake.update({
          where: { id: stocktakeId },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.stocktake.cancel',
          entityType: 'stocktake',
          entityId: stocktakeId,
        });
      });
    },
  };
}

export type StocktakeService = ReturnType<typeof createStocktakeService>;
