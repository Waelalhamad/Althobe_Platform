import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { permissionsFor } from '../auth/roles.js';
import { createTestContext, pick, type World } from '../../../test/helpers.js';

// Selling prices (ADR-009, ADR-011): USD minor units on the product, for all its sizes; a size
// may have its own price.

const t = createTestContext();
const catalogue = t.services.catalogue;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

const usd = (amount: bigint) => ({ amount, currency: 'USD' });
const as = (role: string) => ({ userId: w.owner.userId, permissions: permissionsFor([role]) });

describe('prices', () => {
  it('a product’s price is every size’s price; a size may have its own, and go back', async () => {
    const productId = w.x.product.id;
    const [product] = await catalogue.setProductPrices(
      { productIds: [productId], retail: '2500', wholesale: '1800' },
      w.owner,
    );
    expect(product!.prices).toEqual({ retail: usd(2500n), wholesale: usd(1800n) });
    for (const id of [w.x.id, w.y.id, w.z.id]) {
      expect((await catalogue.getVariant(id, w.owner)).prices).toEqual({
        retail: usd(2500n),
        wholesale: usd(1800n),
      });
    }

    // Size 58 costs more at retail; its wholesale stays the product's.
    const [z] = await catalogue.setPrices({ variantIds: [w.z.id], retail: '2700' }, w.owner);
    expect(z!.prices).toEqual({ retail: usd(2700n), wholesale: usd(1800n) });
    expect(z!.ownPrices).toEqual({ retail: true, wholesale: false });
    // The scan screen gets the size's price.
    expect((await t.services.inventory.resolveBarcode(w.z.barcode, w.owner)).prices.retail).toEqual(
      usd(2700n),
    );

    // Back to the product's price; then the product's retail price is removed.
    await catalogue.setPrices({ variantIds: [w.z.id], retail: null }, w.owner);
    expect((await catalogue.getVariant(w.z.id, w.owner)).prices.retail).toEqual(usd(2500n));
    await catalogue.setProductPrices({ productIds: [productId], retail: null }, w.owner);
    expect((await catalogue.getVariant(w.z.id, w.owner)).prices).toEqual({
      retail: null,
      wholesale: usd(1800n),
    });

    // Every change is audited with what it replaced.
    const audits = await t.db.auditLog.findMany({
      where: { action: { in: ['prices.set', 'prices.product.set'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(4);
    expect(JSON.stringify(audits[3]!.before)).toContain('2500');
  });

  it('new products get their prices when created; existing ones keep theirs', async () => {
    await catalogue.setProductPrices({ productIds: [w.x.product.id], retail: '1000' }, w.owner);
    const { products } = await catalogue.generateProducts(
      {
        categoryId: w.category.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض', 'أسود'),
          pick(w.options.size, '54', '60'),
        ],
        prices: { retail: '3000', wholesale: '2200' },
      },
      w.owner,
    );
    expect(products.map((p) => p.prices)).toEqual([
      { retail: usd(1000n), wholesale: null },
      { retail: usd(3000n), wholesale: usd(2200n) },
    ]);
  });

  it('refuses negative or fractional amounts, an empty change, and unknown ids', async () => {
    const invalid = { code: 'VALIDATION_FAILED' };
    await expect(
      catalogue.setProductPrices({ productIds: [w.x.product.id], retail: '-100' }, w.owner),
    ).rejects.toMatchObject(invalid);
    await expect(
      catalogue.setPrices({ variantIds: [w.x.id], retail: '12.50' }, w.owner),
    ).rejects.toMatchObject(invalid);
    await expect(catalogue.setPrices({ variantIds: [w.x.id] }, w.owner)).rejects.toMatchObject(
      invalid,
    );
    const nobody = '0199a7c4-0000-7000-8000-000000000000';
    await expect(
      catalogue.setPrices({ variantIds: [w.x.id, nobody], retail: '100' }, w.owner),
    ).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });
    await expect(
      catalogue.setProductPrices({ productIds: [nobody], retail: '100' }, w.owner),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    // Nothing was written by the refused requests.
    expect((await catalogue.getVariant(w.x.id, w.owner)).prices.retail).toBeNull();
  });

  it('owner and manager change prices; the inventory manager and store staff only see them', async () => {
    await catalogue.setProductPrices(
      { productIds: [w.x.product.id], retail: '500' },
      as('manager'),
    );
    const denied = { code: 'PERMISSION_DENIED' };
    for (const role of ['inventory_manager', 'store_staff']) {
      await expect(
        catalogue.setProductPrices({ productIds: [w.x.product.id], retail: '1' }, as(role)),
      ).rejects.toMatchObject(denied);
      await expect(
        catalogue.setPrices({ variantIds: [w.x.id], retail: '1' }, as(role)),
      ).rejects.toMatchObject(denied);
    }
    // The inventory manager still creates products, just not with prices.
    const selections = [
      pick(w.options.fabric, 'قطني'),
      pick(w.options.colour, 'أسود'),
      pick(w.options.size, '54'),
    ];
    await expect(
      catalogue.generateProducts(
        { categoryId: w.category.id, selections, prices: { retail: '1' } },
        as('inventory_manager'),
      ),
    ).rejects.toMatchObject(denied);
    await catalogue.generateProducts(
      { categoryId: w.category.id, selections },
      as('inventory_manager'),
    );

    const [seen] = await catalogue.searchVariants({ q: w.x.sku }, as('store_staff'));
    expect(seen!.prices.retail).toEqual(usd(500n));
  });
});
