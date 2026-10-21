import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Currency } from '../../shared/money.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import {
  actorWith,
  createTestContext,
  stock,
  USD,
  write,
  type World,
} from '../../../test/helpers.js';
import type { VariantView } from '../catalogue/catalogue.service.js';

// ADR-016: suppliers and customers, on the Neon test database (docs/testing.md).

const t = createTestContext();
const parties = t.services.parties;
const sessions = t.services.scanSessions;
const books = t.services.accounting;
let w: World;
let sypBox: string;
let usdBox: string;

beforeEach(async () => {
  w = await t.reset();
  await books.installChart();
  await t.services.rates.setRate({ currency: 'SYP', rate: '122' }, w.owner);
  await t.services.rates.setRate({ currency: 'TRY', rate: '41' }, w.owner);
  const accounts = await books.listAccounts(w.owner);
  sypBox = accounts.find((a) => a.systemRole === 'STORE_CASH_SYP')!.id;
  usdBox = accounts.find((a) => a.code === '110105')!.id;
});
afterAll(async () => t.close());

const party = async (kind: 'SUPPLIER' | 'CUSTOMER', currency: Currency, nameAr = 'طرف') =>
  parties.createParty({ kind, nameAr, currency }, w.owner);

/** An open scan session of `kind` at WH1 holding `quantity` of `variant`, costed if given. */
async function session(
  kind: 'RECEIVE' | 'SALE',
  variant: VariantView,
  quantity: number,
  unitCost?: { amount: bigint; currency: Currency; rateToBase: string },
) {
  const s = await sessions.openSession({ kind, locationId: w.wh1.id }, w.owner);
  await sessions.scan({ sessionId: s.id, barcode: variant.barcode, scanId: randomUUID() }, w.owner);
  if (quantity > 1) {
    await sessions.setLineQuantity({ sessionId: s.id, variantId: variant.id, quantity }, w.owner);
  }
  if (unitCost) {
    await sessions.setLineCost({ sessionId: s.id, variantId: variant.id, unitCost }, w.owner);
  }
  return s.id;
}

const payable = async () => (await parties.summary(w.owner)).books.payable;
const receivable = async () => (await parties.summary(w.owner)).books.receivable;

describe('suppliers (ADR-016)', () => {
  it('a receipt on credit is owed to the supplier in their currency; paying in dollars after the lira moved clears its value', async () => {
    const supplier = await party('SUPPLIER', 'TRY', 'مورد تركي');
    // 5 at 410.00 ₺ (10.00 $ at 41): 2,050.00 ₺, 50.00 $.
    const id = await session('RECEIVE', w.x, 5, {
      amount: 41_000n,
      currency: 'TRY',
      rateToBase: '41',
    });
    await parties.commitReceipt(id, { source: 'SUPPLIER', partyId: supplier.id }, w.owner);
    expect((await parties.summary(w.owner)).suppliers).toEqual([
      { currency: 'TRY', amount: 205_000n },
    ]);
    expect(await payable()).toEqual({ books: 5_000n, named: 5_000n, unassigned: 0n });

    // The lira moves to 40, then 25.00 $ is paid: 1,000.00 ₺ off what is owed.
    await t.services.rates.setRate({ currency: 'TRY', rate: '40' }, w.owner);
    const paid = await parties.settle(
      supplier.id,
      { boxId: usdBox, amount: '2500' },
      write(w.owner),
    );
    expect(paid.balance).toBe(105_000n);
    // 1,000 of 2,050 ₺ carried 24.39 $; the books and the supplier agree, with nothing unnamed.
    expect(await payable()).toEqual({ books: 2_561n, named: 2_561n, unassigned: 0n });

    const statement = await parties.getParty(supplier.id, w.owner);
    expect(statement.entries.map((e) => [e.kind, e.amount, e.balance])).toEqual([
      ['PAYMENT', -100_000n, 105_000n],
      ['BILL', 205_000n, 205_000n],
    ]);

    // Paying it all off leaves nothing in the books either.
    await t.services.rates.setRate({ currency: 'TRY', rate: '41' }, w.owner);
    await parties.settle(supplier.id, { boxId: usdBox, amount: '2561' }, write(w.owner));
    expect(await payable()).toMatchObject({ named: 0n, unassigned: 0n });
  });

  it('cash at the receipt settles it on the spot; without a supplier it must cover the goods', async () => {
    const supplier = await party('SUPPLIER', 'USD');
    const a = await session('RECEIVE', w.x, 2, {
      amount: 1_000n,
      currency: 'USD',
      rateToBase: '1',
    });
    await parties.commitReceipt(
      a,
      { source: 'SUPPLIER', partyId: supplier.id, paid: { boxId: usdBox, amount: '1500' } },
      w.owner,
    );
    // 20.00 $ of goods, 15.00 $ paid: 5.00 $ still owed.
    expect((await parties.getParty(supplier.id, w.owner)).balance).toBe(500n);

    const b = await session('RECEIVE', w.y, 1, {
      amount: 1_000n,
      currency: 'USD',
      rateToBase: '1',
    });
    await expect(
      parties.commitReceipt(b, { source: 'CASH', paid: { boxId: usdBox, amount: '500' } }, w.owner),
    ).rejects.toMatchObject({ code: 'CASH_MUST_COVER_GOODS' });
    // Refused, so nothing moved: the session is still open and can be paid in full.
    await parties.commitReceipt(
      b,
      { source: 'CASH', paid: { boxId: usdBox, amount: '1000' } },
      w.owner,
    );
    expect(await payable()).toEqual({ books: 500n, named: 500n, unassigned: 0n });

    // A receipt must say where the goods came from (F-01); the old plain confirm is refused.
    const c = await session('RECEIVE', w.z, 1, {
      amount: 3_000n,
      currency: 'USD',
      rateToBase: '1',
    });
    await expect(sessions.commitSession({ sessionId: c }, w.owner)).rejects.toMatchObject({
      code: 'RECEIPT_NEEDS_SOURCE',
    });
    await expect(parties.commitReceipt(c, { source: 'SUPPLIER' }, w.owner)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    // Goods owned before the system: stock against opening balances, nothing owed to anyone.
    await parties.commitReceipt(c, { source: 'OPENING' }, w.owner);
    expect(await payable()).toEqual({ books: 500n, named: 500n, unassigned: 0n });
    const tb = await books.trialBalance({}, w.owner);
    expect(tb.rows.find((r) => r.account.code === '3901')?.closing).toBe(-3_000n);

    // What older receipts left owed with no name (here a direct ledger receipt) closes against
    // opening balances too, never more than is there.
    await stock(t.services, w, w.x, w.wh2, 1, USD(30));
    expect((await payable()).unassigned).toBe(3_000n);
    await expect(
      parties.settleUnassigned({ side: 'PAYABLE', amount: '4000' }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'UNASSIGNED_EXCEEDED' });
    await parties.settleUnassigned(
      { side: 'PAYABLE', as: 'OPENING', amount: '3000' },
      write(w.owner),
    );
    expect((await payable()).unassigned).toBe(0n);
  });

  it("refuses a cost in another currency than the supplier's, and the books' accounts for anyone else", async () => {
    const supplier = await party('SUPPLIER', 'TRY');
    const id = await session('RECEIVE', w.x, 1, {
      amount: 1_000n,
      currency: 'USD',
      rateToBase: '1',
    });
    await expect(
      parties.commitReceipt(id, { source: 'SUPPLIER', partyId: supplier.id }, w.owner),
    ).rejects.toMatchObject({ code: 'PARTY_CURRENCY_MISMATCH' });
    expect((await sessions.getSession({ sessionId: id }, w.owner)).status).toBe('OPEN');
    await expect(
      parties.commitGoodsOut(
        id,
        { source: 'SUPPLIER', partyId: supplier.id, amount: '100' },
        w.owner,
      ),
    ).rejects.toMatchObject({ code: 'WRONG_SESSION_KIND' });

    const accounts = await books.listAccounts(w.owner);
    for (const role of ['PAYABLE', 'RECEIVABLE']) {
      await expect(
        books.postVoucher(
          {
            kind: 'PAYMENT',
            boxId: usdBox,
            counterAccountId: accounts.find((a) => a.systemRole === role)!.id,
            amount: '100',
            memo: 'x',
          },
          write(w.owner),
        ),
      ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_USABLE' });
    }
  });
});

describe('customers (ADR-016)', () => {
  it('wholesale goods out go on the customer at the agreed total', async () => {
    await stock(t.services, w, w.x, w.wh1, 3, USD(10));
    const merchant = await party('CUSTOMER', 'USD', 'تاجر جملة');
    const id = await session('SALE', w.x, 2);
    await parties.commitGoodsOut(id, { partyId: merchant.id, amount: '4500' }, w.owner);
    expect((await parties.getParty(merchant.id, w.owner)).balance).toBe(4_500n);
    expect(await receivable()).toEqual({ books: 4_500n, named: 4_500n, unassigned: 0n });
    // 30 $ paid in pounds at 122: 3,660.00 ل.س.
    await parties.settle(merchant.id, { boxId: sypBox, amount: '366000' }, write(w.owner));
    expect((await parties.getParty(merchant.id, w.owner)).balance).toBe(1_500n);
    expect(await receivable()).toEqual({ books: 1_500n, named: 1_500n, unassigned: 0n });
  });

  it('a store sale on account, its refund back onto the account, the shift, and collecting the rest', async () => {
    await stock(t.services, w, w.x, w.wh1, 3, USD(10));
    await t.services.inventory.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.store.id, quantity: 3 },
      write(w.owner),
    );
    await t.services.catalogue.setPrices({ variantIds: [w.x.id], retailSyp: '122000' }, w.owner);
    const customer = await party('CUSTOMER', 'SYP', 'زبون المتجر');
    const pos = t.services.retail;
    const shift = await pos.openShift({ locationId: w.store.id, opening: {} }, w.owner);
    const cashier = actorWith(w.owner, [PERMISSIONS.retail.sell, PERMISSIONS.inventory.view]);

    // 2 × 1,220.00 = 2,440.00 ل.س: 1,000.00 in cash, 1,440.00 on account.
    const sale = await pos.sell(
      {
        shiftId: shift.id,
        lines: [{ variantId: w.x.id, quantity: 2 }],
        payments: [{ currency: 'SYP', amount: 100_000n }],
        account: { partyId: customer.id, amount: 144_000n },
      },
      write(cashier),
    );
    expect(sale).toMatchObject({ onAccount: 144_000n, change: 0n, party: { id: customer.id } });
    expect((await parties.getParty(customer.id, w.owner)).balance).toBe(144_000n);

    // One piece back: 1,220.00 goes onto the account, nothing out of the drawer.
    const refund = await pos.refund(
      sale.id,
      { shiftId: shift.id, lines: [{ lineNo: 1, quantity: 1 }], reason: 'مقاس' },
      write(w.owner),
    );
    expect(refund).toMatchObject({ onAccount: 122_000n, payments: [] });
    expect((await parties.getParty(customer.id, w.owner)).balance).toBe(22_000n);

    // The drawer holds the 1,000.00 cash: the shift closes with no difference.
    const closed = await pos.closeShift(shift.id, { counted: { SYP: 100_000n } }, w.owner);
    expect(closed.cash.find((c) => c.currency === 'SYP')!.difference).toBe(0n);
    expect(await receivable()).toMatchObject({ unassigned: 0n });

    await parties.settle(customer.id, { boxId: sypBox, amount: '22000' }, write(w.owner));
    expect((await parties.getParty(customer.id, w.owner)).balance).toBe(0n);
    expect(await receivable()).toEqual({ books: 0n, named: 0n, unassigned: 0n });
  });

  it('only a customer in pounds goes on account at the till, and only a manager adds one', async () => {
    const supplier = await party('SUPPLIER', 'SYP');
    const dollarCustomer = await party('CUSTOMER', 'USD');
    await stock(t.services, w, w.x, w.wh1, 1, USD(10));
    await t.services.inventory.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.store.id, quantity: 1 },
      write(w.owner),
    );
    await t.services.catalogue.setPrices({ variantIds: [w.x.id], retailSyp: '122000' }, w.owner);
    const shift = await t.services.retail.openShift(
      { locationId: w.store.id, opening: {} },
      w.owner,
    );
    for (const p of [supplier, dollarCustomer]) {
      await expect(
        t.services.retail.sell(
          {
            shiftId: shift.id,
            lines: [{ variantId: w.x.id, quantity: 1 }],
            account: { partyId: p.id, amount: 122_000n },
          },
          write(w.owner),
        ),
      ).rejects.toMatchObject({ code: 'PARTY_NOT_USABLE' });
    }
    const cashier = actorWith(w.owner, [PERMISSIONS.retail.sell]);
    await expect(
      parties.createParty({ kind: 'CUSTOMER', nameAr: 'x', currency: 'SYP' }, cashier),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // The cashier picks a customer by name, without seeing what anyone owes.
    expect((await parties.listParties({ kind: 'CUSTOMER' }, cashier))[0]!.balance).toBeNull();
    await expect(parties.summary(cashier)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});
