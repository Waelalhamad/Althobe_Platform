import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import type { VariantView } from '../catalogue/catalogue.service.js';
import { ShipmentStateError } from './inventory.errors.js';
import type { LedgerDeps } from './inventory.ledger.js';
import * as repo from './inventory.repository.js';

export interface ShipmentView {
  id: string;
  number: number;
  /** IN_TRANSIT · RECEIVED */
  status: string;
  fromLocationId: string;
  toLocationId: string;
  sendSessionId: string;
  /** The receiving scan, once opened. */
  receiveSessionId: string | null;
  note: string | null;
  sentBy: string;
  sentAt: Date;
  receivedBy: string | null;
  receivedAt: Date | null;
  lines: { variant: VariantView | null; sent: number; received: number | null }[];
  sent: number;
  /** Null while on the road. */
  received: number | null;
  lost: number | null;
  /** What it travelled at, USD cents; null without inventory.cost.view. */
  valueBaseAmount: bigint | null;
}

/**
 * Shipments between branches (developer report F-04). A transfer to a location in the other
 * branch is sent to the road (scan-session.service: commit); this lists them and opens the
 * receiving end's scan. The receiving scan's commit moves what arrived and loses the rest.
 */
export function createShipmentsService(db: Db, deps: LedgerDeps) {
  const canSeeCost = (ctx: ActorContext) => ctx.permissions.has(PERMISSIONS.inventory.costView);

  async function views(ctx: ActorContext, where: object): Promise<ShipmentView[]> {
    const mine = await deps.locations.branchLocationIds(db, ctx);
    const rows = await db.shipment.findMany({
      where: {
        ...where,
        // Either end in the actor's branch: Libya sees what is coming and what it sent.
        ...(mine ? { OR: [{ fromLocationId: { in: mine } }, { toLocationId: { in: mine } }] } : {}),
      },
      orderBy: { sentAt: 'desc' },
      take: 100,
      include: {
        lines: true,
        sentBy: { select: { nameAr: true } },
        receivedBy: { select: { nameAr: true } },
      },
    });
    const variants = await deps.catalogue.variantsByIds(db, [
      ...new Set(rows.flatMap((r) => r.lines.map((l) => l.variantId))),
    ]);
    const byId = new Map(variants.map((v) => [v.id, v]));
    const costs = canSeeCost(ctx);
    const result: ShipmentView[] = [];
    for (const r of rows) {
      let value: bigint | null = null;
      if (costs) {
        const out = await repo.movementsByReference(db, 'SCAN_SESSION', r.sendSessionId);
        value = out
          .filter((m) => m.type === 'TRANSFER_OUT')
          .reduce((s, m) => s - m.valueBaseAmount, 0n);
      }
      const sent = r.lines.reduce((s, l) => s + l.sentQuantity, 0);
      const received =
        r.status === 'RECEIVED' ? r.lines.reduce((s, l) => s + (l.receivedQuantity ?? 0), 0) : null;
      result.push({
        id: r.id,
        number: r.number,
        status: r.status,
        fromLocationId: r.fromLocationId,
        toLocationId: r.toLocationId,
        sendSessionId: r.sendSessionId,
        receiveSessionId: r.receiveSessionId,
        note: r.note,
        sentBy: r.sentBy.nameAr,
        sentAt: r.sentAt,
        receivedBy: r.receivedBy?.nameAr ?? null,
        receivedAt: r.receivedAt,
        lines: r.lines.map((l) => ({
          variant: byId.get(l.variantId) ?? null,
          sent: l.sentQuantity,
          received: l.receivedQuantity,
        })),
        sent,
        received,
        lost: received === null ? null : sent - received,
        valueBaseAmount: value,
      });
    }
    return result;
  }

  return {
    async listShipments(input: { status?: string }, ctx: ActorContext): Promise<ShipmentView[]> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      return views(ctx, input.status ? { status: input.status } : {});
    },

    async getShipment(id: string, ctx: ActorContext): Promise<ShipmentView> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const [view] = await views(ctx, { id });
      if (!view) throw new NotFoundError('shipment', id);
      return view;
    },

    /**
     * The receiving end scans what arrived. Opening it again returns the same open scan; a
     * cancelled one is replaced.
     */
    async openReceipt(id: string, ctx: ActorContext): Promise<{ sessionId: string }> {
      assertPermission(ctx, PERMISSIONS.inventory.receive);
      return inTransaction(db, async (tx) => {
        await tx.$queryRaw`SELECT id FROM shipments WHERE id = ${id}::uuid FOR UPDATE`;
        const shipment = await tx.shipment.findUnique({
          where: { id },
          include: { receiveSession: { select: { status: true } } },
        });
        if (!shipment) throw new NotFoundError('shipment', id);
        await deps.locations.assertInBranch(tx, ctx, shipment.toLocationId);
        if (shipment.status !== 'IN_TRANSIT') throw new ShipmentStateError(id, shipment.status);
        if (shipment.receiveSessionId && shipment.receiveSession?.status === 'OPEN') {
          return { sessionId: shipment.receiveSessionId };
        }
        const session = await tx.scanSession.create({
          data: {
            kind: 'SHIPMENT_IN',
            locationId: shipment.toLocationId,
            note: `شحنة رقم ${shipment.number}`,
            createdById: ctx.userId,
          },
        });
        await tx.shipment.update({ where: { id }, data: { receiveSessionId: session.id } });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'inventory.shipment.open_receipt',
          entityType: 'shipment',
          entityId: id,
          after: { sessionId: session.id },
        });
        return { sessionId: session.id };
      });
    },
  };
}

export type ShipmentsService = ReturnType<typeof createShipmentsService>;
