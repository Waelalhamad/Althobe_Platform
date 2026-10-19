import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../shared/permissions.js';
import {
  actorWith,
  createTestContext,
  stock,
  USD,
  write,
  type World,
} from '../../../test/helpers.js';
import type { SaleInput } from './retail.schema.js';

// ADR-014: the store's point of sale, on the Neon test database (docs/testing.md).

const t = createTestContext();
const pos = t.services.retail;
let w: World;

/** 1,220.00 ل.س a piece: 10.00 $ at 122 ل.س per dollar. */
const PRICE = '122000';

beforeEach(async () => {
  w = await t.reset();
  await t.services.accounting.installChart();
  await t.services.rates.setRate({ currency: 'SYP', rate: '122' }, w.owner);
  await t.services.rates.setRate({ currency: 'TRY', rate: '41' }, w.owner);
  // 5 of X arrive at 10.00 $ each; 3 go to the store.
  await stock(t.services, w, w.x, w.wh1, 5, USD(10));
  await t.services.inventory.transferStock(
    { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.store.id, quantity: 3 },
    write(w.owner),
  );
  await t.services.catalogue.setPrices({ variantIds: [w.x.id], retailSyp: PRICE }, w.owner);
});
afterAll(async () => t.close());

const cashier = () => actorWith(w.owner, [PERMISSIONS.retail.sell, PERMISSIONS.inventory.view]);

const openShift = async (opening = { SYP: 1_000_000n }) =>
  pos.openShift({ locationId: w.store.id, opening }, w.owner);

const storeQuantity = async (variantId: string) =>
  (await t.services.inventory.getBalance({ variantId, locationId: w.store.id }, w.owner)).quantity;

const sale = (shiftId: string, extra: Partial<SaleInput> = {}): SaleInput => ({
  shiftId,
  lines: [{ variantId: w.x.id, quantity: 2 }],
  payments: [{ currency: 'SYP', amount: 244_000n }],
  ...extra,
});

describe('selling (ADR-014)', () => {
  it('takes SYP, dollars and Turkish lira together, gives change in SYP, and stock leaves the store', async () => {
    const shift = await openShift();
    // 2 × 1,220.00 = 2,440.00 ل.س. Paid: 10.00 $ (1,220.00) + 41.00 ₺ (122.00) + 1,200.00 ل.س.
    const receipt = await pos.sell(
      sale(shift.id, {
        payments: [
          { currency: 'USD', amount: 1_000n },
          { currency: 'TRY', amount: 4_100n },
          { currency: 'SYP', amount: 120_000n },
        ],
      }),
      write(cashier()),
    );
    expect(receipt).toMatchObject({
      kind: 'SALE',
      receiptNo: 1,
      subtotal: 244_000n,
      total: 244_000n,
      change: 10_200n, // 102.00 ل.س back
      totalBase: 2_000n, // 20.00 $
    });
    expect(receipt.lines).toMatchObject([{ quantity: 2, unitPrice: 122_000n, netTotal: 244_000n }]);
    expect(await storeQuantity(w.x.id)).toBe(1);

    const again = await pos.sell(
      sale(shift.id, { lines: [{ variantId: w.x.id, quantity: 1 }] }),
      write(cashier()),
    );
    expect(again.receiptNo).toBe(2);
  });

  it('refuses a piece without a price, too little money, a cashier’s discount, and selling more than is there', async () => {
    const shift = await openShift();
    await expect(
      pos.sell(sale(shift.id, { lines: [{ variantId: w.y.id, quantity: 1 }] }), write(cashier())),
    ).rejects.toMatchObject({ code: 'NO_RETAIL_PRICE', details: { variantIds: [w.y.id] } });
    await expect(
      pos.sell(sale(shift.id, { payments: [{ currency: 'SYP', amount: 100n }] }), write(cashier())),
    ).rejects.toMatchObject({ code: 'PAYMENT_TOO_LOW' });
    await expect(
      pos.sell(sale(shift.id, { discount: 1_000n }), write(cashier())),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(
      pos.sell(
        sale(shift.id, {
          lines: [{ variantId: w.x.id, quantity: 4 }],
          payments: [{ currency: 'SYP', amount: 999_999n }],
        }),
        write(cashier()),
      ),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    // Nothing of that left a trace: no receipt, the stock is whole.
    expect(await t.db.posSale.count()).toBe(0);
    expect(await storeQuantity(w.x.id)).toBe(3);
  });

  it('a manager’s discount is shared over the lines; the same request twice gives one receipt', async () => {
    const shift = await openShift();
    const ctx = write(w.owner);
    const input = sale(shift.id, {
      discount: 44_000n,
      payments: [{ currency: 'SYP', amount: 200_000n }],
    });
    const first = await pos.sell(input, ctx);
    const twice = await pos.sell(input, ctx);
    expect(twice.id).toBe(first.id);
    expect(first).toMatchObject({ total: 200_000n, change: 0n });
    expect(first.lines[0]!.netTotal).toBe(200_000n);
    expect(await t.db.posSale.count()).toBe(1);
  });
});

describe('refunds', () => {
  it('a manager takes pieces back at the cost they left with and pays SYP back, never more than sold', async () => {
    const shift = await openShift();
    const sold = await pos.sell(sale(shift.id), write(cashier()));

    await expect(
      pos.refund(
        sold.id,
        { shiftId: shift.id, lines: [{ lineNo: 1, quantity: 1 }], reason: 'مقاس' },
        write(cashier()),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const refund = await pos.refund(
      sold.id,
      { shiftId: shift.id, lines: [{ lineNo: 1, quantity: 1 }], reason: 'مقاس غير مناسب' },
      write(w.owner),
    );
    expect(refund).toMatchObject({ kind: 'REFUND', refundOfId: sold.id, total: 122_000n });
    expect(refund.payments).toEqual([
      { currency: 'SYP', amount: -122_000n, rate: '122', base: -1_000n },
    ]);
    expect(await storeQuantity(w.x.id)).toBe(2);
    const [movement] = await t.services.inventory.getMovements(
      { variantId: w.x.id, locationId: w.store.id },
      w.owner,
    );
    expect(movement).toMatchObject({ type: 'RETURN', unitCostBaseAmount: 1_000n });

    await expect(
      pos.refund(
        sold.id,
        { shiftId: shift.id, lines: [{ lineNo: 1, quantity: 2 }], reason: 'x' },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'REFUND_EXCEEDS_SALE', details: { remaining: 1 } });
  });
});

describe('shifts', () => {
  it('one open shift per store, and only at a store; another person’s shift needs a manager to close', async () => {
    const shift = await openShift();
    await expect(openShift()).rejects.toMatchObject({ code: 'SHIFT_ALREADY_OPEN' });
    await expect(
      pos.openShift({ locationId: w.wh1.id, opening: {} }, w.owner),
    ).rejects.toMatchObject({ code: 'LOCATION_NOT_A_STORE' });
    // A second cashier may sell on the shift, but not close it.
    const other = await t.db.user.create({ data: { email: 'clerk@test.local', nameAr: 'كاشير' } });
    const clerk = { userId: other.id, permissions: new Set([PERMISSIONS.retail.sell]) };
    await expect(
      pos.closeShift(shift.id, { counted: { SYP: 1_000_000n } }, clerk),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const closed = await pos.closeShift(shift.id, { counted: { SYP: 1_000_000n } }, w.owner);
    // Nothing was sold and the drawer matched: no entry to post.
    expect(closed).toMatchObject({ status: 'CLOSED', journalEntryId: null });
  });

  it('closing counts the drawer and posts one entry: cash per currency, sales, the shortage', async () => {
    const shift = await openShift();
    await pos.sell(
      sale(shift.id, {
        payments: [
          { currency: 'USD', amount: 1_000n },
          { currency: 'TRY', amount: 4_100n },
          { currency: 'SYP', amount: 120_000n },
        ],
      }),
      write(cashier()),
    );
    // Expected SYP: 10,000.00 + 1,200.00 − 102.00 change = 11,098.00. Counted 5.00 less.
    const closed = await pos.closeShift(
      shift.id,
      { counted: { SYP: 1_109_300n, USD: 1_000n, TRY: 4_100n } },
      w.owner,
    );
    expect(closed.status).toBe('CLOSED');
    expect(closed.cash.find((c) => c.currency === 'SYP')).toMatchObject({
      expected: 1_109_800n,
      counted: 1_109_300n,
      difference: -500n,
    });

    const entry = await t.services.accounting.entry(closed.journalEntryId!, w.owner);
    expect(entry.voucherType).toBe('RETAIL');
    const trial = await t.services.accounting.trialBalance({}, w.owner);
    const balance = (code: string) => trial.rows.find((r) => r.account.code === code)?.closing;
    expect(balance('4101')).toBe(-2_000n); // 20.00 $ of sales
    expect(balance('110102')).toBe(1_000n); // the dollars in the store box
    expect(balance('110106')).toBe(100n); // 41.00 ₺ = 1.00 $
    expect(balance('5298')).toBe(4n); // 5.00 ل.س short ≈ 0.04 $
    expect(trial.totals.debit).toBe(trial.totals.credit);
    // The stock that left at the POS is in the books as cost of goods sold.
    expect(balance('5101')).toBe(2_000n);
    expect((await t.services.accounting.checkBooks(w.owner)).ok).toBe(true);

    await expect(pos.sell(sale(shift.id), write(cashier()))).rejects.toMatchObject({
      code: 'SHIFT_NOT_OPEN',
    });
  });
});
