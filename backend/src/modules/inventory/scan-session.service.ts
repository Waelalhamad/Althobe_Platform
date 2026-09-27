import type { ScanSessionKind } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/ids.js';
import type { Currency } from '../../shared/money.js';
import {
  assertPermission,
  PERMISSIONS,
  type ActorContext,
  type Permission,
} from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import type { VariantView } from '../catalogue/catalogue.service.js';
import {
  CostNotAllowedError,
  EmptyScanSessionError,
  LocationInactiveError,
  MissingCostError,
  MovementNotAllowedAtLocationError,
  OpeningAlreadyRecordedError,
  ScanSessionNotOpenError,
  VariantInactiveError,
} from './inventory.errors.js';
import {
  applyMovements,
  redactMovement,
  toMovementView,
  type LedgerDeps,
} from './inventory.ledger.js';
import { isMovementAllowed } from './inventory.policy.js';
import * as repo from './inventory.repository.js';
import type { MovementEntry, MovementView } from './inventory.types.js';
import {
  lineRefSchema,
  openScanSessionSchema,
  scanSchema,
  sessionRefSchema,
  setLineCostSchema,
  setLineQuantitySchema,
  type LineRef,
  type OpenScanSessionInput,
  type ScanInput,
  type SessionRef,
  type SetLineCostInput,
  type SetLineQuantityInput,
} from './scan-session.schema.js';

// docs/inventory.md → "Barcode workflow — scan sessions".
// A session is a draft. Scanning never touches the ledger; commit posts everything at once.

const PERMISSION_BY_KIND: Record<ScanSessionKind, Permission> = {
  OPENING: PERMISSIONS.inventory.receive,
  RECEIVE: PERMISSIONS.inventory.receive,
  TRANSFER: PERMISSIONS.inventory.transfer,
  DAMAGE: PERMISSIONS.inventory.damage,
};

const COSTED_KINDS: ReadonlySet<ScanSessionKind> = new Set(['OPENING', 'RECEIVE']);

export interface ScanLineView {
  variant: VariantView;
  quantity: number;
  unitCost: { amount: bigint; currency: Currency; rateToBase: string } | null;
}

export interface ScanSessionView {
  id: string;
  kind: ScanSessionKind;
  status: string;
  locationId: string;
  toLocationId: string | null;
  reason: string | null;
  note: string | null;
  createdById: string;
  committedAt: Date | null;
  lines: ScanLineView[];
  totalQuantity: number;
}

export interface ScanResult {
  /** True when this scanId was already counted — a double trigger pull. Nothing changed. */
  duplicate: boolean;
  line: ScanLineView;
}

export interface CommitResult {
  sessionId: string;
  kind: ScanSessionKind;
  movements: MovementView[];
}

interface SessionRow {
  id: string;
  kind: ScanSessionKind;
  status: string;
  location_id: string;
  to_location_id: string | null;
  reason: string | null;
  created_by: string;
}

export function createScanSessionService(db: Db, deps: LedgerDeps) {
  const canSeeCost = (ctx: ActorContext) => ctx.permissions.has(PERMISSIONS.inventory.costView);

  async function lockSession(
    tx: Tx,
    sessionId: string,
    mode: 'share' | 'update',
  ): Promise<SessionRow> {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<SessionRow[]>`
            SELECT id, kind, status, location_id, to_location_id, reason, created_by
            FROM scan_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`
        : await tx.$queryRaw<SessionRow[]>`
            SELECT id, kind, status, location_id, to_location_id, reason, created_by
            FROM scan_sessions WHERE id = ${sessionId}::uuid FOR SHARE`;
    const session = rows[0];
    if (!session) throw new NotFoundError('scan_session', sessionId);
    return session;
  }

  /** Locks the session for a draft edit: it must exist, be open, and the actor must be allowed. */
  async function openSessionForEdit(
    tx: Tx,
    sessionId: string,
    ctx: ActorContext,
  ): Promise<SessionRow> {
    const session = await lockSession(tx, sessionId, 'share');
    assertPermission(ctx, PERMISSION_BY_KIND[session.kind]);
    if (session.status !== 'OPEN') throw new ScanSessionNotOpenError(sessionId, session.status);
    return session;
  }

  async function activeVariant(tx: Tx, variantId: string): Promise<VariantView> {
    const [variant] = await deps.catalogue.variantsByIds(tx, [variantId]);
    if (!variant) throw new NotFoundError('variant', variantId);
    if (!variant.isActive || !variant.product.isActive) throw new VariantInactiveError(variantId);
    return variant;
  }

  async function lineView(
    tx: Tx,
    sessionId: string,
    variant: VariantView,
    ctx: ActorContext,
  ): Promise<ScanLineView> {
    const line = await tx.scanSessionLine.findUnique({
      where: { sessionId_variantId: { sessionId, variantId: variant.id } },
    });
    return {
      variant,
      quantity: line?.quantity ?? 0,
      unitCost: canSeeCost(ctx) ? costOf(line) : null,
    };
  }

  async function commitResult(
    q: Db | Tx,
    session: SessionRow,
    ctx: ActorContext,
  ): Promise<CommitResult> {
    const movements = (
      await repo.movementsByReference(q, referenceTypeOf(session.kind), session.id)
    ).map(toMovementView);
    return {
      sessionId: session.id,
      kind: session.kind,
      movements: canSeeCost(ctx) ? movements : movements.map(redactMovement),
    };
  }

  return {
    async openSession(input: OpenScanSessionInput, ctx: ActorContext): Promise<ScanSessionView> {
      const data = parse(openScanSessionSchema, input);
      assertPermission(ctx, PERMISSION_BY_KIND[data.kind]);

      return inTransaction(db, async (tx) => {
        const ids = [data.locationId, ...(data.toLocationId ? [data.toLocationId] : [])];
        const locations = await deps.locations.locationsByIds(tx, ids);
        for (const id of ids) {
          const location = locations.find((l) => l.id === id);
          if (!location) throw new NotFoundError('location', id);
          if (!location.isActive) throw new LocationInactiveError(id);
        }
        // Fail at open, not after twenty minutes of scanning: e.g. the store cannot receive.
        const source = locations.find((l) => l.id === data.locationId)!;
        const firstMovement = entryTypeOf(data.kind);
        if (!isMovementAllowed(source.kind, firstMovement)) {
          throw new MovementNotAllowedAtLocationError({
            locationId: source.id,
            kind: source.kind,
            movement: firstMovement,
          });
        }

        const session = await tx.scanSession.create({
          data: {
            kind: data.kind,
            locationId: data.locationId,
            toLocationId: data.toLocationId ?? null,
            reason: data.reason ?? null,
            note: data.note ?? null,
            createdById: ctx.userId,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.scan_session.open',
          entityType: 'scan_session',
          entityId: session.id,
          after: session,
        });
        return { ...toSessionHeader(session), lines: [], totalQuantity: 0 };
      });
    },

    /** One physical scan: resolve the barcode, then +1 on that variant's line. */
    async scan(input: ScanInput, ctx: ActorContext): Promise<ScanResult> {
      const data = parse(scanSchema, input);
      return inTransaction(db, async (tx) => {
        await openSessionForEdit(tx, data.sessionId, ctx);
        const variant = await deps.catalogue.lookupBarcode(tx, data.barcode);
        if (!variant.isActive || !variant.product.isActive)
          throw new VariantInactiveError(variant.id);

        const recorded = await tx.scanSessionEvent.createMany({
          data: [
            {
              sessionId: data.sessionId,
              scanId: data.scanId,
              barcode: data.barcode,
              variantId: variant.id,
              createdById: ctx.userId,
            },
          ],
          skipDuplicates: true,
        });
        const duplicate = recorded.count === 0;

        if (!duplicate) {
          await tx.$executeRaw`
            INSERT INTO scan_session_lines (id, session_id, variant_id, quantity, created_at, updated_at)
            VALUES (${uuidv7()}::uuid, ${data.sessionId}::uuid, ${variant.id}::uuid, 1, now(), now())
            ON CONFLICT (session_id, variant_id)
            DO UPDATE SET quantity = scan_session_lines.quantity + 1, updated_at = now()`;
        }
        return { duplicate, line: await lineView(tx, data.sessionId, variant, ctx) };
      });
    },

    /** "Scan once, type 20" for a sealed carton. Sets the quantity; does not add to it. */
    async setLineQuantity(input: SetLineQuantityInput, ctx: ActorContext): Promise<ScanLineView> {
      const data = parse(setLineQuantitySchema, input);
      return inTransaction(db, async (tx) => {
        await openSessionForEdit(tx, data.sessionId, ctx);
        const variant = await activeVariant(tx, data.variantId);
        const before = await tx.scanSessionLine.findUnique({
          where: { sessionId_variantId: { sessionId: data.sessionId, variantId: data.variantId } },
        });
        await tx.scanSessionLine.upsert({
          where: { sessionId_variantId: { sessionId: data.sessionId, variantId: data.variantId } },
          create: { sessionId: data.sessionId, variantId: data.variantId, quantity: data.quantity },
          update: { quantity: data.quantity },
        });
        // A typed quantity overrides what was scanned — exactly what an audit trail is for.
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.scan_session.set_quantity',
          entityType: 'scan_session',
          entityId: data.sessionId,
          before: { variantId: data.variantId, quantity: before?.quantity ?? 0 },
          after: { variantId: data.variantId, quantity: data.quantity },
        });
        return lineView(tx, data.sessionId, variant, ctx);
      });
    },

    async setLineCost(input: SetLineCostInput, ctx: ActorContext): Promise<ScanLineView> {
      const data = parse(setLineCostSchema, input);
      return inTransaction(db, async (tx) => {
        const session = await openSessionForEdit(tx, data.sessionId, ctx);
        if (!COSTED_KINDS.has(session.kind))
          throw new CostNotAllowedError(data.sessionId, session.kind);
        const variant = await activeVariant(tx, data.variantId);
        const line = await tx.scanSessionLine.findUnique({
          where: { sessionId_variantId: { sessionId: data.sessionId, variantId: data.variantId } },
        });
        if (!line) throw new NotFoundError('scan_session_line', data.variantId);
        await tx.scanSessionLine.update({
          where: { id: line.id },
          data: {
            unitCostAmount: data.unitCost.amount,
            unitCostCurrency: data.unitCost.currency,
            rateToBase: data.unitCost.rateToBase,
          },
        });
        return lineView(tx, data.sessionId, variant, ctx);
      });
    },

    async removeLine(input: LineRef, ctx: ActorContext): Promise<void> {
      const data = parse(lineRefSchema, input);
      await inTransaction(db, async (tx) => {
        await openSessionForEdit(tx, data.sessionId, ctx);
        const removed = await tx.scanSessionLine.deleteMany({
          where: { sessionId: data.sessionId, variantId: data.variantId },
        });
        if (removed.count === 0) throw new NotFoundError('scan_session_line', data.variantId);
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.scan_session.remove_line',
          entityType: 'scan_session',
          entityId: data.sessionId,
          before: { variantId: data.variantId },
        });
      });
    },

    /** Open sessions, newest first — so a refreshed browser or a second device can resume. */
    async listOpenSessions(
      input: { locationId?: string },
      ctx: ActorContext,
    ): Promise<(Omit<ScanSessionView, 'lines'> & { lineCount: number })[]> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const rows = await db.scanSession.findMany({
        where: { status: 'OPEN', ...(input.locationId ? { locationId: input.locationId } : {}) },
        orderBy: { createdAt: 'desc' },
        take: 50,
        include: { lines: { select: { quantity: true } } },
      });
      return rows.map((s) => ({
        ...toSessionHeader(s),
        lineCount: s.lines.length,
        totalQuantity: s.lines.reduce((sum, l) => sum + l.quantity, 0),
      }));
    },

    async getSession(input: SessionRef, ctx: ActorContext): Promise<ScanSessionView> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const data = parse(sessionRefSchema, input);
      const session = await db.scanSession.findUnique({
        where: { id: data.sessionId },
        include: { lines: { orderBy: { createdAt: 'asc' } } },
      });
      if (!session) throw new NotFoundError('scan_session', data.sessionId);

      const variants = await deps.catalogue.variantsByIds(
        db,
        session.lines.map((l) => l.variantId),
      );
      const variantById = new Map(variants.map((v) => [v.id, v]));
      const lines = session.lines.flatMap((line) => {
        const variant = variantById.get(line.variantId);
        return variant
          ? [{ variant, quantity: line.quantity, unitCost: canSeeCost(ctx) ? costOf(line) : null }]
          : [];
      });
      return {
        ...toSessionHeader(session),
        lines,
        totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
      };
    },

    /**
     * Posts every line to the ledger in one transaction — all or nothing. Committing an already
     * committed session returns the original result, so a retried commit never posts twice.
     */
    async commitSession(input: SessionRef, ctx: ActorContext): Promise<CommitResult> {
      const data = parse(sessionRefSchema, input);
      return inTransaction(db, async (tx) => {
        const session = await lockSession(tx, data.sessionId, 'update');
        assertPermission(ctx, PERMISSION_BY_KIND[session.kind]);
        if (session.status === 'COMMITTED') return commitResult(tx, session, ctx);
        if (session.status !== 'OPEN')
          throw new ScanSessionNotOpenError(session.id, session.status);

        const lines = (
          await tx.scanSessionLine.findMany({
            where: { sessionId: session.id },
            orderBy: { createdAt: 'asc' },
          })
        ).filter((line) => line.quantity > 0);
        if (lines.length === 0) throw new EmptyScanSessionError(session.id);

        if (session.kind === 'RECEIVE') {
          const uncosted = lines
            .filter((line) => costOf(line) === null)
            .map((line) => line.variantId);
          if (uncosted.length) throw new MissingCostError(session.id, uncosted);
        }

        if (session.kind === 'OPENING') {
          await assertNoPriorMovements(
            tx,
            session.location_id,
            lines.map((l) => l.variantId),
          );
        }

        await applyMovements(tx, deps, entriesFor(session, lines), ctx, {
          action: 'inventory.scan_session.commit',
          entityType: 'scan_session',
          entityId: session.id,
        });
        await tx.scanSession.update({
          where: { id: session.id },
          data: { status: 'COMMITTED', committedById: ctx.userId, committedAt: new Date() },
        });
        return commitResult(tx, session, ctx);
      });
    },

    async cancelSession(input: SessionRef, ctx: ActorContext): Promise<void> {
      const data = parse(sessionRefSchema, input);
      await inTransaction(db, async (tx) => {
        const session = await lockSession(tx, data.sessionId, 'update');
        assertPermission(ctx, PERMISSION_BY_KIND[session.kind]);
        if (session.status !== 'OPEN')
          throw new ScanSessionNotOpenError(session.id, session.status);
        await tx.scanSession.update({
          where: { id: session.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.scan_session.cancel',
          entityType: 'scan_session',
          entityId: session.id,
        });
      });
    },
  };
}

export type ScanSessionService = ReturnType<typeof createScanSessionService>;

function entryTypeOf(kind: ScanSessionKind) {
  switch (kind) {
    case 'OPENING':
      return 'OPENING' as const;
    case 'RECEIVE':
      return 'PURCHASE' as const;
    case 'TRANSFER':
      return 'TRANSFER_OUT' as const;
    case 'DAMAGE':
      return 'DAMAGE' as const;
  }
}

function referenceTypeOf(kind: ScanSessionKind) {
  return kind === 'OPENING' ? ('OPENING' as const) : ('SCAN_SESSION' as const);
}

function entriesFor(
  session: SessionRow,
  lines: {
    variantId: string;
    quantity: number;
    unitCostAmount: bigint | null;
    unitCostCurrency: string | null;
    rateToBase: { toString(): string } | null;
  }[],
): MovementEntry[] {
  const reference = { referenceType: referenceTypeOf(session.kind), referenceId: session.id };

  if (session.kind === 'TRANSFER') {
    // One transfer id for the whole session; each line becomes an OUT/IN pair.
    return lines.flatMap((line, i) => [
      {
        variantId: line.variantId,
        locationId: session.location_id,
        type: 'TRANSFER_OUT' as const,
        quantity: -line.quantity,
        transferId: session.id,
        ...reference,
      },
      {
        variantId: line.variantId,
        locationId: session.to_location_id!,
        type: 'TRANSFER_IN' as const,
        quantity: line.quantity,
        transferId: session.id,
        pairedWith: i * 2,
        ...reference,
      },
    ]);
  }

  return lines.map((line) => ({
    variantId: line.variantId,
    locationId: session.location_id,
    type: entryTypeOf(session.kind),
    quantity: session.kind === 'DAMAGE' ? -line.quantity : line.quantity,
    unitCost: COSTED_KINDS.has(session.kind) ? costOf(line) : null,
    reason: session.reason,
    ...reference,
  }));
}

/** Opening stock is counted once per variant per location; later corrections go through a stocktake. */
async function assertNoPriorMovements(tx: Tx, locationId: string, variantIds: string[]) {
  const keys = repo.uniqueSortedKeys(variantIds.map((variantId) => ({ variantId, locationId })));
  // Lock first, so two opening sessions for the same variant cannot both pass the check.
  await repo.ensureBalances(tx, keys);
  await repo.lockBalances(tx, keys);
  const prior = await tx.inventoryMovement.findMany({
    where: { locationId, variantId: { in: variantIds } },
    select: { variantId: true },
    distinct: ['variantId'],
  });
  if (prior.length)
    throw new OpeningAlreadyRecordedError(
      locationId,
      prior.map((p) => p.variantId),
    );
}

function costOf(
  line: {
    unitCostAmount: bigint | null;
    unitCostCurrency: string | null;
    rateToBase: { toString(): string } | null;
  } | null,
) {
  if (
    !line ||
    line.unitCostAmount === null ||
    line.unitCostCurrency === null ||
    line.rateToBase === null
  ) {
    return null;
  }
  return {
    amount: line.unitCostAmount,
    currency: line.unitCostCurrency as Currency,
    rateToBase: line.rateToBase.toString(),
  };
}

function toSessionHeader(s: {
  id: string;
  kind: ScanSessionKind;
  status: string;
  locationId: string;
  toLocationId: string | null;
  reason: string | null;
  note: string | null;
  createdById: string;
  committedAt: Date | null;
}) {
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    locationId: s.locationId,
    toLocationId: s.toLocationId,
    reason: s.reason,
    note: s.note,
    createdById: s.createdById,
    committedAt: s.committedAt,
  };
}
