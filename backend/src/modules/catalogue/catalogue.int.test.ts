import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isValidEan13 } from '../../shared/barcode.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { actorWith, createTestContext, pick, stock, type World } from '../../../test/helpers.js';

// ADR-011: category → product (one design) → variant (one size).

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

const whiteCotton = (...sizes: string[]) => [
  pick(w.options.fabric, 'قطني'),
  pick(w.options.colour, 'أبيض'),
  pick(w.options.size, ...sizes),
];

describe('categories make products by design, each with its sizes', () => {
  it('one product per design, one variant per size, with readable codes and valid barcodes', async () => {
    const category = await catalogue.createCategory(
      { code: 'thb-new', nameAr: 'ثوب جديد' },
      w.owner,
    );
    expect(category.code).toBe('THB-NEW');
    // No types given: every active type, in type order.
    expect(category.groupIds).toEqual([
      w.options.fabric.id,
      w.options.colour.id,
      w.options.size.id,
    ]);

    const first = await catalogue.generateProducts(
      {
        categoryId: category.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض', 'أسود'),
          pick(w.options.size, '54', '56'),
        ],
      },
      w.owner,
    );
    expect(first.products.map((p) => [p.code, p.title, p.variantCount])).toEqual([
      ['THB-NEW-QTN-ABY', 'قطني · أبيض', 2],
      ['THB-NEW-QTN-ASW', 'قطني · أسود', 2],
    ]);
    expect(first.created.map((v) => [v.sku, v.title, v.size])).toEqual([
      ['THB-NEW-QTN-ABY-54', 'قطني · أبيض · 54', '54'],
      ['THB-NEW-QTN-ABY-56', 'قطني · أبيض · 56', '56'],
      ['THB-NEW-QTN-ASW-54', 'قطني · أسود · 54', '54'],
      ['THB-NEW-QTN-ASW-56', 'قطني · أسود · 56', '56'],
    ]);
    for (const v of first.created) {
      expect(isValidEan13(v.barcode)).toBe(true);
      expect(v.product.nameAr).toBe('ثوب جديد');
    }
    expect(first.created[0]!.product.title).toBe('قطني · أبيض');

    // Again with an extra size: only the new size is added, to the same two products.
    const again = await catalogue.generateProducts(
      {
        categoryId: category.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض', 'أسود'),
          pick(w.options.size, '54', '56', '58'),
        ],
      },
      w.owner,
    );
    expect(again.created.map((v) => v.sku)).toEqual(['THB-NEW-QTN-ABY-58', 'THB-NEW-QTN-ASW-58']);
    expect(again.existing).toHaveLength(4);
    expect(again.products.map((p) => p.id)).toEqual(first.products.map((p) => p.id));
    const listed = await catalogue.listProducts({ categoryId: category.id }, w.owner);
    expect(listed.map((p) => p.variantCount)).toEqual([3, 3]);
  });

  it('a category without sizes: one variant per product, with the product’s code as its SKU', async () => {
    const category = await catalogue.createCategory(
      { code: 'SHL', nameAr: 'شال', groupIds: [w.options.colour.id] },
      w.owner,
    );
    const { created } = await catalogue.generateProducts(
      { categoryId: category.id, selections: [pick(w.options.colour, 'أبيض', 'أسود')] },
      w.owner,
    );
    expect(created.map((v) => [v.sku, v.size])).toEqual([
      ['SHL-ABY', null],
      ['SHL-ASW', null],
    ]);
  });

  it('handles any number of types; a new type and its order are data, not code', async () => {
    const cut = await addType('القصة', ['سعودية', 'خليجية']);
    const category = await catalogue.createCategory({ code: 'KLB', nameAr: 'كلابية' }, w.owner);
    expect(category.groupIds).toHaveLength(4);
    const { created } = await catalogue.generateProducts(
      {
        categoryId: category.id,
        selections: [
          { groupId: cut.id, valueIds: cut.values.map((v) => v.id) },
          pick(w.options.fabric, 'جوخ هندي'),
          pick(w.options.colour, 'أبيض'),
          pick(w.options.size, '56'),
        ],
      },
      w.owner,
    );
    // New types come last until moved.
    expect(created[0]!.title).toBe('جوخ هندي · أبيض · 56 · سعودية');
    for (let i = 0; i < 3; i++) await catalogue.updateOptionGroup(cut.id, { move: 'up' }, w.owner);
    const [first] = await catalogue.searchVariants({ categoryId: category.id }, w.owner);
    expect(first!.title).toBe('سعودية · جوخ هندي · أبيض · 56');
  });

  it('refuses a missing type, a value from another type, an inactive value, a heading, too many', async () => {
    const categoryId = w.category.id;
    const [fabric, colour, size] = whiteCotton('56');
    const fails = async (selections: { groupId: string; valueIds: string[] }[]) =>
      expect(catalogue.generateProducts({ categoryId, selections }, w.owner)).rejects.toMatchObject(
        { code: 'INVALID_SELECTION' },
      );

    await fails([fabric!, colour!]);
    await fails([fabric!, { ...colour!, valueIds: size!.valueIds }, size!]);
    await catalogue.updateOptionValue(colour!.valueIds[0]!, { isActive: false }, w.owner);
    await fails([fabric!, colour!, size!]);
    // Hidden from new products only: existing ones still resolve and show it.
    expect((await catalogue.getVariant(w.x.id, w.owner)).title).toBe('قطني · أبيض · 54');

    const jokh = w.options.fabric.values.find((v) => v.valueAr === 'جوخ هندي')!;
    await catalogue.addOptionValue(
      { groupId: w.options.fabric.id, parentId: jokh.id, valueAr: 'مشخط' },
      w.owner,
    );
    await fails([
      { groupId: w.options.fabric.id, valueIds: [jokh.id] },
      pick(w.options.colour, 'أسود'),
      size!,
    ]);

    // 1 fabric × 16 colours × 34 sizes = 544 > 500.
    const many = async (groupId: string, prefix: string, count: number) => {
      await t.db.optionValue.createMany({
        data: Array.from({ length: count }, (_, i) => ({
          groupId,
          valueAr: `${prefix}${i}`,
          code: `${prefix}${i}`,
          sortOrder: 1000 + i,
        })),
      });
      return (
        await t.db.optionValue.findMany({ where: { groupId, valueAr: { startsWith: prefix } } })
      ).map((v) => v.id);
    };
    const colours = await many(w.options.colour.id, 'C', 16);
    const sizes = await many(w.options.size.id, 'S', 30);
    await expect(
      catalogue.generateProducts(
        {
          categoryId,
          selections: [
            pick(w.options.fabric, 'قطني'),
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

  it('two people generating the same products at once create each once', async () => {
    const input = {
      categoryId: w.category.id,
      selections: [
        pick(w.options.fabric, 'جوخ هندي'),
        pick(w.options.colour, 'أبيض', 'أسود'),
        pick(w.options.size, '54', '56'),
      ],
    };
    await Promise.all([
      catalogue.generateProducts(input, w.owner),
      catalogue.generateProducts(input, w.approver),
    ]);
    const products = await catalogue.listProducts({ categoryId: w.category.id }, w.owner);
    expect(products.map((p) => p.variantCount).sort()).toEqual([2, 2, 3]);
  });
});

describe('categories are a tree, and editable', () => {
  it('nests three levels at most, never into itself; a sub-category starts with its parent’s types', async () => {
    const summer = await catalogue.createCategory(
      { nameAr: 'صيفي', parentId: w.category.id },
      w.owner,
    );
    expect(summer.groupIds).toEqual(w.category.groupIds);
    expect(summer.code).toMatch(/^[A-Z0-9]+$/);
    const light = await catalogue.createCategory({ nameAr: 'خفيف', parentId: summer.id }, w.owner);
    await expect(
      catalogue.createCategory({ nameAr: 'رابع', parentId: light.id }, w.owner),
    ).rejects.toMatchObject({ code: 'CATEGORY_TOO_DEEP' });
    await expect(
      catalogue.updateCategory(w.category.id, { parentId: light.id }, w.owner),
    ).rejects.toMatchObject({ code: 'CATEGORY_TOO_DEEP' });

    // Moved to the top level, renamed and recoded.
    const moved = await catalogue.updateCategory(
      light.id,
      { parentId: null, nameAr: 'خفيف جداً', code: 'LT' },
      w.owner,
    );
    expect([moved.parentId, moved.nameAr, moved.code]).toEqual([null, 'خفيف جداً', 'LT']);
    await expect(
      catalogue.updateCategory(summer.id, { code: 'LT' }, w.owner),
    ).rejects.toMatchObject({ code: 'CATEGORY_CODE_TAKEN' });
    await expect(
      catalogue.createCategory({ nameAr: 'مكرر', code: 'THB-TEST' }, w.owner),
    ).rejects.toMatchObject({ code: 'CATEGORY_CODE_TAKEN' });
  });

  it('changes types only while no product uses a removed one; a stopped category stops its sizes', async () => {
    const all = [w.options.fabric.id, w.options.colour.id, w.options.size.id];
    await expect(
      catalogue.updateCategory(w.category.id, { groupIds: [w.options.fabric.id] }, w.owner),
    ).rejects.toMatchObject({ code: 'OPTION_GROUP_IN_USE' });

    const sleeve = await addType('الكم', ['سنارة']);
    const updated = await catalogue.updateCategory(
      w.category.id,
      { nameAr: 'ثوب معدل', groupIds: [...all, sleeve.id] },
      w.owner,
    );
    expect(updated.groupIds).toEqual([...all, sleeve.id]);
    // The new type is now required for new products.
    await expect(
      catalogue.generateProducts(
        { categoryId: w.category.id, selections: whiteCotton('60') },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    expect((await catalogue.getVariant(w.x.id, w.owner)).product.nameAr).toBe('ثوب معدل');

    await catalogue.updateCategory(w.category.id, { isActive: false }, w.owner);
    await expect(stock(t.services, w, w.x, w.wh1, 1)).rejects.toMatchObject({
      code: 'VARIANT_INACTIVE',
    });
    await expect(
      catalogue.generateProducts(
        {
          categoryId: w.category.id,
          selections: [
            ...whiteCotton('60'),
            { groupId: sleeve.id, valueIds: [sleeve.values[0]!.id] },
          ],
        },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'CATEGORY_INACTIVE' });
  });
});

describe('stopping and deleting', () => {
  it('a stopped size cannot receive stock, keeps its barcode, and is restarted, not recreated', async () => {
    await catalogue.setVariantActive(w.x.id, { isActive: false }, w.owner);
    await expect(stock(t.services, w, w.x, w.wh1, 1)).rejects.toMatchObject({
      code: 'VARIANT_INACTIVE',
    });
    const again = await catalogue.generateProducts(
      { categoryId: w.category.id, selections: whiteCotton('54') },
      w.owner,
    );
    expect(again.created).toHaveLength(0);
    await catalogue.setVariantActive(w.x.id, { isActive: true }, w.owner);
    await stock(t.services, w, w.x, w.wh1, 1);

    await catalogue.setProductActive(w.x.product.id, { isActive: false }, w.owner);
    await expect(stock(t.services, w, w.y, w.wh1, 1)).rejects.toMatchObject({
      code: 'VARIANT_INACTIVE',
    });
  });

  it('deletes what never had stock; generating it again restores the same barcode', async () => {
    await catalogue.deleteVariant(w.z.id, w.owner);
    expect(await catalogue.searchVariants({ productId: w.x.product.id }, w.owner)).toHaveLength(2);
    const { created } = await catalogue.generateProducts(
      { categoryId: w.category.id, selections: whiteCotton('58') },
      w.owner,
    );
    expect(created.map((v) => v.barcode)).toEqual([w.z.barcode]);

    await catalogue.deleteProduct(w.x.product.id, w.owner);
    expect(await catalogue.listProducts({ categoryId: w.category.id }, w.owner)).toEqual([]);
    await expect(t.services.inventory.resolveBarcode(w.x.barcode, w.owner)).rejects.toMatchObject({
      code: 'BARCODE_NOT_FOUND',
    });
  });

  it('never deletes what had stock, nor a category with sub-categories', async () => {
    await stock(t.services, w, w.x, w.wh1, 2);
    const hasStock = { code: 'HAS_STOCK' };
    await expect(catalogue.deleteVariant(w.x.id, w.owner)).rejects.toMatchObject(hasStock);
    await expect(catalogue.deleteProduct(w.x.product.id, w.owner)).rejects.toMatchObject(hasStock);
    await expect(catalogue.deleteCategory(w.category.id, w.owner)).rejects.toMatchObject(hasStock);

    const parent = await catalogue.createCategory({ nameAr: 'أب', code: 'PAR' }, w.owner);
    const child = await catalogue.createCategory(
      { nameAr: 'ابن', code: 'CHI', parentId: parent.id },
      w.owner,
    );
    await expect(catalogue.deleteCategory(parent.id, w.owner)).rejects.toMatchObject({
      code: 'CATEGORY_HAS_CHILDREN',
    });
    await catalogue.deleteCategory(child.id, w.owner);
    await catalogue.deleteCategory(parent.id, w.owner);
    expect((await catalogue.listCategories(w.owner)).map((c) => c.code)).toEqual(['THB-TEST']);
  });
});

describe('editing option lists', () => {
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

  it('suggests a code for a new value, refuses a taken one, and keeps codes unique', async () => {
    const navy = await catalogue.addOptionValue(
      { groupId: w.options.colour.id, valueAr: 'كحلي' },
      w.owner,
    );
    expect(navy.code).toBe('KHL');
    await expect(
      catalogue.addOptionValue(
        { groupId: w.options.colour.id, valueAr: 'كحلي غامق', code: 'khl' },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'OPTION_CODE_TAKEN' });

    // A renamed category code is used for new products; existing SKUs stay as printed.
    await catalogue.updateCategory(w.category.id, { code: 'THB' }, w.owner);
    const { created } = await catalogue.generateProducts(
      {
        categoryId: w.category.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          { groupId: w.options.colour.id, valueIds: [navy.id] },
          pick(w.options.size, '56'),
        ],
      },
      w.owner,
    );
    expect(created[0]!.sku).toBe('THB-QTN-KHL-56');
    expect((await catalogue.getVariant(w.x.id, w.owner)).sku).toBe(w.x.sku);

    // A code renamed and then reused would repeat a code: the new product gets -2.
    await catalogue.updateOptionValue(navy.id, { code: 'NV' }, w.owner);
    const indigo = await catalogue.addOptionValue(
      { groupId: w.options.colour.id, valueAr: 'نيلي', code: 'KHL' },
      w.owner,
    );
    const again = await catalogue.generateProducts(
      {
        categoryId: w.category.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          { groupId: w.options.colour.id, valueIds: [indigo.id] },
          pick(w.options.size, '56'),
        ],
      },
      w.owner,
    );
    expect(again.products[0]!.code).toBe('THB-QTN-KHL-2');
    expect(again.created[0]!.sku).toBe('THB-QTN-KHL-2-56');
  });

  it('values can have details: a product picks a detail, and reads and codes the whole path', async () => {
    const jokh = w.options.fabric.values.find((v) => v.valueAr === 'جوخ هندي')!;
    const cotton = w.options.fabric.values.find((v) => v.valueAr === 'قطني')!;
    const detail = async (parentId: string, valueAr: string) =>
      catalogue.addOptionValue({ groupId: w.options.fabric.id, parentId, valueAr }, w.owner);
    await detail(jokh.id, 'مونس');
    const striped = await detail(jokh.id, 'مشخط');
    await detail(jokh.id, 'ساده');
    await detail(cotton.id, 'ساده');
    await expect(detail(jokh.id, 'ساده')).rejects.toMatchObject({ code: 'OPTION_VALUE_TAKEN' });

    const { created } = await catalogue.generateProducts(
      {
        categoryId: w.category.id,
        selections: [
          { groupId: w.options.fabric.id, valueIds: [striped.id] },
          pick(w.options.colour, 'أبيض'),
          pick(w.options.size, '54'),
        ],
      },
      w.owner,
    );
    expect(created[0]!.title).toBe('جوخ هندي مشخط · أبيض · 54');
    expect(created[0]!.sku).toBe(`THB-TEST-JH${striped.code}-ABY-54`);
    expect(await catalogue.searchVariants({ q: 'جوخ' }, w.owner)).toHaveLength(1);

    const fine = await detail(striped.id, 'رفيع');
    await expect(detail(fine.id, 'جداً')).rejects.toMatchObject({ code: 'OPTION_VALUE_TOO_DEEP' });
  });
});

describe('permissions', () => {
  it('only products.write changes categories, products, sizes, types or values; products.read sees', async () => {
    const staff = actorWith(w.owner, [PERMISSIONS.products.read]);
    const denied = { code: 'PERMISSION_DENIED' };
    const valueId = w.options.colour.values[0]!.id;

    expect(await catalogue.listOptionGroups(staff)).toHaveLength(3);
    expect(await catalogue.listCategories(staff)).toHaveLength(1);
    expect(await catalogue.listProducts({}, staff)).toHaveLength(1);
    const attempts = [
      async () => catalogue.createCategory({ nameAr: 'ممنوع' }, staff),
      async () => catalogue.updateCategory(w.category.id, { nameAr: 'x' }, staff),
      async () => catalogue.deleteCategory(w.category.id, staff),
      async () =>
        catalogue.generateProducts(
          { categoryId: w.category.id, selections: whiteCotton('60') },
          staff,
        ),
      async () => catalogue.setProductActive(w.x.product.id, { isActive: false }, staff),
      async () => catalogue.deleteProduct(w.x.product.id, staff),
      async () => catalogue.setVariantActive(w.x.id, { isActive: false }, staff),
      async () => catalogue.deleteVariant(w.x.id, staff),
      async () => catalogue.createOptionGroup({ nameAr: 'الياقة' }, staff),
      async () =>
        catalogue.addOptionValue({ groupId: w.options.colour.id, valueAr: 'رمادي' }, staff),
      async () => catalogue.updateOptionValue(valueId, { isActive: false }, staff),
    ];
    for (const attempt of attempts) await expect(attempt()).rejects.toMatchObject(denied);
  });
});

describe('codes and barcodes', () => {
  it('refuses units other than PIECE', async () => {
    await expect(
      catalogue.createCategory(
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
