import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { permissionsFor } from '../auth/roles.js';
import { createTestContext, pick, type World } from '../../../test/helpers.js';

// Selling prices (ADR-009): USD minor units per variant, retail and wholesale.

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
  it('prices a filtered list at once, then one variant, and clears a price', async () => {
    const all = [w.x.id, w.y.id, w.z.id];
    const priced = await catalogue.setPrices(
      { variantIds: all, retail: '2500', wholesale: '1800' },
      w.owner,
    );
    expect(priced.map((v) => v.prices)).toEqual(
      all.map(() => ({ retail: usd(2500n), wholesale: usd(1800n) })),
    );

    // One variant, retail only: its wholesale price and the others are untouched.
    await catalogue.setPrices({ variantIds: [w.z.id], retail: '2700' }, w.owner);
    const [z] = await catalogue.setPrices({ variantIds: [w.z.id], wholesale: null }, w.owner);
    expect(z!.prices).toEqual({ retail: usd(2700n), wholesale: null });
    expect((await catalogue.getVariant(w.x.id, w.owner)).prices.retail).toEqual(usd(2500n));

    // The scan screen gets the price with the variant.
    expect((await t.services.inventory.resolveBarcode(w.z.barcode, w.owner)).prices.retail).toEqual(
      usd(2700n),
    );

    // Every change is audited with what it replaced.
    const audits = await t.db.auditLog.findMany({
      where: { action: 'prices.set' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits).toHaveLength(3);
    expect(JSON.stringify(audits[2]!.before)).toContain('1800');
  });

  it('gives new variants their prices when they are created; existing ones keep theirs', async () => {
    await catalogue.setPrices({ variantIds: [w.x.id], retail: '1000' }, w.owner);
    const { created, existing } = await catalogue.generateVariants(
      {
        productId: w.x.product.id,
        selections: [
          pick(w.options.fabric, 'قطني'),
          pick(w.options.colour, 'أبيض'),
          pick(w.options.size, '54', '60'),
        ],
        prices: { retail: '3000', wholesale: '2200' },
      },
      w.owner,
    );
    expect(created.map((v) => [v.size, v.prices])).toEqual([
      ['60', { retail: usd(3000n), wholesale: usd(2200n) }],
    ]);
    expect(existing.find((v) => v.id === w.x.id)!.prices).toEqual({
      retail: usd(1000n),
      wholesale: null,
    });
  });

  it('refuses negative or fractional amounts, an empty change, and unknown variants', async () => {
    const invalid = { code: 'VALIDATION_FAILED' };
    await expect(
      catalogue.setPrices({ variantIds: [w.x.id], retail: '-100' }, w.owner),
    ).rejects.toMatchObject(invalid);
    await expect(
      catalogue.setPrices({ variantIds: [w.x.id], retail: '12.50' }, w.owner),
    ).rejects.toMatchObject(invalid);
    await expect(catalogue.setPrices({ variantIds: [w.x.id] }, w.owner)).rejects.toMatchObject(
      invalid,
    );
    await expect(
      catalogue.setPrices(
        { variantIds: [w.x.id, '0199a7c4-0000-7000-8000-000000000000'], retail: '100' },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'VARIANT_NOT_FOUND' });
    // Nothing was written by the refused request.
    expect((await catalogue.getVariant(w.x.id, w.owner)).prices.retail).toBeNull();
  });

  it('owner and manager change prices; the inventory manager and store staff only see them', async () => {
    await catalogue.setPrices({ variantIds: [w.x.id], retail: '500' }, as('manager'));
    const denied = { code: 'PERMISSION_DENIED' };
    for (const role of ['inventory_manager', 'store_staff']) {
      await expect(
        catalogue.setPrices({ variantIds: [w.x.id], retail: '1' }, as(role)),
      ).rejects.toMatchObject(denied);
    }
    // The inventory manager still creates variants, just not with prices.
    const selections = [
      pick(w.options.fabric, 'قطني'),
      pick(w.options.colour, 'أسود'),
      pick(w.options.size, '54'),
    ];
    await expect(
      catalogue.generateVariants(
        { productId: w.x.product.id, selections, prices: { retail: '1' } },
        as('inventory_manager'),
      ),
    ).rejects.toMatchObject(denied);
    await catalogue.generateVariants(
      { productId: w.x.product.id, selections },
      as('inventory_manager'),
    );

    const [seen] = await catalogue.searchVariants({ q: w.x.sku }, as('store_staff'));
    expect(seen!.prices.retail).toEqual(usd(500n));
  });
});
