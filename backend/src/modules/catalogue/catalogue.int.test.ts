import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidEan13 } from '../../shared/barcode.js';
import { createTestContext, type World } from '../../../test/helpers.js';

const t = createTestContext();
const catalogue = t.services.catalogue;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

describe('catalogue', () => {
  it('generates the fabric × colour × size matrix with valid, unique barcodes and ASCII SKUs', async () => {
    const product = await catalogue.createProduct({ code: 'thb-new', nameAr: 'ثوب جديد' }, w.owner);
    expect(product.code).toBe('THB-NEW');

    const { created } = await catalogue.generateVariants(
      {
        productId: product.id,
        fabrics: ['قطني'],
        colours: ['أبيض', 'أسود'],
        sizes: ['54', '56', '58'],
      },
      w.owner,
    );
    expect(created).toHaveLength(6);
    expect(new Set(created.map((v) => v.barcode)).size).toBe(6);
    for (const v of created) {
      expect(isValidEan13(v.barcode)).toBe(true);
      expect(v.barcode.startsWith('200')).toBe(true);
      expect(v.sku).toMatch(/^THB-NEW-\d{6,}$/);
    }

    // Running again with one extra size adds only what is missing.
    const again = await catalogue.generateVariants(
      {
        productId: product.id,
        fabrics: ['قطني'],
        colours: ['أبيض', 'أسود'],
        sizes: ['54', '56', '58', '60'],
      },
      w.owner,
    );
    expect(again.created.map((v) => v.size)).toEqual(['60', '60']);
    expect(again.existing).toHaveLength(6);
  });

  it('refuses a duplicate product code and units other than PIECE', async () => {
    await expect(
      catalogue.createProduct({ code: 'THB-TEST', nameAr: 'مكرر' }, w.owner),
    ).rejects.toMatchObject({
      code: 'PRODUCT_CODE_TAKEN',
    });
    await expect(
      catalogue.createProduct(
        { code: 'FABRIC-ROLL', nameAr: 'قماش', unitOfMeasure: 'METER' as 'PIECE' },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('resolves internal barcodes, registered supplier barcodes, and SKUs', async () => {
    const byBarcode = await t.services.inventory.resolveBarcode(w.x.barcode, w.owner);
    expect(byBarcode.id).toBe(w.x.id);
    expect(byBarcode.product.nameAr).toBe('ثوب تجريبي');

    await catalogue.registerExternalBarcode(
      { variantId: w.y.id, barcode: '4006381333931', kind: 'GTIN' },
      w.owner,
    );
    expect((await t.services.inventory.resolveBarcode('4006381333931', w.owner)).id).toBe(w.y.id);

    expect((await t.services.inventory.resolveBarcode(w.z.sku, w.owner)).id).toBe(w.z.id);
  });

  it('refuses an invalid GTIN, and an external code equal to an internal one', async () => {
    await expect(
      catalogue.registerExternalBarcode(
        { variantId: w.y.id, barcode: '4006381333932', kind: 'GTIN' },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_BARCODE' });
    await expect(
      catalogue.registerExternalBarcode(
        { variantId: w.y.id, barcode: w.x.barcode, kind: 'GTIN' },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'BARCODE_TAKEN' });
  });
});
