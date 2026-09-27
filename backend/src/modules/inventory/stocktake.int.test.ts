import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, stock, write, type World } from '../../../test/helpers.js';

// docs/inventory.md → "Stocktake"; docs/testing.md → stocktake scenarios.
// A count is evidence, never an adjustment: expected / counted / difference → STOCKTAKE movement.

const t = createTestContext();
const stocktakes = t.services.stocktakes;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

const quantityAt = async (variantId: string, locationId: string) =>
  (await t.services.inventory.getBalance({ variantId, locationId }, w.owner)).quantity;

async function countingAt(
  locationId: string,
  scope: 'FULL' | 'PARTIAL' = 'FULL',
  variantIds?: string[],
) {
  const created = await stocktakes.createStocktake({ locationId, scope, variantIds }, w.owner);
  return stocktakes.startCounting({ stocktakeId: created.id }, w.owner);
}

describe('stocktake', () => {
  it('expected 100, counted 97 → one STOCKTAKE movement of -3, applied by a second person, once', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    const st = await countingAt(w.wh1.id);
    expect(st.lines).toMatchObject([{ expectedQuantity: 100, countedQuantity: null }]);

    // Scans accumulate; a double trigger pull counts once; a typed count sets the figure.
    const scanId = randomUUID();
    await stocktakes.scanCount({ stocktakeId: st.id, barcode: w.x.barcode, scanId }, w.owner);
    const dup = await stocktakes.scanCount(
      { stocktakeId: st.id, barcode: w.x.barcode, scanId },
      w.owner,
    );
    expect(dup).toMatchObject({ duplicate: true, line: { countedQuantity: 1 } });
    await stocktakes.setCount(
      { stocktakeId: st.id, variantId: w.x.id, countedQuantity: 97 },
      w.owner,
    );

    const counted = await stocktakes.getStocktake({ stocktakeId: st.id }, w.owner);
    expect(counted.lines).toMatchObject([
      { expectedQuantity: 100, countedQuantity: 97, difference: -3 },
    ]);
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(100); // counting never touches the ledger

    await stocktakes.submitForReview({ stocktakeId: st.id }, w.owner);

    await expect(stocktakes.applyStocktake({ stocktakeId: st.id }, w.owner)).rejects.toMatchObject({
      code: 'STOCKTAKE_SECOND_APPROVER_REQUIRED',
    });

    const applied = await stocktakes.applyStocktake({ stocktakeId: st.id }, w.approver);
    expect(applied.movements).toMatchObject([
      { type: 'STOCKTAKE', quantity: -3, referenceType: 'STOCKTAKE' },
    ]);
    expect(applied.stocktake.status).toBe('APPLIED');
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(97);

    await expect(
      stocktakes.applyStocktake({ stocktakeId: st.id }, w.approver),
    ).rejects.toMatchObject({
      code: 'STOCKTAKE_INVALID_STATE',
    });
    expect(await t.db.inventoryMovement.count({ where: { type: 'STOCKTAKE' } })).toBe(1);
  });

  it('a receipt during counting is preserved: the difference is applied as a delta', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    const st = await countingAt(w.wh1.id);
    await stocktakes.setCount(
      { stocktakeId: st.id, variantId: w.x.id, countedQuantity: 97 },
      w.owner,
    );

    await stock(t.services, w, w.x, w.wh1, 10); // X = 110 while the count is open

    const view = await stocktakes.getStocktake({ stocktakeId: st.id }, w.owner);
    expect(view.movementsSinceSnapshot).toBe(1); // review warns the count may have straddled it

    await stocktakes.submitForReview({ stocktakeId: st.id }, w.owner);
    await stocktakes.applyStocktake({ stocktakeId: st.id }, w.approver);
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(107);
  });

  it('uncounted lines are never silently zero', async () => {
    await stock(t.services, w, w.x, w.wh1, 5);
    await stock(t.services, w, w.y, w.wh1, 8);
    const st = await countingAt(w.wh1.id);
    await stocktakes.setCount(
      { stocktakeId: st.id, variantId: w.x.id, countedQuantity: 5 },
      w.owner,
    );

    await expect(stocktakes.submitForReview({ stocktakeId: st.id }, w.owner)).rejects.toMatchObject(
      {
        code: 'STOCKTAKE_UNCOUNTED_LINES',
        details: { variantIds: [w.y.id] },
      },
    );

    await stocktakes.submitForReview({ stocktakeId: st.id, confirmUncountedAsZero: true }, w.owner);
    const applied = await stocktakes.applyStocktake({ stocktakeId: st.id }, w.approver);
    expect(applied.movements).toMatchObject([{ variantId: w.y.id, quantity: -8 }]);
    expect(await quantityAt(w.y.id, w.wh1.id)).toBe(0);
  });

  it('stock found that the system did not expect is counted in (full count)', async () => {
    const st = await countingAt(w.wh1.id);
    await stocktakes.scanCount(
      { stocktakeId: st.id, barcode: w.z.barcode, scanId: randomUUID() },
      w.owner,
    );
    await stocktakes.scanCount(
      { stocktakeId: st.id, barcode: w.z.barcode, scanId: randomUUID() },
      w.owner,
    );
    await stocktakes.submitForReview({ stocktakeId: st.id }, w.owner);
    const applied = await stocktakes.applyStocktake({ stocktakeId: st.id }, w.approver);
    expect(applied.movements).toMatchObject([
      { variantId: w.z.id, type: 'STOCKTAKE', quantity: 2 },
    ]);
  });

  it('a partial count refuses variants outside its scope', async () => {
    await stock(t.services, w, w.x, w.wh1, 3);
    const st = await countingAt(w.wh1.id, 'PARTIAL', [w.x.id]);
    expect(st.lines).toMatchObject([{ expectedQuantity: 3 }]);
    await expect(
      stocktakes.scanCount(
        { stocktakeId: st.id, barcode: w.y.barcode, scanId: randomUUID() },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'STOCKTAKE_VARIANT_OUT_OF_SCOPE' });
  });

  it('cannot apply a difference that would take reserved stock', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    await t.services.inventory.reserveStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 8, orderId: randomUUID() },
      write(w.owner),
    );
    const st = await countingAt(w.wh1.id);
    await stocktakes.setCount(
      { stocktakeId: st.id, variantId: w.x.id, countedQuantity: 5 },
      w.owner,
    );
    await stocktakes.submitForReview({ stocktakeId: st.id }, w.owner);
    await expect(
      stocktakes.applyStocktake({ stocktakeId: st.id }, w.approver),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_AVAILABLE_STOCK',
    });
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(10);
  });
});
