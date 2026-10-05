import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidEan13 } from '../../shared/barcode.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { actorWith, createTestContext, pick, stock, type World } from '../../../test/helpers.js';

const t = createTestContext();
const catalogue = t.services.catalogue;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

/** Adds an option type with values through the service, as the Options page does. */
async function addType(nameAr: string, values: string[]) {
  const group = await catalogue.createOptionGroup({ nameAr }, w.owner);
  const created = [];
  for (const valueAr of values) {
    created.push(await catalogue.addOptionValue({ groupId: group.id, valueAr }, w.owner));
  }
  return { id: group.id, values: created };
}

describe('catalogue — variants from option types', () => {
  it('generates every chosen combination with valid, unique barcodes and ASCII SKUs', async () => {
    const product = await catalogue.createProduct({ code: 'thb-new', nameAr: 'ثوب جديد' }, w.owner);
    expect(product.code).toBe('THB-NEW');
    // No types given: every active type, in type order.
    expect(product.groupIds).toEqual([w.options.fabric.id, w.options.colour.id, w.options.size.id]);

    const { created } = await catalogue.generateVariants(
      {
        productId: product.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض', 'أسود'),
          pick(w.options.size, '54', '56', '58'),
        ],
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
    // Listed in option order; each variant reads in type order.
    expect(created.map((v) => v.title)).toEqual([
      'قطني · أبيض · 54',
      'قطني · أبيض · 56',
      'قطني · أبيض · 58',
      'قطني · أسود · 54',
      'قطني · أسود · 56',
      'قطني · أسود · 58',
    ]);
    expect(created[0]!.size).toBe('54');
    expect(created[0]!.options.map((o) => o.group)).toEqual(['القماش', 'اللون', 'القياس']);

    // Running again with one extra size adds only what is missing.
    const again = await catalogue.generateVariants(
      {
        productId: product.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض', 'أسود'),
          pick(w.options.size, '54', '56', '58', '60'),
        ],
      },
      w.owner,
    );
    expect(again.created.map((v) => v.size)).toEqual(['60', '60']);
    expect(again.existing).toHaveLength(6);
  });

  it('handles any number of types; a new type and its order are data, not code', async () => {
    const cut = await addType('القصة', ['سعودية', 'خليجية']);
    const button = await addType('الزر', ['ملكي', 'معدن', 'بلاستيك']);
    const product = await catalogue.createProduct({ code: 'KLB', nameAr: 'كلابية' }, w.owner);
    expect(product.groupIds).toHaveLength(5);

    const { created } = await catalogue.generateVariants(
      {
        productId: product.id,
        selections: [
          { groupId: cut.id, valueIds: cut.values.map((v) => v.id) },
          { groupId: button.id, valueIds: [button.values[0]!.id] },
          pick(w.options.fabric, 'جوخ هندي'),
          pick(w.options.colour, 'أبيض'),
          pick(w.options.size, '56', '58'),
        ],
      },
      w.owner,
    );
    expect(created).toHaveLength(4);
    // New types come last until moved.
    expect(created[0]!.title).toBe('جوخ هندي · أبيض · 56 · سعودية · ملكي');

    // Move القصة and الزر to the front: every variant now reads cut first.
    for (let i = 0; i < 3; i++) {
      await catalogue.updateOptionGroup(cut.id, { move: 'up' }, w.owner);
    }
    for (let i = 0; i < 4; i++) {
      await catalogue.updateOptionGroup(button.id, { move: 'up' }, w.owner);
    }
    await catalogue.updateOptionGroup(cut.id, { move: 'up' }, w.owner);
    const [first] = await catalogue.searchVariants({ productId: product.id }, w.owner);
    expect(first!.title).toBe('سعودية · ملكي · جوخ هندي · أبيض · 56');
    const groups = await catalogue.listOptionGroups(w.owner);
    expect(groups.map((g) => g.nameAr)).toEqual(['القصة', 'الزر', 'القماش', 'اللون', 'القياس']);
  });

  it('refuses a missing type, a value from another type, an inactive value, and too many combinations', async () => {
    const productId = (await catalogue.createProduct({ code: 'P1', nameAr: 'منتج' }, w.owner)).id;
    const fabric = pick(w.options.fabric, 'قطني');
    const colour = pick(w.options.colour, 'أبيض');
    const size = pick(w.options.size, '56');

    await expect(
      catalogue.generateVariants({ productId, selections: [fabric, colour] }, w.owner),
    ).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    await expect(
      catalogue.generateVariants(
        { productId, selections: [fabric, { ...colour, valueIds: size.valueIds }, size] },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SELECTION' });

    await catalogue.updateOptionValue(colour.valueIds[0]!, { isActive: false }, w.owner);
    await expect(
      catalogue.generateVariants({ productId, selections: [fabric, colour, size] }, w.owner),
    ).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    // Hidden from new variants only: the existing ones still resolve and show it.
    expect((await catalogue.getVariant(w.x.id, w.owner)).title).toBe('قطني · أبيض · 54');

    // 2 fabrics × 8 colours × 34 sizes = 544 > 500.
    const many = async (groupId: string, prefix: string, count: number) => {
      await t.db.optionValue.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          groupId,
          valueAr: `${prefix}${i}`,
          sortOrder: 1000 + i,
        })),
      });
      return (
        await t.db.optionValue.findMany({ where: { groupId, valueAr: { startsWith: prefix } } })
      ).map((v) => v.id);
    };
    const colours = await many(w.options.colour.id, 'C', 8);
    const sizes = await many(w.options.size.id, 'S', 30);
    await expect(
      catalogue.generateVariants(
        {
          productId,
          selections: [
            pick(w.options.fabric, 'قطني', 'جوخ هندي'),
            { groupId: w.options.colour.id, valueIds: colours },
            {
              groupId: w.options.size.id,
              valueIds: [...sizes, ...pick(w.options.size, '54', '56', '58', '60').valueIds],
            },
          ],
        },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_COMBINATIONS' });
  });

  it('two people generating the same combinations at once create each variant once', async () => {
    const productId = (await catalogue.createProduct({ code: 'P2', nameAr: 'منتج' }, w.owner)).id;
    const input = {
      productId,
      selections: [
        pick(w.options.fabric, 'قطني'),
        pick(w.options.colour, 'أبيض', 'أسود'),
        pick(w.options.size, '54', '56'),
      ],
    };
    await Promise.all([
      catalogue.generateVariants(input, w.owner),
      catalogue.generateVariants(input, w.approver),
    ]);
    expect(await catalogue.searchVariants({ productId }, w.owner)).toHaveLength(4);
  });
});

describe('catalogue — editing lists, products and variants', () => {
  it('renames a value everywhere; duplicates are refused, spacing ignored', async () => {
    const white = w.options.colour.values.find((v) => v.valueAr === 'أبيض')!;
    await catalogue.updateOptionValue(white.id, { valueAr: 'أبيض ثلجي' }, w.owner);
    expect((await catalogue.getVariant(w.x.id, w.owner)).title).toBe('قطني · أبيض ثلجي · 54');
    expect(
      (await catalogue.searchVariants({ q: 'ثلجي' }, w.owner)).map((v) => v.id).sort(),
    ).toEqual([w.x.id, w.y.id, w.z.id].sort());

    await expect(
      catalogue.addOptionValue({ groupId: w.options.fabric.id, valueAr: '  جوخ   هندي ' }, w.owner),
    ).rejects.toMatchObject({ code: 'OPTION_VALUE_TAKEN' });
    await expect(catalogue.createOptionGroup({ nameAr: 'اللون' }, w.owner)).rejects.toMatchObject({
      code: 'OPTION_GROUP_TAKEN',
    });
  });

  it('changes a product’s types only while no variant uses a removed type', async () => {
    const productId = w.x.product.id;
    const all = [w.options.fabric.id, w.options.colour.id, w.options.size.id];
    await expect(
      catalogue.updateProduct(productId, { groupIds: [w.options.fabric.id] }, w.owner),
    ).rejects.toMatchObject({ code: 'OPTION_GROUP_IN_USE' });

    const sleeve = await addType('الكم', ['سنارة']);
    const updated = await catalogue.updateProduct(
      productId,
      { nameAr: 'ثوب معدل', groupIds: [...all, sleeve.id] },
      w.owner,
    );
    expect(updated.nameAr).toBe('ثوب معدل');
    expect(updated.groupIds).toEqual([...all, sleeve.id]);
    // The new type is now required for new variants.
    await expect(
      catalogue.generateVariants(
        {
          productId,
          selections: [
            pick(w.options.fabric, 'قطني'),
            pick(w.options.colour, 'أسود'),
            pick(w.options.size, '54'),
          ],
        },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SELECTION' });

    await catalogue.updateProduct(productId, { isActive: false }, w.owner);
    await expect(stock(t.services, w, w.x, w.wh1, 1)).rejects.toMatchObject({
      code: 'VARIANT_INACTIVE',
    });
  });

  it('a retired variant cannot receive stock, keeps its barcode, and is restored, not recreated', async () => {
    await catalogue.setVariantActive(w.x.id, { isActive: false }, w.owner);
    await expect(stock(t.services, w, w.x, w.wh1, 1)).rejects.toMatchObject({
      code: 'VARIANT_INACTIVE',
    });

    const again = await catalogue.generateVariants(
      {
        productId: w.x.product.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض'),
          pick(w.options.size, '54'),
        ],
      },
      w.owner,
    );
    expect(again.created).toHaveLength(0);

    await catalogue.setVariantActive(w.x.id, { isActive: true }, w.owner);
    await stock(t.services, w, w.x, w.wh1, 1);
  });

  it('only products.write may change products, types or values; anyone with products.read may list', async () => {
    const staff = actorWith(w.owner, [PERMISSIONS.products.read]);
    const denied = { code: 'PERMISSION_DENIED' };
    const valueId = w.options.colour.values[0]!.id;

    expect(await catalogue.listOptionGroups(staff)).toHaveLength(3);
    await expect(catalogue.createOptionGroup({ nameAr: 'الياقة' }, staff)).rejects.toMatchObject(
      denied,
    );
    await expect(
      catalogue.updateOptionGroup(w.options.colour.id, { nameAr: 'x' }, staff),
    ).rejects.toMatchObject(denied);
    await expect(
      catalogue.addOptionValue({ groupId: w.options.colour.id, valueAr: 'رمادي' }, staff),
    ).rejects.toMatchObject(denied);
    await expect(
      catalogue.updateOptionValue(valueId, { isActive: false }, staff),
    ).rejects.toMatchObject(denied);
    await expect(
      catalogue.updateProduct(w.x.product.id, { nameAr: 'x' }, staff),
    ).rejects.toMatchObject(denied);
    await expect(
      catalogue.setVariantActive(w.x.id, { isActive: false }, staff),
    ).rejects.toMatchObject(denied);
  });
});

describe('catalogue — codes and barcodes', () => {
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
