import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createServices } from '../../services.js';
import { permissionsFor } from '../auth/roles.js';
import { createTestContext, type World } from '../../../test/helpers.js';
import { MAX_IMAGE_BYTES } from './photo.service.js';

// Product photos (ADR-010) against S3 stand-in storage in memory.

const t = createTestContext();
const photos = t.services.photos;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4),
  Buffer.from('WEBP'),
  Buffer.alloc(100, 2),
]);
const b64 = (bytes: Buffer) => bytes.toString('base64');
const as = (role: string) => ({ userId: w.owner.userId, permissions: permissionsFor([role]) });

async function upload(image = JPEG, thumb = WEBP) {
  return photos.uploadPhoto(
    { productId: w.x.product.id, image: b64(image), thumb: b64(thumb), width: 1200, height: 1600 },
    w.owner,
  );
}

describe('product photos', () => {
  it('stores the image and thumbnail under server-made keys, and lists them in order', async () => {
    const first = await upload();
    const second = await upload();

    const keys = [...t.storage.objects.keys()].sort();
    expect(keys).toHaveLength(4);
    expect(keys[0]).toMatch(
      new RegExp(`^products/${w.x.product.id}/[0-9a-f-]{36}(-thumb)?\\.(jpg|webp)$`),
    );
    expect((await photos.listPhotos(w.x.product.id, w.owner)).map((p) => p.id)).toEqual([
      first.id,
      second.id,
    ]);
    // The product's main photo is the first one; make the second the main photo.
    expect(
      (await t.services.catalogue.listProducts({}, w.owner)).find((p) => p.id === w.x.product.id)!
        .mainPhotoId,
    ).toBe(first.id);
    await photos.updatePhoto(second.id, { move: 'first' }, w.owner);
    expect(
      (await t.services.catalogue.listProducts({}, w.owner)).find((p) => p.id === w.x.product.id)!
        .mainPhotoId,
    ).toBe(second.id);

    expect(await photos.photoUrl(first.id, 'thumb', w.owner)).toMatch(
      /^memory:\/\/.*-thumb\.webp$/,
    );
  });

  it('every size of a product shows the product’s main photo', async () => {
    const byId = async (id: string) => (await t.services.catalogue.getVariant(id, w.owner)).photoId;
    expect(await byId(w.x.id)).toBeNull();
    const photo = await upload();
    for (const v of [w.x, w.y, w.z]) expect(await byId(v.id)).toBe(photo.id);
    // The scan screen gets it with the variant.
    expect((await t.services.inventory.resolveBarcode(w.y.barcode, w.owner)).photoId).toBe(
      photo.id,
    );
  });

  it('refuses what is not an image, and what is too large', async () => {
    await expect(upload(Buffer.from('<svg onload=alert(1)>'))).rejects.toMatchObject({
      code: 'INVALID_IMAGE',
    });
    await expect(upload(JPEG, Buffer.from('not an image at all'))).rejects.toMatchObject({
      code: 'INVALID_IMAGE',
    });
    const huge = Buffer.concat([JPEG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    await expect(upload(huge)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect(t.storage.objects.size).toBe(0);
  });

  it('deleting removes the files from storage and the photo from every view', async () => {
    const photo = await upload();
    expect(t.storage.objects.size).toBe(2);
    await photos.deletePhoto(photo.id, w.owner);
    expect(t.storage.objects.size).toBe(0);
    expect(await photos.listPhotos(w.x.product.id, w.owner)).toEqual([]);
    await expect(photos.photoUrl(photo.id, 'full', w.owner)).rejects.toMatchObject({
      code: 'PHOTO_NOT_FOUND',
    });
  });

  it('staff without products.write see photos but cannot add, change or delete them', async () => {
    const photo = await upload();
    const staff = as('store_staff');
    expect(await photos.listPhotos(w.x.product.id, staff)).toHaveLength(1);
    await photos.photoUrl(photo.id, 'thumb', staff);
    const denied = { code: 'PERMISSION_DENIED' };
    await expect(
      photos.uploadPhoto(
        { productId: w.x.product.id, image: b64(JPEG), thumb: b64(WEBP), width: 1, height: 1 },
        staff,
      ),
    ).rejects.toMatchObject(denied);
    await expect(photos.updatePhoto(photo.id, { move: 'first' }, staff)).rejects.toMatchObject(
      denied,
    );
    await expect(photos.deletePhoto(photo.id, staff)).rejects.toMatchObject(denied);
  });

  it('a server without S3 says so instead of failing obscurely', async () => {
    const without = createServices(t.db).photos;
    expect(without.enabled).toBe(false);
    await expect(
      without.uploadPhoto(
        { productId: w.x.product.id, image: b64(JPEG), thumb: b64(WEBP), width: 1, height: 1 },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'PHOTOS_DISABLED' });
  });
});
