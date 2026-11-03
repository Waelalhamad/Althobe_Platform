import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../shared/permissions.js';
import { actorWith, createTestContext, pick, stock, type World } from '../../../test/helpers.js';

// One option type of a category becomes its sub-categories (طقم عربي → سفاري، رسمي…).

const t = createTestContext();
const catalogue = t.services.catalogue;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

/** The world's category already has قطني · أبيض; this adds جوخ هندي · أبيض and قطني · أسود. */
async function threeDesigns() {
  for (const [fabric, colour] of [
    ['جوخ هندي', 'أبيض'],
    ['قطني', 'أسود'],
  ] as const) {
    await catalogue.generateProducts(
      {
        categoryId: w.category.id,
        selections: [
          pick(w.options.fabric, fabric),
          pick(w.options.colour, colour),
          pick(w.options.size, '56'),
        ],
      },
      w.owner,
    );
  }
}

describe('splitting a category by an option type', () => {
  it('previews without changing anything', async () => {
    await threeDesigns();
    await stock(t.services, w, w.x, w.wh1, 3);
    const preview = await catalogue.splitCategory(
      w.category.id,
      { groupId: w.options.fabric.id, dryRun: true },
      w.owner,
    );
    expect(preview).toMatchObject({ dryRun: true, group: 'القماش', staying: 0 });
    expect(preview.parts.map((p) => [p.nameAr, p.products, p.pieces, p.categoryId])).toEqual([
      ['قطني', 2, 3, null],
      ['جوخ هندي', 1, 0, null],
    ]);
    const categories = await catalogue.listCategories(w.owner);
    expect(categories).toHaveLength(1);
    expect(categories[0]!.groupIds).toContain(w.options.fabric.id);
  });

  it('moves each product into its sub-category, keeping barcode, SKU, stock and prices', async () => {
    await threeDesigns();
    await stock(t.services, w, w.x, w.wh1, 3);
    await catalogue.setProductPrices({ productIds: [w.x.product.id], wholesale: '2500' }, w.owner);

    const done = await catalogue.splitCategory(
      w.category.id,
      { groupId: w.options.fabric.id },
      w.owner,
    );
    expect(done.parts.every((p) => p.categoryId && !p.existing)).toBe(true);

    const categories = await catalogue.listCategories(w.owner);
    const parent = categories.find((c) => c.id === w.category.id)!;
    const cotton = categories.find((c) => c.nameAr === 'قطني')!;
    expect(cotton.parentId).toBe(parent.id);
    // Its code is the category's plus the value's, as in the SKUs: THB-TEST-QTN.
    expect(cotton.code).toBe(`THB-TEST-${w.x.sku.split('-')[2]}`);
    // The type left the parent; the sub-category has the others.
    expect(parent.groupIds).not.toContain(w.options.fabric.id);
    expect(cotton.groupIds).toEqual([w.options.colour.id, w.options.size.id]);
    expect(parent.productCount).toBe(0);
    expect(cotton.productCount).toBe(2);

    const moved = await catalogue.getVariant(w.x.id, w.owner);
    expect(moved.barcode).toBe(w.x.barcode);
    expect(moved.sku).toBe(w.x.sku);
    expect(moved.product.categoryId).toBe(cotton.id);
    expect(moved.product.nameAr).toBe(`${w.category.nameAr} قطني`);
    expect(moved.title).toBe('أبيض · 54');
    expect(moved.prices.wholesale).toMatchObject({ amount: 2500n });
    const [balance] = await t.services.inventory.listBalances({ locationId: w.wh1.id }, w.owner);
    expect(balance).toMatchObject({ variant: { id: w.x.id }, balance: { quantity: 3 } });

    // Found by its parent's name too.
    const found = await catalogue.searchVariants({ q: w.category.nameAr }, w.owner);
    expect(found.map((v) => v.id)).toContain(w.x.id);

    // New sizes for a moved design come out in the sub-category, as the same product.
    const more = await catalogue.generateProducts(
      {
        categoryId: cotton.id,
        selections: [pick(w.options.colour, 'أبيض'), pick(w.options.size, '60')],
      },
      w.owner,
    );
    expect(more.products[0]!.id).toBe(w.x.product.id);
    expect(more.created).toHaveLength(1);
  });

  it('leaves products without a value where they are, and reuses a sub-category of that name', async () => {
    const plain = await catalogue.generateProducts(
      {
        categoryId: w.category.id,
        selections: [pick(w.options.colour, 'أسود'), pick(w.options.size, '56')],
      },
      w.owner,
    );
    const existing = await catalogue.createCategory(
      { nameAr: 'قطني', code: 'COT', parentId: w.category.id },
      w.owner,
    );
    const done = await catalogue.splitCategory(
      w.category.id,
      { groupId: w.options.fabric.id },
      w.owner,
    );
    expect(done.staying).toBe(1);
    expect(done.parts).toMatchObject([{ nameAr: 'قطني', categoryId: existing.id, existing: true }]);
    const [left] = await catalogue.listProducts({ categoryId: w.category.id }, w.owner);
    expect(left!.id).toBe(plain.products[0]!.id);
  });

  it('refuses the size, a type the category lacks or no product uses, and a clashing design', async () => {
    const invalid = { code: 'SPLIT_GROUP_INVALID' };
    const split = async (groupId: string, categoryId = w.category.id) =>
      catalogue.splitCategory(categoryId, { groupId }, w.owner);
    await expect(split(w.options.size.id)).rejects.toMatchObject(invalid);
    const other = await catalogue.createCategory(
      { nameAr: 'آخر', code: 'OTH', groupIds: [w.options.colour.id, w.options.size.id] },
      w.owner,
    );
    await expect(split(w.options.fabric.id, other.id)).rejects.toMatchObject(invalid);
    await expect(split(w.options.colour.id, other.id)).rejects.toMatchObject(invalid);

    // قطني already holds أبيض: the world's قطني · أبيض would be a second أبيض there.
    const cotton = await catalogue.createCategory(
      { nameAr: 'قطني', code: 'COT', parentId: w.category.id },
      w.owner,
    );
    await catalogue.generateProducts(
      {
        categoryId: cotton.id,
        selections: [pick(w.options.colour, 'أبيض'), pick(w.options.size, '56')],
      },
      w.owner,
    );
    await expect(split(w.options.fabric.id)).rejects.toMatchObject({ code: 'SPLIT_CONFLICT' });
    // Nothing moved.
    expect((await catalogue.getVariant(w.x.id, w.owner)).product.categoryId).toBe(w.category.id);
  });

  it('needs products.write', async () => {
    const reader = actorWith(w.owner, [PERMISSIONS.products.read]);
    await expect(
      catalogue.splitCategory(w.category.id, { groupId: w.options.fabric.id }, reader),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
