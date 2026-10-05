import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db } from '../../shared/db.js';
import { DomainError, NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import type { PhotoStorage } from '../../shared/storage.js';
import { parse } from '../../shared/validation.js';
import { moved } from './catalogue.service.js';

// Product photos (ADR-010). The browser shrinks a photo before sending it (a full image and a
// thumbnail); the server checks the bytes really are an image, stores both in S3, and records them.
// A photo is tagged with the option values it shows; each variant shows its best match.

/** Full image after the browser shrinks it to 1600 px: a few hundred KB; 3 MB is a hard stop. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_THUMB_BYTES = 300 * 1024;
/** How long a photo link handed to a browser stays valid, beyond the current hour. */
const LINK_SECONDS = 300;

const base64 = (maxBytes: number) =>
  z
    .string()
    .max(Math.ceil((maxBytes * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64');

export const uploadPhotoSchema = z.object({
  productId: z.uuid(),
  image: base64(MAX_IMAGE_BYTES),
  thumb: base64(MAX_THUMB_BYTES),
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
});

export const updatePhotoSchema = z
  .object({
    /** The option values the photo shows; [] = a general photo of the product. */
    valueIds: z
      .array(z.uuid())
      .max(30)
      .transform((ids) => [...new Set(ids)])
      .optional(),
    move: z.enum(['up', 'down', 'first']).optional(),
  })
  .refine((v) => v.valueIds !== undefined || v.move !== undefined, 'Nothing to change');

export type UploadPhotoInput = z.input<typeof uploadPhotoSchema>;
export type UpdatePhotoInput = z.input<typeof updatePhotoSchema>;

export interface PhotoView {
  id: string;
  width: number;
  height: number;
  sortOrder: number;
  /** The option values the photo shows. */
  valueIds: string[];
}

export class PhotosDisabledError extends DomainError {
  constructor() {
    super('PHOTOS_DISABLED', 'Photo storage is not configured on this server');
  }
}

export class InvalidImageError extends DomainError {
  constructor() {
    super('INVALID_IMAGE', 'Not a JPEG, WebP or PNG image');
  }
}

export class ImageTooLargeError extends DomainError {
  constructor(bytes: number, max: number) {
    super('IMAGE_TOO_LARGE', 'The image is too large', { bytes, max });
  }
}

export class InvalidPhotoTagsError extends DomainError {
  constructor(valueIds: string[]) {
    super('INVALID_PHOTO_TAGS', 'A photo can only show values of its product’s option types', {
      valueIds,
    });
  }
}

const EXTENSION = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' } as const;
type ImageType = keyof typeof EXTENSION;

/** The type from the file's first bytes — never from what the client claims. */
export function sniffImage(bytes: Buffer): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  return null;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const photoSelect = {
  id: true,
  width: true,
  height: true,
  sortOrder: true,
  values: { select: { valueId: true } },
} as const;

function toView(row: {
  id: string;
  width: number;
  height: number;
  sortOrder: number;
  values: { valueId: string }[];
}): PhotoView {
  return { ...row, valueIds: row.values.map((v) => v.valueId) };
}

export function createPhotoService(db: Db, storage: PhotoStorage | null) {
  const store = () => {
    if (!storage) throw new PhotosDisabledError();
    return storage;
  };

  return {
    /** Whether this server can store photos (S3 configured). The app hides uploads otherwise. */
    enabled: storage !== null,

    async listPhotos(productId: string, ctx: ActorContext): Promise<PhotoView[]> {
      assertPermission(ctx, PERMISSIONS.products.read);
      const rows = await db.productPhoto.findMany({
        where: { productId, deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: photoSelect,
      });
      return rows.map(toView);
    },

    async uploadPhoto(input: UploadPhotoInput, ctx: ActorContext): Promise<PhotoView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(uploadPhotoSchema, input);
      const s3 = store();

      const image = Buffer.from(data.image, 'base64');
      const thumb = Buffer.from(data.thumb, 'base64');
      const imageType = sniffImage(image);
      const thumbType = sniffImage(thumb);
      if (!imageType || !thumbType) throw new InvalidImageError();
      if (image.length > MAX_IMAGE_BYTES) {
        throw new ImageTooLargeError(image.length, MAX_IMAGE_BYTES);
      }
      if (thumb.length > MAX_THUMB_BYTES) {
        throw new ImageTooLargeError(thumb.length, MAX_THUMB_BYTES);
      }

      const product = await db.product.findFirst({
        where: { id: data.productId, deletedAt: null },
        select: { id: true },
      });
      if (!product) throw new NotFoundError('product', data.productId);

      // Keys are made here, from ids — never from anything the client sent.
      const id = randomUUID();
      const base = `products/${data.productId}/${id}`;
      const imageKey = `${base}.${EXTENSION[imageType]}`;
      const thumbKey = `${base}-thumb.${EXTENSION[thumbType]}`;
      // Files first, row second: a row never points at a missing file. If the row fails, the
      // files are removed again.
      await s3.put(imageKey, image, imageType);
      await s3.put(thumbKey, thumb, thumbType);

      try {
        return await inTransaction(db, async (tx) => {
          const last = await tx.productPhoto.aggregate({
            where: { productId: data.productId, deletedAt: null },
            _max: { sortOrder: true },
          });
          const row = await tx.productPhoto.create({
            data: {
              id,
              productId: data.productId,
              imageKey,
              thumbKey,
              contentType: imageType,
              byteSize: image.length,
              width: data.width,
              height: data.height,
              sortOrder: (last._max.sortOrder ?? 0) + 10,
              createdById: ctx.userId,
            },
            select: photoSelect,
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'products.photo.upload',
            entityType: 'product',
            entityId: data.productId,
            after: { photoId: id, bytes: image.length, width: data.width, height: data.height },
          });
          return toView(row);
        });
      } catch (error) {
        await s3.delete([imageKey, thumbKey]).catch(() => undefined);
        throw error;
      }
    },

    /** Tags (the option values shown) and order; `first` makes it the product's main photo. */
    async updatePhoto(id: string, input: UpdatePhotoInput, ctx: ActorContext): Promise<PhotoView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(updatePhotoSchema, input);

      return inTransaction(db, async (tx) => {
        const photo = await tx.productPhoto.findFirst({
          where: { id, deletedAt: null },
          select: { id: true, productId: true, values: { select: { valueId: true } } },
        });
        if (!photo) throw new NotFoundError('photo', id);

        if (data.valueIds) {
          const allowed = await tx.optionValue.findMany({
            where: {
              id: { in: data.valueIds },
              group: { products: { some: { productId: photo.productId } } },
            },
            select: { id: true },
          });
          const invalid = data.valueIds.filter((v) => !allowed.some((a) => a.id === v));
          if (invalid.length) throw new InvalidPhotoTagsError(invalid);
          await tx.productPhotoValue.deleteMany({ where: { photoId: id } });
          if (data.valueIds.length) {
            await tx.productPhotoValue.createMany({
              data: data.valueIds.map((valueId) => ({ photoId: id, valueId })),
            });
          }
        }

        if (data.move) {
          const siblings = await tx.productPhoto.findMany({
            where: { productId: photo.productId, deletedAt: null },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: { id: true },
          });
          const order =
            data.move === 'first'
              ? [id, ...siblings.map((s) => s.id).filter((s) => s !== id)]
              : moved(siblings, id, data.move);
          for (const [i, siblingId] of order.entries()) {
            await tx.productPhoto.update({
              where: { id: siblingId },
              data: { sortOrder: (i + 1) * 10 },
            });
          }
        }

        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'products.photo.update',
          entityType: 'product',
          entityId: photo.productId,
          before: { photoId: id, valueIds: photo.values.map((v) => v.valueId) },
          after: { photoId: id, ...data },
        });
        return toView(
          await tx.productPhoto.findUniqueOrThrow({ where: { id }, select: photoSelect }),
        );
      });
    },

    /** Removes the photo from the product and its files from S3. */
    async deletePhoto(id: string, ctx: ActorContext): Promise<{ ok: true }> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const s3 = store();
      const photo = await inTransaction(db, async (tx) => {
        const row = await tx.productPhoto.findFirst({ where: { id, deletedAt: null } });
        if (!row) throw new NotFoundError('photo', id);
        await tx.productPhoto.update({ where: { id }, data: { deletedAt: new Date() } });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'products.photo.delete',
          entityType: 'product',
          entityId: row.productId,
          before: { photoId: id, imageKey: row.imageKey },
        });
        return row;
      });
      // After the commit: if S3 fails here, the photo is already gone from the app; an orphaned
      // file costs a few hundred KB and can be swept later. The reverse would show a broken image.
      await s3.delete([photo.imageKey, photo.thumbKey]).catch(() => undefined);
      return { ok: true };
    },

    /** A short-lived link to the image, for the browser to load. */
    async photoUrl(id: string, size: 'full' | 'thumb', ctx: ActorContext): Promise<string> {
      assertPermission(ctx, PERMISSIONS.products.read);
      const s3 = store();
      const photo = await db.productPhoto.findFirst({
        where: { id, deletedAt: null },
        select: { imageKey: true, thumbKey: true },
      });
      if (!photo) throw new NotFoundError('photo', id);
      return s3.signedUrl(size === 'thumb' ? photo.thumbKey : photo.imageKey, LINK_SECONDS);
    },
  };
}

export type PhotoService = ReturnType<typeof createPhotoService>;
