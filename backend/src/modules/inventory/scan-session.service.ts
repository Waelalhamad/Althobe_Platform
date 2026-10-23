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
  GiftNeedsRecipientError,
  LocationInactiveError,
  MissingCostError,
  MovementNotAllowedAtLocationError,
  OpeningAlreadyRecordedError,
  ReceiptNeedsSourceError,
  ScanSessionNotOpenError,
  ShipmentExcessError,
  ShipmentStateError,
  VariantInactiveError,
} from './inventory.errors.js';
import { inBranch, LocationOutOfBranchError } from '../locations/locations.service.js';
import {
  applyMovements,
  redactMovement,
  toMovementView,
  type LedgerDeps,
} from './inventory.ledger.js';
import { isMovementAllowed } from './inventory.policy.js';
import { correctReceiptSchema } from './inventory.schema.js';
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
  SALE: PERMISSIONS.inventory.issue,
  RETURN: PERMISSIONS.inventory.return,
  GIFT: PERMISSIONS.admin.gifts,
  SHIPMENT_IN: PERMISSIONS.inventory.receive,
};

const COSTED_KINDS: ReadonlySet<ScanSessionKind> = new Set(['OPENING', 'RECEIVE']);
const OUTGOING_KINDS: ReadonlySet<ScanSessionKind> = new Set(['DAMAGE', 'SALE', 'GIFT']);

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
  /** A confirmed receipt only: what it holds now, after its corrections. */
  received?: { variant: VariantView; quantity: number }[];
  /** F-04: the shipment this session sent or receives; what was sent, for the receiving end. */
  shipment?: {
    id: string;
    number: number;
    status: string;
    fromLocationId: string;
    toLocationId: string;
    sent: { variant: VariantView; quantity: number; received: number | null }[];
  };
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
  note: string | null;
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
            SELECT id, kind, status, location_id, to_location_id, reason, note, created_by
            FROM scan_sessions WHERE id = ${sessionId}::uuid FOR UPDATE`
        : await tx.$queryRaw<SessionRow[]>`
            SELECT id, kind, status, location_id, to_location_id, reason, note, created_by
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
    await deps.locations.assertInBranch(tx, ctx, session.location_id);
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

  async function commitInTx(tx: Tx, sessionId: string, ctx: ActorContext) {
    const session = await lockSession(tx, sessionId, 'update');
    assertPermission(ctx, PERMISSION_BY_KIND[session.kind]);
    await deps.locations.assertInBranch(tx, ctx, session.location_id);
    const done = async (alreadyCommitted: boolean) => ({
      alreadyCommitted,
      kind: session.kind,
      locationId: session.location_id,
      movements: (
        await repo.movementsByReference(tx, referenceTypeOf(session.kind), session.id)
      ).map(toMovementView),
      result: await commitResult(tx, session, ctx),
    });
    if (session.status === 'COMMITTED') return done(true);
    if (session.status !== 'OPEN') throw new ScanSessionNotOpenError(session.id, session.status);

    const lines = (
      await tx.scanSessionLine.findMany({
        where: { sessionId: session.id },
        orderBy: { createdAt: 'asc' },
      })
    ).filter((line) => line.quantity > 0);
    // A shipment may arrive with nothing in it: all of it is then lost on the road.
    if (lines.length === 0 && session.kind !== 'SHIPMENT_IN') {
      throw new EmptyScanSessionError(session.id);
    }

    // Opening stock needs its cost too (ADR-013): stock that enters at zero would make the
    // books show it as free and every sale of it as pure profit.
    if (COSTED_KINDS.has(session.kind)) {
      const uncosted = lines.filter((line) => costOf(line) === null).map((line) => line.variantId);
      if (uncosted.length) throw new MissingCostError(session.id, uncosted);
    }

    if (session.kind === 'OPENING') {
      await assertNoPriorMovements(
        tx,
        session.location_id,
        lines.map((l) => l.variantId),
      );
    }

    if (session.kind === 'SHIPMENT_IN') {
      await receiveShipment(tx, session, lines, ctx);
    } else {
      const shipTo = await shipmentDestination(tx, session);
      const transit = shipTo ? await deps.locations.transitLocation(tx) : null;
      await applyMovements(tx, deps, entriesFor(session, lines, transit?.id), ctx, {
        action: 'inventory.scan_session.commit',
        entityType: 'scan_session',
        entityId: session.id,
      });
      if (shipTo) await recordShipment(tx, session, lines, ctx);
    }
    await tx.scanSession.update({
      where: { id: session.id },
      data: { status: 'COMMITTED', committedById: ctx.userId, committedAt: new Date() },
    });
    return done(false);
  }

  /**
   * F-04: a transfer to a location in another branch is a shipment. Its pieces leave for the
   * road between branches, and enter the destination only when it confirms what arrived.
   */
  async function shipmentDestination(tx: Tx, session: SessionRow): Promise<string | null> {
    if (session.kind !== 'TRANSFER' || !session.to_location_id) return null;
    const [from, to] = await Promise.all([
      deps.locations.locationsByIds(tx, [session.location_id]),
      deps.locations.locationsByIds(tx, [session.to_location_id]),
    ]);
    return from[0]?.branch !== to[0]?.branch ? session.to_location_id : null;
  }

  async function recordShipment(
    tx: Tx,
    session: SessionRow,
    lines: { variantId: string; quantity: number }[],
    ctx: ActorContext,
  ) {
    const shipment = await tx.shipment.create({
      data: {
        fromLocationId: session.location_id,
        toLocationId: session.to_location_id!,
        sendSessionId: session.id,
        note: session.note,
        sentById: ctx.userId,
        lines: {
          create: lines.map((l) => ({ variantId: l.variantId, sentQuantity: l.quantity })),
        },
      },
    });
    await writeAudit(tx, {
      actorId: ctx.userId,
      action: 'inventory.shipment.send',
      entityType: 'shipment',
      entityId: shipment.id,
      after: { number: shipment.number, pieces: lines.reduce((s, l) => s + l.quantity, 0) },
    });
  }

  /**
   * What arrived leaves the road for the destination, at the value it travelled at; what was sent
   * and did not arrive is lost on the road. More than was sent, or something not sent, is
   * refused: it belongs to another shipment, or to a count.
   */
  async function receiveShipment(
    tx: Tx,
    session: SessionRow,
    lines: { variantId: string; quantity: number }[],
    ctx: ActorContext,
  ) {
    const found = await tx.shipment.findUnique({ where: { receiveSessionId: session.id } });
    if (!found) throw new NotFoundError('shipment', session.id);
    await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${found.id}::uuid FOR UPDATE`;
    const shipment = await tx.shipment.findUniqueOrThrow({
      where: { id: found.id },
      include: { lines: true },
    });
    if (shipment.status !== 'IN_TRANSIT')
      throw new ShipmentStateError(shipment.id, shipment.status);

    const arrived = new Map(lines.map((l) => [l.variantId, l.quantity]));
    const excess = lines
      .filter((l) => {
        const sent = shipment.lines.find((s) => s.variantId === l.variantId);
        return !sent || l.quantity > sent.sentQuantity;
      })
      .map((l) => l.variantId);
    if (excess.length) throw new ShipmentExcessError(shipment.id, excess);

    const transit = await deps.locations.transitLocation(tx);
    const road = {
      referenceType: 'SCAN_SESSION' as const,
      referenceId: session.id,
      transferId: shipment.id,
    };
    const entries: MovementEntry[] = [];
    for (const line of shipment.lines) {
      const received = arrived.get(line.variantId) ?? 0;
      if (received > 0) {
        entries.push(
          {
            ...road,
            variantId: line.variantId,
            locationId: transit.id,
            type: 'TRANSFER_OUT',
            quantity: -received,
            viaShipment: true,
          },
          {
            ...road,
            variantId: line.variantId,
            locationId: session.location_id,
            type: 'TRANSFER_IN',
            quantity: received,
            pairedWith: entries.length,
          },
        );
      }
      if (received < line.sentQuantity) {
        entries.push({
          ...road,
          variantId: line.variantId,
          locationId: transit.id,
          type: 'SHIPPING_LOSS',
          quantity: received - line.sentQuantity,
          reason: `شحنة رقم ${shipment.number}`,
          viaShipment: true,
        });
      }
    }
    await applyMovements(tx, deps, entries, ctx, {
      action: 'inventory.shipment.receive',
      entityType: 'shipment',
      entityId: shipment.id,
    });
    for (const line of shipment.lines) {
      await tx.shipmentLine.update({
        where: { shipmentId_variantId: { shipmentId: shipment.id, variantId: line.variantId } },
        data: { receivedQuantity: arrived.get(line.variantId) ?? 0 },
      });
    }
    await tx.shipment.update({
      where: { id: shipment.id },
      data: { status: 'RECEIVED', receivedById: ctx.userId, receivedAt: new Date() },
    });
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
        // The road between branches is reached only by a shipment (F-04).
        const road = locations.find((l) => l.kind === 'TRANSIT');
        if (road) {
          throw new MovementNotAllowedAtLocationError({
            locationId: road.id,
            kind: road.kind,
            movement: entryTypeOf(data.kind),
          });
        }
        if (!inBranch(ctx, source)) {
          throw new LocationOutOfBranchError(source.id, source.branch ?? '');
        }
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
      const mine = await deps.locations.branchLocationIds(db, ctx);
      const rows = await db.scanSession.findMany({
        where: {
          status: 'OPEN',
          ...(input.locationId ? { locationId: input.locationId } : {}),
          ...(mine ? { locationId: { in: mine } } : {}),
          ...(input.locationId && mine && !mine.includes(input.locationId)
            ? { id: { in: [] } }
            : {}),
        },
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
      await deps.locations.assertInBranch(db, ctx, session.locationId);

      const shipmentRow = await db.shipment.findFirst({
        where: { OR: [{ sendSessionId: session.id }, { receiveSessionId: session.id }] },
        include: { lines: true },
      });
      const variants = await deps.catalogue.variantsByIds(db, [
        ...new Set([
          ...session.lines.map((l) => l.variantId),
          ...(shipmentRow?.lines.map((l) => l.variantId) ?? []),
        ]),
      ]);
      const variantById = new Map(variants.map((v) => [v.id, v]));
      const lines = session.lines.flatMap((line) => {
        const variant = variantById.get(line.variantId);
        return variant
          ? [{ variant, quantity: line.quantity, unitCost: canSeeCost(ctx) ? costOf(line) : null }]
          : [];
      });
      // A confirmed receipt: each variant as it stands after its corrections (F-02), including
      // a variant that only came in by one (a wrong size moved to it).
      let received: { variant: VariantView; quantity: number }[] | undefined;
      if (session.kind === 'RECEIVE' && session.status === 'COMMITTED') {
        const net = new Map<string, number>();
        for (const m of await repo.movementsByReference(db, 'SCAN_SESSION', session.id)) {
          if (m.type === 'PURCHASE' || m.type === 'RECEIPT_CORRECTION') {
            net.set(m.variantId, (net.get(m.variantId) ?? 0) + m.quantity);
          }
        }
        const extra = [...net.keys()].filter((id) => !variantById.has(id));
        for (const v of await deps.catalogue.variantsByIds(db, extra)) variantById.set(v.id, v);
        received = [...net].flatMap(([id, quantity]) => {
          const variant = variantById.get(id);
          return variant ? [{ variant, quantity }] : [];
        });
      }
      const shipment = shipmentRow
        ? {
            id: shipmentRow.id,
            number: shipmentRow.number,
            status: shipmentRow.status,
            fromLocationId: shipmentRow.fromLocationId,
            toLocationId: shipmentRow.toLocationId,
            sent: shipmentRow.lines.flatMap((l) => {
              const variant = variantById.get(l.variantId);
              return variant
                ? [{ variant, quantity: l.sentQuantity, received: l.receivedQuantity }]
                : [];
            }),
          }
        : undefined;
      return {
        ...toSessionHeader(session),
        lines,
        totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0),
        ...(received ? { received } : {}),
        ...(shipment ? { shipment } : {}),
      };
    },

    /**
     * Posts every line to the ledger in one transaction — all or nothing. Committing an already
     * committed session returns the original result, so a retried commit never posts twice.
     */
    async commitSession(input: SessionRef, ctx: ActorContext): Promise<CommitResult> {
      const data = parse(sessionRefSchema, input);
      return inTransaction(db, async (tx) => {
        const kind = await tx.scanSession.findUnique({
          where: { id: data.sessionId },
          select: { kind: true, status: true },
        });
        // A receipt is owed to someone, or not: that is decided where it is confirmed.
        if (kind?.kind === 'RECEIVE' && kind.status === 'OPEN') {
          throw new ReceiptNeedsSourceError(data.sessionId);
        }
        // And a gift says who received it and why.
        if (kind?.kind === 'GIFT' && kind.status === 'OPEN') {
          throw new GiftNeedsRecipientError(data.sessionId);
        }
        const { result } = await commitInTx(tx, data.sessionId, ctx);
        return result;
      });
    },

    /**
     * Trusted call for parties (developer report F-02): corrects a confirmed receipt in the
     * caller's transaction. Each line becomes what it should have been — less of it (0 takes it
     * all back), more of it, or part of it moved to another variant — always at the line's own
     * cost, on the same receipt. Refused once the goods are no longer there to take back.
     */
    async correctReceiptInTx(tx: Tx, sessionId: string, input: unknown, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.inventory.receive);
      const data = parse(correctReceiptSchema, input);
      const session = await lockSession(tx, sessionId, 'update');
      if (session.kind !== 'RECEIVE') {
        throw new ScanSessionNotOpenError(sessionId, `${session.kind} is not a receipt`);
      }
      if (session.status !== 'COMMITTED')
        throw new ScanSessionNotOpenError(sessionId, session.status);
      const received = (await repo.movementsByReference(tx, 'SCAN_SESSION', sessionId)).map(
        toMovementView,
      );
      const entries: MovementEntry[] = [];
      for (const change of data.changes) {
        const own = received.filter(
          (m) =>
            m.variantId === change.variantId &&
            (m.type === 'PURCHASE' || m.type === 'RECEIPT_CORRECTION'),
        );
        // Its cost: as received, or — for a variant that came in by a correction (a wrong size
        // moved to it) — as moved; both carry the received line's cost.
        const first = own.find((m) => m.type === 'PURCHASE') ?? own.find((m) => m.quantity > 0);
        if (!first?.unitCost) throw new NotFoundError('receipt_line', change.variantId);
        const now = own.reduce((s, m) => s + m.quantity, 0);
        const base = {
          locationId: session.location_id,
          type: 'RECEIPT_CORRECTION' as const,
          unitCost: first.unitCost,
          referenceType: 'SCAN_SESSION' as const,
          referenceId: sessionId,
          reason: data.reason,
        };
        if (change.toVariantId) {
          // Part of the line was another variant all along: it moves, at the same cost.
          const moved = now - change.quantity;
          if (moved <= 0) continue;
          await activeVariant(tx, change.toVariantId);
          entries.push(
            { ...base, variantId: change.variantId, quantity: -moved },
            { ...base, variantId: change.toVariantId, quantity: moved },
          );
        } else if (change.quantity !== now) {
          entries.push({ ...base, variantId: change.variantId, quantity: change.quantity - now });
        }
      }
      const result = await applyMovements(tx, deps, entries, ctx, {
        action: 'inventory.receipt.correct',
        entityType: 'scan_session',
        entityId: sessionId,
      });
      return { locationId: session.location_id, movements: result.movements };
    },

    /**
     * Trusted call for parties (ADR-016) and gifts (F-06): commits in the caller's transaction, so a supplier's
     * bill or a customer's invoice is recorded with the goods or not at all. `movements` keep
     * their cost; `alreadyCommitted` tells a retry from the first commit.
     */
    commitInTx,

    async cancelSession(input: SessionRef, ctx: ActorContext): Promise<void> {
      const data = parse(sessionRefSchema, input);
      await inTransaction(db, async (tx) => {
        const session = await lockSession(tx, data.sessionId, 'update');
        assertPermission(ctx, PERMISSION_BY_KIND[session.kind]);
        await deps.locations.assertInBranch(tx, ctx, session.location_id);
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
    case 'SALE':
      return 'SALE' as const;
    case 'RETURN':
      return 'RETURN' as const;
    case 'GIFT':
      return 'GIFT' as const;
    case 'SHIPMENT_IN':
      return 'TRANSFER_IN' as const;
  }
}

function referenceTypeOf(kind: ScanSessionKind) {
  return kind === 'OPENING' ? ('OPENING' as const) : ('SCAN_SESSION' as const);
}

/** `transitId`: a shipment to another branch goes on the road instead (F-04). */
function entriesFor(
  session: SessionRow,
  lines: {
    variantId: string;
    quantity: number;
    unitCostAmount: bigint | null;
    unitCostCurrency: string | null;
    rateToBase: { toString(): string } | null;
  }[],
  transitId?: string,
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
        locationId: transitId ?? session.to_location_id!,
        type: 'TRANSFER_IN' as const,
        quantity: line.quantity,
        transferId: session.id,
        pairedWith: i * 2,
        ...(transitId ? { viaShipment: true } : {}),
        ...reference,
      },
    ]);
  }

  return lines.map((line) => ({
    variantId: line.variantId,
    locationId: session.location_id,
    type: entryTypeOf(session.kind),
    // Damage, sales and gifts take stock away; everything else here brings it in.
    quantity: OUTGOING_KINDS.has(session.kind) ? -line.quantity : line.quantity,
    unitCost: COSTED_KINDS.has(session.kind) ? costOf(line) : null,
    reason: session.reason,
    note: session.note,
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
