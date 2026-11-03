import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { inTransaction } from '../../shared/db.js';
import type { Currency } from '../../shared/money.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { actorWith, createTestContext, USD, write, type World } from '../../../test/helpers.js';
import type { VariantView } from '../catalogue/catalogue.service.js';

// Receipts confirmed with no supplier, then found to be a supplier's (owner, 2026-11-03).

const t = createTestContext();
const parties = t.services.parties;
const sessions = t.services.scanSessions;
const books = t.services.accounting;
let w: World;

beforeEach(async () => {
  w = await t.reset();
  await books.installChart();
});
afterAll(async () => t.close());

const supplier = async (currency: Currency = 'USD') =>
  parties.createParty({ kind: 'SUPPLIER', nameAr: 'محمد الحايك', currency }, w.owner);

/** A receipt at WH1 of `quantity` × `variant` at `dollars` each, confirmed with no terms at all. */
async function plainReceipt(variant: VariantView, quantity: number, dollars: number) {
  const s = await sessions.openSession({ kind: 'RECEIVE', locationId: w.wh1.id }, w.owner);
  await sessions.scan({ sessionId: s.id, barcode: variant.barcode, scanId: randomUUID() }, w.owner);
  await sessions.setLineQuantity({ sessionId: s.id, variantId: variant.id, quantity }, w.owner);
  await sessions.setLineCost(
    { sessionId: s.id, variantId: variant.id, unitCost: USD(dollars) },
    w.owner,
  );
  return s.id;
}

/** As receipts were confirmed before sources were asked (13 October): with no terms at all. */
const commitBare = async (id: string) =>
  inTransaction(t.db, async (tx) => sessions.commitInTx(tx, id, w.owner));

const payable = async () => (await parties.summary(w.owner)).books.payable;
const closing = async (code: string) =>
  (await books.trialBalance({}, w.owner)).rows.find((r) => r.account.code === code)?.closing ?? 0n;
const balanceOf = async (id: string) => (await parties.getParty(id, w.owner)).balance;

describe('a supplier claims receipts that had none', () => {
  it('receipts settled as opening stock become the supplier’s bills; the stock and profit stay', async () => {
    const a = await plainReceipt(w.x, 3, 21);
    await commitBare(a);
    const b = await plainReceipt(w.y, 2, 17.65);
    await commitBare(b);
    // As the owner did on 23 October: what was owed with no name became opening stock.
    await parties.settleUnassigned(
      { side: 'PAYABLE', as: 'OPENING', amount: '9830' },
      write(w.owner),
    );
    expect(await payable()).toEqual({ books: 0n, named: 0n, unassigned: 0n });
    expect(await closing('3901')).toBe(-9_830n);
    expect((await parties.unsourcedReceipts(w.owner)).map((r) => [r.pieces, r.value])).toEqual([
      [3, 6_300n],
      [2, 3_530n],
    ]);

    const haik = await supplier();
    const preview = await parties.claimReceipts(
      haik.id,
      { sessionIds: [a, b], dryRun: true },
      write(w.owner),
    );
    expect(preview).toMatchObject({ receipts: 2, pieces: 5, value: 9_830n, fromOpening: 9_830n });
    expect(await closing('3901')).toBe(-9_830n);

    const done = await parties.claimReceipts(haik.id, { sessionIds: [a, b] }, write(w.owner));
    expect(done).toMatchObject({ value: 9_830n, named: 0n, fromOpening: 9_830n });
    expect(done.journalEntryId).toBeTruthy();
    expect(await balanceOf(haik.id)).toBe(9_830n);
    expect(await payable()).toEqual({ books: 9_830n, named: 9_830n, unassigned: 0n });
    expect(await closing('3901')).toBe(0n);
    // The goods are worth what they were; nothing reached the profit.
    const stockAccounts = (await books.trialBalance({}, w.owner)).rows
      .filter((r) => r.account.code.startsWith('1105'))
      .reduce((n, r) => n + r.closing, 0n);
    expect(stockAccounts).toBe(9_830n);
    expect(await parties.unsourcedReceipts(w.owner)).toEqual([]);

    // Claimed twice: refused. A correction now moves the supplier's bill.
    await expect(
      parties.claimReceipts(haik.id, { sessionIds: [a] }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'RECEIPT_HAS_SOURCE' });
    await parties.correctReceipt(
      a,
      { changes: [{ variantId: w.x.id, quantity: 2 }], reason: 'قطعة زيادة' },
      write(w.owner),
    );
    expect(await balanceOf(haik.id)).toBe(7_730n);
  });

  it('names what is still owed with no name, and takes the rest from opening stock', async () => {
    const unnamed = await plainReceipt(w.x, 2, 10);
    await commitBare(unnamed);
    const opening = await plainReceipt(w.y, 1, 5);
    await parties.commitReceipt(opening, { source: 'OPENING' }, w.owner);
    expect(await payable()).toEqual({ books: 2_000n, named: 0n, unassigned: 2_000n });

    const haik = await supplier();
    const done = await parties.claimReceipts(
      haik.id,
      { sessionIds: [unnamed, opening] },
      write(w.owner),
    );
    expect(done).toMatchObject({ value: 2_500n, named: 2_000n, fromOpening: 500n });
    expect(await payable()).toEqual({ books: 2_500n, named: 2_500n, unassigned: 0n });
    expect(await closing('3901')).toBe(0n);
  });

  it('refuses a receipt with a supplier, another currency, a customer, and without parties.manage', async () => {
    const haik = await supplier();
    const named = await plainReceipt(w.x, 1, 10);
    await parties.commitReceipt(named, { source: 'SUPPLIER', partyId: haik.id }, w.owner);
    await expect(
      parties.claimReceipts(haik.id, { sessionIds: [named] }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'RECEIPT_HAS_SOURCE' });

    const plain = await plainReceipt(w.y, 1, 10);
    await commitBare(plain);
    const lira = await supplier('SYP');
    await expect(
      parties.claimReceipts(lira.id, { sessionIds: [plain] }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'PARTY_CURRENCY_MISMATCH' });
    const customer = await parties.createParty(
      { kind: 'CUSTOMER', nameAr: 'زبون', currency: 'USD' },
      w.owner,
    );
    await expect(
      parties.claimReceipts(customer.id, { sessionIds: [plain] }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'PARTY_NOT_USABLE' });
    const clerk = write(actorWith(w.owner, [PERMISSIONS.parties.read]));
    await expect(
      parties.claimReceipts(haik.id, { sessionIds: [plain] }, clerk),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // Nothing was claimed.
    expect(await balanceOf(haik.id)).toBe(1_000n);
  });
});
