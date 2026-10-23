import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Currency } from '../../shared/money.js';
import { createTestContext, write, type World } from '../../../test/helpers.js';
import type { VariantView } from '../catalogue/catalogue.service.js';

// Developer report F-02: a receipt mistake is corrected on the receipt itself, at the line's own
// cost and against what the receipt was owed to — never through the profit. Neon test database.

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

const usd = (amount: number) => ({
  amount: BigInt(amount * 100),
  currency: 'USD' as Currency,
  rateToBase: '1',
});

/** A confirmed receipt at WH1 of `lines` (variant, quantity, dollars each). */
async function receipt(
  terms: { source: 'SUPPLIER' | 'OPENING'; partyId?: string },
  lines: [VariantView, number, number][],
) {
  const s = await sessions.openSession({ kind: 'RECEIVE', locationId: w.wh1.id }, w.owner);
  for (const [v, quantity, cost] of lines) {
    await sessions.scan({ sessionId: s.id, barcode: v.barcode, scanId: randomUUID() }, w.owner);
    if (quantity > 1) {
      await sessions.setLineQuantity({ sessionId: s.id, variantId: v.id, quantity }, w.owner);
    }
    await sessions.setLineCost({ sessionId: s.id, variantId: v.id, unitCost: usd(cost) }, w.owner);
  }
  await parties.commitReceipt(s.id, terms, w.owner);
  return s.id;
}

const at = async (v: VariantView) =>
  (await t.services.inventory.getBalance({ variantId: v.id, locationId: w.wh1.id }, w.owner))
    .quantity;
const account = async (code: string) =>
  (await books.trialBalance({}, w.owner)).rows.find((r) => r.account.code === code)?.closing ?? 0n;

describe('correcting a receipt (developer report F-02)', () => {
  it('a line taken back and a line topped up move the supplier’s bill, not the profit', async () => {
    const supplier = await parties.createParty(
      { kind: 'SUPPLIER', nameAr: 'مورد', currency: 'USD' },
      w.owner,
    );
    // 10 × X at 10 $ (100 $), 5 × Y at 20 $ (100 $): 200 $ owed.
    const id = await receipt({ source: 'SUPPLIER', partyId: supplier.id }, [
      [w.x, 10, 10],
      [w.y, 5, 20],
    ]);
    // X never came; Y was 7, not 5.
    await parties.correctReceipt(
      id,
      {
        changes: [
          { variantId: w.x.id, quantity: 0 },
          { variantId: w.y.id, quantity: 7 },
        ],
        reason: 'خطأ إدخال بالاستلام',
      },
      write(w.owner),
    );
    expect([await at(w.x), await at(w.y)]).toEqual([0, 7]);
    // 7 × 20 $ = 140 $ owed, and the books say so with nothing unnamed.
    expect((await parties.getParty(supplier.id, w.owner)).balance).toBe(14_000n);
    expect((await parties.summary(w.owner)).books.payable).toEqual({
      books: 14_000n,
      named: 14_000n,
      unassigned: 0n,
    });
    // No stock difference, no damage: the profit never saw it.
    expect(await account('5103')).toBe(0n);
    expect(await account('5102')).toBe(0n);
    expect((await books.checkBooks(w.owner)).ok).toBe(true);

    // The correction sits in the history, tied to the receipt.
    const moves = await t.services.inventory.getMovementHistory({ variantId: w.x.id }, w.owner);
    expect(moves[0]!.movement).toMatchObject({
      type: 'RECEIPT_CORRECTION',
      quantity: -10,
      referenceId: id,
    });
  });

  it('a wrong size moves to the right one at the same cost; opening stock stays opening stock', async () => {
    const id = await receipt({ source: 'OPENING' }, [[w.x, 3, 10]]);
    // One of the three was size Z.
    await parties.correctReceipt(
      id,
      { changes: [{ variantId: w.x.id, quantity: 2, toVariantId: w.z.id }], reason: 'مقاس غلط' },
      write(w.owner),
    );
    expect([await at(w.x), await at(w.z)]).toEqual([2, 1]);
    expect(await account('3901')).toBe(-3_000n);
    expect((await parties.summary(w.owner)).books.payable.unassigned).toBe(0n);

    // Taking one back: opening balances shrink by its cost, still nothing owed to anyone.
    await parties.correctReceipt(
      id,
      { changes: [{ variantId: w.z.id, quantity: 0 }], reason: 'ما وصلت' },
      write(w.owner),
    );
    expect(await account('3901')).toBe(-2_000n);
    expect((await parties.summary(w.owner)).books.payable).toMatchObject({ books: 0n });
    expect((await books.checkBooks(w.owner)).ok).toBe(true);
  });

  it('refuses once the goods are gone, and only on a confirmed receipt', async () => {
    const id = await receipt({ source: 'OPENING' }, [[w.x, 2, 10]]);
    await t.services.inventory.issueStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 2 },
      write(w.owner),
    );
    await expect(
      parties.correctReceipt(
        id,
        { changes: [{ variantId: w.x.id, quantity: 0 }], reason: 'متأخر' },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'RECEIPT_CORRECTION_NOT_POSSIBLE' });

    const open = await sessions.openSession({ kind: 'RECEIVE', locationId: w.wh1.id }, w.owner);
    await expect(
      parties.correctReceipt(
        open.id,
        { changes: [{ variantId: w.x.id, quantity: 0 }], reason: 'لسا مفتوحة' },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'SCAN_SESSION_NOT_OPEN' });
  });
});
