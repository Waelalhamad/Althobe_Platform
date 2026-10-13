import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { permissionsFor } from '../auth/roles.js';
import { createTestContext, pick, type World } from '../../../test/helpers.js';

// Selling prices (ADR-011, ADR-012) on the product, for all its sizes; a size may have its own.
// Retail in SYP (Syria) and LYD (Libya, 3 decimals), wholesale in USD: each list one currency.

const t = createTestContext();
const catalogue = t.services.catalogue;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

const syp = (amount: bigint) => ({ amount, currency: 'SYP' });
const lyd = (amount: bigint) => ({ amount, currency: 'LYD' });
const usd = (amount: bigint) => ({ amount, currency: 'USD' });
const as = (role: string) => ({ userId: w.owner.userId, permissions: permissionsFor([role]) });

describe('prices', () => {
  it('a product’s price is every size’s price; a size may have its own, and go back', async () => {
    const productId = w.x.product.id;
    const [product] = await catalogue.setProductPrices(
      { productIds: [productId], retailSyp: '35000000', retailLyd: '125500', wholesale: '1800' },
      w.owner,
    );
    const all = { retailSyp: syp(35_000_000n), retailLyd: lyd(125_500n), wholesale: usd(1800n) };
    expect(product!.prices).toEqual(all);
    for (const id of [w.x.id, w.y.id, w.z.id]) {
      expect((await catalogue.getVariant(id, w.owner)).prices).toEqual(all);
    }

    // Size 58 costs more in Syria; its Libyan and wholesale prices stay the product's.
    const [z] = await catalogue.setPrices({ variantIds: [w.z.id], retailSyp: '40000000' }, w.owner);
    expect(z!.prices).toEqual({ ...all, retailSyp: syp(40_000_000n) });
    expect(z!.ownPrices).toEqual({ retailSyp: true, retailLyd: false, wholesale: false });
    // The scan screen gets the size's price.
    expect(
      (await t.services.inventory.resolveBarcode(w.z.barcode, w.owner)).prices.retailSyp,
    ).toEqual(syp(40_000_000n));

    // Back to the product's price; then the product's Libyan price is removed.
    await catalogue.setPrices({ variantIds: [w.z.id], retailSyp: null }, w.owner);
    expect((await catalogue.getVariant(w.z.id, w.owner)).prices.retailSyp).toEqual(
      syp(35_000_000n),
    );
    await catalogue.setProductPrices({ productIds: [productId], retailLyd: null }, w.owner);
    expect((await catalogue.getVariant(w.z.id, w.owner)).prices).toEqual({
      ...all,
      retailLyd: null,
    });

    // Every change is audited with what it replaced.
    const audits = await t.db.auditLog.findMany({
      where: { action: { in: ['prices.set', 'prices.product.set'] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(4);
    expect(JSON.stringify(audits[3]!.before)).toContain('125500');
  });

  it('new products get their prices when created; existing ones keep theirs', async () => {
    await catalogue.setProductPrices({ productIds: [w.x.product.id], retailSyp: '1000' }, w.owner);
    const { products } = await catalogue.generateProducts(
      {
        categoryId: w.category.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض', 'أسود'),
          pick(w.options.size, '54', '60'),
        ],
        prices: { retailSyp: '3000', retailLyd: '45000', wholesale: '2200' },
      },
      w.owner,
    );
    expect(products.map((p) => p.prices)).toEqual([
      { retailSyp: syp(1000n), retailLyd: null, wholesale: null },
      { retailSyp: syp(3000n), retailLyd: lyd(45_000n), wholesale: usd(2200n) },
    ]);
  });

  it('refuses negative or fractional amounts, an empty change, and unknown ids', async () => {
    const invalid = { code: 'VALIDATION_FAILED' };
    await expect(
      catalogue.setProductPrices({ productIds: [w.x.product.id], retailSyp: '-100' }, w.owner),
    ).rejects.toMatchObject(invalid);
    await expect(
      catalogue.setPrices({ variantIds: [w.x.id], retailLyd: '12.50' }, w.owner),
    ).rejects.toMatchObject(invalid);
    await expect(catalogue.setPrices({ variantIds: [w.x.id] }, w.owner)).rejects.toMatchObject(
      invalid,
    );
    const nobody = '0199a7c4-0000-7000-8000-000000000000';
    await expect(
      catalogue.setPrices({ variantIds: [w.x.id, nobody], retailSyp: '100' }, w.owner),
    ).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });
    await expect(
      catalogue.setProductPrices({ productIds: [nobody], retailSyp: '100' }, w.owner),
    ).rejects.toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    // Nothing was written by the refused requests.
    expect((await catalogue.getVariant(w.x.id, w.owner)).prices.retailSyp).toBeNull();
  });

  it('the database keeps each list in its own currency', async () => {
    await expect(
      t.db.$executeRaw`
        INSERT INTO product_prices (id, product_id, list, amount, currency, updated_at)
        VALUES (gen_random_uuid(), ${w.x.product.id}::uuid, 'RETAIL_LYD', 100, 'USD', now())`,
    ).rejects.toThrow(/ck_product_prices_list_currency/);
  });

  it('owner and manager change prices; the inventory manager and store staff only see them', async () => {
    await catalogue.setProductPrices(
      { productIds: [w.x.product.id], retailSyp: '500' },
      as('manager'),
    );
    const denied = { code: 'PERMISSION_DENIED' };
    for (const role of ['inventory_manager', 'store_staff']) {
      await expect(
        catalogue.setProductPrices({ productIds: [w.x.product.id], retailSyp: '1' }, as(role)),
      ).rejects.toMatchObject(denied);
      await expect(
        catalogue.setPrices({ variantIds: [w.x.id], retailLyd: '1' }, as(role)),
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
        { categoryId: w.category.id, selections, prices: { retailSyp: '1' } },
        as('inventory_manager'),
      ),
    ).rejects.toMatchObject(denied);
    await catalogue.generateProducts(
      { categoryId: w.category.id, selections },
      as('inventory_manager'),
    );

    const [seen] = await catalogue.searchVariants({ q: w.x.sku }, as('store_staff'));
    expect(seen!.prices.retailSyp).toEqual(syp(500n));
  });
});
