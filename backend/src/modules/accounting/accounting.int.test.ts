import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../shared/permissions.js';
import {
  actorWith,
  createTestContext,
  stock,
  SYP,
  USD,
  write,
  type World,
} from '../../../test/helpers.js';
import { businessDate, isoDate } from './posting.js';

// ADR-013: the general ledger. These tests run on the Neon test database (docs/testing.md).

const t = createTestContext();
const acc = t.services.accounting;
const inv = t.services.inventory;
let w: World;

beforeEach(async () => {
  w = await t.reset();
  await acc.installChart();
});
afterAll(async () => t.close());

const account = async (code: string) => {
  const found = (await acc.listAccounts(w.owner)).find((a) => a.code === code);
  if (!found) throw new Error(`no account ${code}`);
  return found;
};
const balanceOf = async (code: string) => {
  const { rows } = await acc.trialBalance({}, w.owner);
  return rows.find((r) => r.account.code === code)?.closing ?? 0n;
};

const today = businessDate(new Date());
/** The first day of last month: a date in a month that has already ended. */
const lastMonth = (() => {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return isoDate(new Date(Date.UTC(y, m - 2, 1)));
})();

describe('stock movements post to the books (ADR-013)', () => {
  it('posts each movement once, and each location’s stock account equals its stock value', async () => {
    await stock(t.services, w, w.x, w.wh1, 10, USD(10)); // 100.00
    await stock(t.services, w, w.y, w.wh1, 5, SYP(1220, '122')); // 5 × 10.00 = 50.00
    await inv.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.store.id, quantity: 4 },
      write(w.owner),
    );
    await inv.issueStock(
      { variantId: w.x.id, locationId: w.store.id, quantity: 1 },
      write(w.owner),
    );
    await inv.damageStock(
      { variantId: w.y.id, locationId: w.wh1.id, quantity: 1, reason: 'تمزق' },
      write(w.owner),
    );

    const check = await acc.checkBooks(w.owner);
    expect(check.ok).toBe(true);
    expect(check.transit).toBe(0n);
    expect(check.locations.find((l) => l.locationId === w.store.id)).toMatchObject({
      books: 3_000n,
      stock: 3_000n,
    });

    // 6 movements (2 receipts, transfer out + in, sale, damage): 6 entries, never more.
    await acc.syncInventory();
    const entries = await acc.entries({ voucherType: 'INVENTORY' }, w.owner);
    expect(entries).toHaveLength(6);
    expect(await acc.syncInventory()).toBe(0);

    expect(await balanceOf('5101')).toBe(1_000n); // cost of the piece sold
    expect(await balanceOf('5102')).toBe(1_000n); // the damaged piece
    expect(await balanceOf('2101')).toBe(-15_000n); // owed to suppliers: 150.00
    // What is owed for the SYP delivery is kept in SYP too.
    const statement = await acc.statement((await account('2101')).id, {}, w.owner);
    expect(statement.rows.map((r) => [r.currency, r.amountCurrency])).toContainEqual([
      'SYP',
      -610_000n,
    ]);
  });

  it('opening stock posts against opening balances, at the cost typed in the count', async () => {
    const session = await t.services.scanSessions.openSession(
      { kind: 'OPENING', locationId: w.wh2.id },
      w.owner,
    );
    await t.services.scanSessions.setLineQuantity(
      { sessionId: session.id, variantId: w.z.id, quantity: 8 },
      w.owner,
    );
    await t.services.scanSessions.setLineCost(
      { sessionId: session.id, variantId: w.z.id, unitCost: USD(25) },
      w.owner,
    );
    await t.services.scanSessions.commitSession({ sessionId: session.id }, w.owner);

    expect(await balanceOf('3901')).toBe(-20_000n);
    expect((await acc.checkBooks(w.owner)).ok).toBe(true);
  });
});

describe('vouchers', () => {
  it('receipts, payments, transfers and exchanges keep each box in its own currency', async () => {
    await t.services.rates.setRate({ currency: 'SYP', rate: '122' }, w.owner);
    const sypBox = await account('110101');
    const usdBox = await account('110102');
    const safe = await account('110105');

    // The day's retail sales into the SYP box: 244,000.00 SYP = 2,000.00 USD at 122.
    await acc.postVoucher(
      {
        kind: 'RECEIPT',
        boxId: sypBox.id,
        counterAccountId: (await account('4101')).id,
        amount: 24_400_000n,
        memo: 'مبيعات اليوم',
      },
      write(w.owner),
    );
    // Rent paid in SYP.
    await acc.postVoucher(
      {
        kind: 'PAYMENT',
        boxId: sypBox.id,
        counterAccountId: (await account('5201')).id,
        amount: 6_100_000n,
        memo: 'إيجار المحل',
      },
      write(w.owner),
    );
    // 122,000.00 SYP sold for 1,000.00 USD.
    await acc.postVoucher(
      {
        kind: 'EXCHANGE',
        fromBoxId: sypBox.id,
        fromAmount: 12_200_000n,
        toBoxId: usdBox.id,
        toAmount: 100_000n,
      },
      write(w.owner),
    );
    // The dollars go to the owner's safe.
    await acc.postVoucher(
      { kind: 'TRANSFER', fromBoxId: usdBox.id, toBoxId: safe.id, amount: 100_000n },
      write(w.owner),
    );

    const boxes = await acc.boxes(w.owner);
    const box = (id: string) => boxes.find((b) => b.account.id === id)!;
    expect(box(sypBox.id)).toMatchObject({ balance: 6_100_000n, bookValue: 50_000n });
    expect(box(usdBox.id)).toMatchObject({ balance: 0n, bookValue: 0n });
    expect(box(safe.id)).toMatchObject({ balance: 100_000n, bookValue: 100_000n });

    const income = await acc.incomeStatement({}, w.owner);
    expect(income.netProfit).toBe(150_000n); // 2,000.00 sales − 500.00 rent

    // The books balance: assets = liabilities + equity + profit.
    const sheet = await acc.balanceSheet({}, w.owner);
    expect(sheet.assets.total).toBe(sheet.totalLiabilitiesAndEquity);
  });

  it('refuses mixed currencies, stock accounts, a missing rate and unbalanced journals', async () => {
    const sypBox = await account('110101');
    const usdBox = await account('110102');
    const receipt = async (counterAccountId: string, boxId = sypBox.id) =>
      acc.postVoucher(
        { kind: 'RECEIPT', boxId, counterAccountId, amount: 100n, memo: 'x' },
        write(w.owner),
      );

    await expect(receipt((await account('4101')).id)).rejects.toMatchObject({
      code: 'RATE_NOT_SET',
    });
    await expect(receipt((await account('110599')).id, usdBox.id)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_USABLE',
      details: { reason: 'INVENTORY' },
    });
    await expect(receipt(sypBox.id, usdBox.id)).rejects.toMatchObject({
      code: 'ACCOUNT_NOT_USABLE',
      details: { reason: 'IS_CASH' },
    });
    await expect(
      acc.postVoucher(
        {
          kind: 'JOURNAL',
          memo: 'قيد',
          lines: [
            { accountId: (await account('5201')).id, debit: 100n },
            { accountId: (await account('3201')).id, credit: 99n },
          ],
        },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'ENTRY_NOT_BALANCED' });
    await expect(
      acc.postVoucher(
        {
          kind: 'PAYMENT',
          boxId: usdBox.id,
          counterAccountId: (await account('5201')).id,
          amount: 100n,
          memo: 'x',
          date: '2999-01-01',
        },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'DATE_IN_FUTURE' });
  });

  it('the same request twice posts once (a double click)', async () => {
    const ctx = write(w.owner);
    const voucher = {
      kind: 'RECEIPT' as const,
      boxId: (await account('110102')).id,
      counterAccountId: (await account('3101')).id,
      amount: 500_000n,
      memo: 'رأس المال',
    };
    const first = await acc.postVoucher(voucher, ctx);
    const again = await acc.postVoucher(voucher, ctx);
    expect(again.id).toBe(first.id);
    expect(await acc.entries({ voucherType: 'RECEIPT' }, w.owner)).toHaveLength(1);
  });
});

describe('corrections and the database rules', () => {
  it('a reversal posts the opposite lines, once; stock entries cannot be reversed', async () => {
    const entry = await acc.postVoucher(
      {
        kind: 'PAYMENT',
        boxId: (await account('110102')).id,
        counterAccountId: (await account('5204')).id,
        amount: 4_000n,
        memo: 'نقل',
      },
      write(w.owner),
    );
    const reversal = await acc.reverseEntry(entry.id, {}, write(w.owner));
    expect(reversal.lines.map((l) => l.amountBase)).toEqual(entry.lines.map((l) => -l.amountBase));
    expect(await balanceOf('5204')).toBe(0n);
    await expect(acc.reverseEntry(entry.id, {}, write(w.owner))).rejects.toMatchObject({
      code: 'ENTRY_NOT_REVERSIBLE',
      details: { reason: 'ALREADY_REVERSED' },
    });

    await stock(t.services, w, w.x, w.wh1, 1);
    const [stockEntry] = await acc.entries({ voucherType: 'INVENTORY' }, w.owner);
    await expect(acc.reverseEntry(stockEntry!.id, {}, write(w.owner))).rejects.toMatchObject({
      code: 'ENTRY_NOT_REVERSIBLE',
      details: { reason: 'SYSTEM' },
    });
  });

  it('the database rejects edits, deletes and unbalanced entries, whatever the caller', async () => {
    const entry = await acc.postVoucher(
      {
        kind: 'RECEIPT',
        boxId: (await account('110102')).id,
        counterAccountId: (await account('3101')).id,
        amount: 1_000n,
        memo: 'x',
      },
      write(w.owner),
    );
    await expect(
      t.db.journalLine.updateMany({ where: { entryId: entry.id }, data: { amountBase: 5n } }),
    ).rejects.toThrow(/append-only/);
    await expect(t.db.journalEntry.delete({ where: { id: entry.id } })).rejects.toThrow(
      /append-only/,
    );

    const cash = await account('110102');
    await expect(
      t.db.$transaction(
        async (tx) => {
          const row = await tx.journalEntry.create({
            data: {
              voucherType: 'JOURNAL',
              voucherYear: 2026,
              voucherNo: 999,
              entryDate: new Date(`${today}T00:00:00Z`),
              createdById: w.owner.userId,
            },
          });
          await tx.journalLine.create({
            data: {
              entryId: row.id,
              lineNo: 1,
              accountId: cash.id,
              amountBase: 100n,
              currency: 'USD',
              amountCurrency: 100n,
              rate: '1',
            },
          });
          // The app's own limits (shared/db.ts): Prisma's 5 s default is too short over Neon.
        },
        { maxWait: 10_000, timeout: 20_000 },
      ),
    ).rejects.toThrow(/not balanced/);
  });
});

describe('closing a month', () => {
  it('revalues SYP at the closing rate, then nothing can be dated in that month', async () => {
    await t.services.rates.setRate({ currency: 'SYP', rate: '100' }, w.owner);
    const sypBox = await account('110101');
    // 10,000.00 SYP put in last month: 100.00 USD at 100.
    await acc.postVoucher(
      {
        kind: 'RECEIPT',
        boxId: sypBox.id,
        counterAccountId: (await account('3101')).id,
        amount: 1_000_000n,
        memo: 'رأس مال',
        date: lastMonth,
      },
      write(w.owner),
    );
    // By the close the pound is at 125: the 10,000.00 SYP are worth 80.00 USD.
    await t.services.rates.setRate({ currency: 'SYP', rate: '125' }, w.owner);

    const status = await acc.closingStatus(w.owner);
    const period = lastMonth.slice(0, 7);
    expect(status.next).toBe(period);
    expect(status.preview.map((l) => l.amountBase)).toEqual([-2_000n, 2_000n]);

    await expect(
      acc.closeMonth({ period }, actorWith(w.owner, [PERMISSIONS.accounting.post])),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const closed = await acc.closeMonth({ period }, w.owner);
    expect(closed.revaluationEntryId).not.toBeNull();
    expect((await acc.boxes(w.owner)).find((b) => b.account.id === sypBox.id)).toMatchObject({
      balance: 1_000_000n,
      bookValue: 8_000n,
    });
    expect(await balanceOf('5502')).toBe(2_000n);

    await expect(
      acc.postVoucher(
        {
          kind: 'PAYMENT',
          boxId: sypBox.id,
          counterAccountId: (await account('5201')).id,
          amount: 100n,
          memo: 'متأخر',
          date: lastMonth,
        },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
    await expect(acc.closeMonth({ period }, w.owner)).rejects.toMatchObject({
      code: 'PERIOD_NOT_CLOSABLE',
    });
  });
});

describe('who may do what', () => {
  it('reading needs accounting.view, posting accounting.post, the chart accounting.close', async () => {
    const shop = actorWith(w.owner, [PERMISSIONS.inventory.view, PERMISSIONS.inventory.issue]);
    await expect(acc.boxes(shop)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const reader = actorWith(w.owner, [PERMISSIONS.accounting.view]);
    await expect(
      acc.postVoucher(
        {
          kind: 'RECEIPT',
          boxId: (await account('110102')).id,
          counterAccountId: (await account('3101')).id,
          amount: 100n,
          memo: 'x',
        },
        write(reader),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const accountant = actorWith(w.owner, [
      PERMISSIONS.accounting.view,
      PERMISSIONS.accounting.post,
    ]);
    await expect(
      acc.createAccount(
        { parentId: (await account('52')).id, nameAr: 'مصاريف السيارة' },
        accountant,
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const created = await acc.createAccount(
      { parentId: (await account('52')).id, nameAr: 'مصاريف السيارة' },
      w.owner,
    );
    expect(created).toMatchObject({ code: '5216', class: 5, isPostable: true });
  });
});

describe('developer report rules (2026-10-21)', () => {
  it('F-08: damage and stock differences are not the cost of sales', async () => {
    await stock(t.services, w, w.x, w.wh1, 10, USD(10));
    await inv.damageStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 1, reason: 'تمزق' },
      write(w.owner),
    );
    const income = await acc.incomeStatement({ from: today, to: today }, w.owner);
    const total = (key: string) => income.sections.find((x) => x.key === key)!.total;
    expect(total('costOfSales')).toBe(0n);
    expect(total('stockLosses')).toBe(1_000n);
    expect(income.netProfit).toBe(-1_000n);
  });

  it('F-10: an entry dated more than two days back needs whoever closes months, and a reason', async () => {
    await t.services.rates.setRate({ currency: 'SYP', rate: '122' }, w.owner);
    const usdBox = await account('110102');
    const safe = await account('110105');
    const transfer = {
      kind: 'TRANSFER' as const,
      fromBoxId: usdBox.id,
      toBoxId: safe.id,
      amount: 100n,
    };
    const poster = actorWith(w.owner, [PERMISSIONS.accounting.view, PERMISSIONS.accounting.post]);
    await expect(
      acc.postVoucher({ ...transfer, date: lastMonth }, write(poster)),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    await expect(
      acc.postVoucher({ ...transfer, date: lastMonth }, write(w.owner)),
    ).rejects.toMatchObject({
      code: 'BACKDATED_NEEDS_REASON',
    });
    await acc.postVoucher({ ...transfer, date: lastMonth, memo: 'نسيت أسجّله' }, write(w.owner));
    // Today needs neither.
    await acc.postVoucher(transfer, write(poster));
  });
});
