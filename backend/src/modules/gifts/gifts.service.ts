import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import type { PhotoStorage } from '../../shared/storage.js';
import { parse } from '../../shared/validation.js';
import type { CatalogueService, VariantView } from '../catalogue/catalogue.service.js';
import {
  ImageTooLargeError,
  InvalidImageError,
  MAX_IMAGE_BYTES,
  PhotosDisabledError,
  sniffImage,
} from '../catalogue/photo.service.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { ScanSessionService } from '../inventory/scan-session.service.js';
import { NotAGiftSessionError } from './gifts.errors.js';
import {
  confirmGiftSchema,
  giftPhotoSchema,
  giftsQuerySchema,
  type RecipientKind,
} from './gifts.schema.js';

export interface GiftsDeps {
  scanSessions: ScanSessionService;
  inventory: InventoryService;
  catalogue: CatalogueService;
  storage: PhotoStorage | null;
}

export interface RecipientView {
  id: string;
  name: string;
  kind: RecipientKind;
  phone: string | null;
}

export interface GiftView {
  sessionId: string;
  /** The business day in Damascus it was given. */
  date: string;
  givenAt: Date;
  locationId: string;
  recipient: RecipientView;
  occasion: string;
  reference: string | null;
  hasPhoto: boolean;
  createdBy: string;
  lines: { variant: VariantView | null; quantity: number; valueBaseAmount: bigint }[];
  /** What really left: pieces put back («تراجع») are not counted. */
  quantity: number;
  /** At cost, USD cents: what 5212 holds for it. */
  valueBaseAmount: bigint;
  /** Every piece was put back. */
  undone: boolean;
}

const LINK_SECONDS = 300;
const EXTENSION = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' } as const;
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' });

/**
 * الهدايا والإكراميات (developer report F-06). A gift is a GIFT scan session confirmed with who
 * received it and why; only the owner gives them (2026-10-23), so there is no approval. The
 * pieces leave stock as GIFT movements, which the ledger posts to 5212 at the average cost.
 */
export function createGiftsService(db: Db, deps: GiftsDeps) {
  // The accountant reads the report; giving is the owner's.
  const assertCanRead = (ctx: ActorContext) => {
    if (!ctx.permissions.has(PERMISSIONS.accounting.view)) {
      assertPermission(ctx, PERMISSIONS.admin.gifts);
    }
  };
  const store = () => {
    if (!deps.storage) throw new PhotosDisabledError();
    return deps.storage;
  };

  /** A new name already on the list is the same recipient: no second spelling of a shipper. */
  async function recipientFor(
    tx: Tx,
    data: ReturnType<typeof confirmGiftSchema.parse>,
    ctx: ActorContext,
  ) {
    if (data.recipientId) {
      const found = await tx.giftRecipient.findUnique({ where: { id: data.recipientId } });
      if (!found) throw new NotFoundError('gift_recipient', data.recipientId);
      return found;
    }
    const { name, kind, phone } = data.recipient!;
    const [same] = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM gift_recipients WHERE lower(btrim(name)) = lower(btrim(${name}))`,
    );
    if (same) return tx.giftRecipient.findUniqueOrThrow({ where: { id: same.id } });
    return tx.giftRecipient.create({
      data: { name, kind, phone: phone || null, createdById: ctx.userId },
    });
  }

  async function views(where: Prisma.GiftWhereInput): Promise<GiftView[]> {
    const gifts = await db.gift.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 500,
      include: {
        recipient: true,
        createdBy: { select: { nameAr: true } },
        session: { select: { locationId: true, committedAt: true } },
      },
    });
    const moves = await deps.inventory.giftMovements(
      db,
      gifts.map((g) => g.sessionId),
    );
    const variants = await deps.catalogue.variantsByIds(db, [
      ...new Set(moves.map((m) => m.movement.variantId)),
    ]);
    const variantById = new Map(variants.map((v) => [v.id, v]));
    return gifts.map((g) => {
      const own = moves.filter((m) => m.movement.referenceId === g.sessionId);
      const lines = own.map(({ movement: m, undone }) => ({
        variant: variantById.get(m.variantId) ?? null,
        quantity: undone ? 0 : -m.quantity,
        valueBaseAmount: undone ? 0n : -(m.valueBaseAmount ?? 0n),
      }));
      const givenAt = g.session.committedAt ?? g.createdAt;
      return {
        sessionId: g.sessionId,
        date: day.format(givenAt),
        givenAt,
        locationId: g.session.locationId,
        recipient: toRecipient(g.recipient),
        occasion: g.occasion,
        reference: g.reference,
        hasPhoto: g.photoKey !== null,
        createdBy: g.createdBy.nameAr,
        lines,
        quantity: lines.reduce((s, l) => s + l.quantity, 0),
        valueBaseAmount: lines.reduce((s, l) => s + l.valueBaseAmount, 0n),
        undone: own.length > 0 && own.every((m) => m.undone),
      };
    });
  }

  async function oneGift(sessionId: string): Promise<GiftView> {
    const [view] = await views({ sessionId });
    if (!view) throw new NotFoundError('gift', sessionId);
    return view;
  }

  return {
    async listRecipients(ctx: ActorContext): Promise<RecipientView[]> {
      assertCanRead(ctx);
      const rows = await db.giftRecipient.findMany({ orderBy: { name: 'asc' } });
      return rows.map(toRecipient);
    },

    /**
     * Confirms a GIFT scan session: the pieces leave stock with who received them and why, in
     * one transaction. Confirming it again returns the same gift.
     */
    async confirmGift(sessionId: string, input: unknown, ctx: ActorContext): Promise<GiftView> {
      assertPermission(ctx, PERMISSIONS.admin.gifts);
      const data = parse(confirmGiftSchema, input);
      await inTransaction(db, async (tx) => {
        const done = await deps.scanSessions.commitInTx(tx, sessionId, ctx);
        if (done.kind !== 'GIFT') throw new NotAGiftSessionError(sessionId, done.kind);
        if (done.alreadyCommitted) return;
        const recipient = await recipientFor(tx, data, ctx);
        await tx.gift.create({
          data: {
            sessionId,
            recipientId: recipient.id,
            occasion: data.occasion,
            reference: data.reference || null,
            createdById: ctx.userId,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'gifts.give',
          entityType: 'scan_session',
          entityId: sessionId,
          after: { recipientId: recipient.id, occasion: data.occasion },
        });
      });
      return oneGift(sessionId);
    },

    async listGifts(input: unknown, ctx: ActorContext): Promise<GiftView[]> {
      assertCanRead(ctx);
      const q = parse(giftsQuerySchema, input ?? {});
      const rows = await views({
        ...(q.recipientId ? { recipientId: q.recipientId } : {}),
        ...(q.kind ? { recipient: { kind: q.kind } } : {}),
        ...(q.locationId ? { session: { locationId: q.locationId } } : {}),
      });
      return rows.filter((g) => (!q.from || g.date >= q.from) && (!q.to || g.date <= q.to));
    },

    async getGift(sessionId: string, ctx: ActorContext): Promise<GiftView> {
      assertCanRead(ctx);
      return oneGift(sessionId);
    },

    /** The delivery receipt photo; a new one replaces the old. */
    async uploadPhoto(sessionId: string, input: unknown, ctx: ActorContext): Promise<GiftView> {
      assertPermission(ctx, PERMISSIONS.admin.gifts);
      const { image: base64 } = parse(giftPhotoSchema, input);
      const s3 = store();
      const image = Buffer.from(base64, 'base64');
      const type = sniffImage(image);
      if (!type) throw new InvalidImageError();
      if (image.length > MAX_IMAGE_BYTES) {
        throw new ImageTooLargeError(image.length, MAX_IMAGE_BYTES);
      }
      const gift = await db.gift.findUnique({ where: { sessionId } });
      if (!gift) throw new NotFoundError('gift', sessionId);

      // The key is made here, from ids — never from anything the client sent.
      const key = `gifts/${sessionId}/${randomUUID()}.${EXTENSION[type]}`;
      await s3.put(key, image, type);
      try {
        await inTransaction(db, async (tx) => {
          await tx.gift.update({ where: { sessionId }, data: { photoKey: key } });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'gifts.photo',
            entityType: 'scan_session',
            entityId: sessionId,
            after: { bytes: image.length },
          });
        });
      } catch (error) {
        await s3.delete([key]).catch(() => undefined);
        throw error;
      }
      if (gift.photoKey) await s3.delete([gift.photoKey]).catch(() => undefined);
      return oneGift(sessionId);
    },

    async photoUrl(sessionId: string, ctx: ActorContext): Promise<string> {
      assertCanRead(ctx);
      const gift = await db.gift.findUnique({ where: { sessionId }, select: { photoKey: true } });
      if (!gift?.photoKey) throw new NotFoundError('gift_photo', sessionId);
      return store().signedUrl(gift.photoKey, LINK_SECONDS);
    },
  };
}

export type GiftsService = ReturnType<typeof createGiftsService>;

function toRecipient(r: {
  id: string;
  name: string;
  kind: string;
  phone: string | null;
}): RecipientView {
  return { id: r.id, name: r.name, kind: r.kind as RecipientKind, phone: r.phone };
}
