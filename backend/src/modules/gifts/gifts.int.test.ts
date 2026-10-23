import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  stock,
  USD,
  withoutPermission,
  write,
  type World,
} from '../../../test/helpers.js';
import type { VariantView } from '../catalogue/catalogue.service.js';

// Developer report F-06: a gift has its own movement, with who received it and why, posts to
// 5212 and never to damage; only the owner gives one. Neon test database.

const t = createTestContext();
const gifts = t.services.gifts;
const sessions = t.services.scanSessions;
const inv = t.services.inventory;
let w: World;

beforeEach(async () => {
  w = await t.reset();
  await t.services.accounting.installChart();
  await stock(t.services, w, w.x, w.wh1, 10, USD(21));
  await stock(t.services, w, w.y, w.wh1, 10, USD(10));
});
afterAll(async () => t.close());

const account = async (code: string) =>
  (await t.services.accounting.trialBalance({}, w.owner)).rows.find((r) => r.account.code === code)
    ?.closing ?? 0n;
const at = async (v: VariantView) =>
  (await inv.getBalance({ variantId: v.id, locationId: w.wh1.id }, w.owner)).quantity;

/** A GIFT session at WH1 with these pieces, not yet confirmed. */
async function scanned(lines: [VariantView, number][], actor = w.owner) {
  const s = await sessions.openSession({ kind: 'GIFT', locationId: w.wh1.id }, actor);
  for (const [v, quantity] of lines) {
    await sessions.scan({ sessionId: s.id, barcode: v.barcode, scanId: randomUUID() }, actor);
    if (quantity > 1) {
      await sessions.setLineQuantity({ sessionId: s.id, variantId: v.id, quantity }, actor);
    }
  }
  return s.id;
}

const shipper = {
  recipient: { name: 'شركة شحن ليبيا', kind: 'SHIPPING' as const },
  occasion: 'إكرامية شحنة ليبيا 13 تشرين',
};

describe('gifts (developer report F-06)', () => {
  it('leave stock to 5212 at cost, with the recipient kept for next time', async () => {
    const first = await gifts.confirmGift(await scanned([[w.x, 2]]), shipper, w.owner);
    expect(first).toMatchObject({ quantity: 2, valueBaseAmount: 4_200n, undone: false });
    expect(await at(w.x)).toBe(8);
    expect(await account('5212')).toBe(4_200n);
    expect(await account('5102')).toBe(0n);

    // The same name, spelled with spaces and another case, is the same recipient.
    const second = await gifts.confirmGift(
      await scanned([[w.y, 1]]),
      { ...shipper, recipient: { name: '  شركة شحن ليبيا ', kind: 'OTHER' } },
      w.owner,
    );
    expect(second.recipient.id).toBe(first.recipient.id);
    expect(await gifts.listRecipients(w.owner)).toHaveLength(1);

    // The report adds up to the account, and damage shows none of it.
    const report = await gifts.listGifts({ recipientId: first.recipient.id }, w.owner);
    expect(report.reduce((s, g) => s + g.valueBaseAmount, 0n)).toBe(await account('5212'));
    expect(await gifts.listGifts({ kind: 'CUSTOMER' }, w.owner)).toHaveLength(0);

    // Confirming again changes nothing.
    await gifts.confirmGift(second.sessionId, shipper, w.owner);
    expect(await at(w.y)).toBe(9);
  });

  it('refuses one with no recipient or occasion, and the plain commit', async () => {
    const id = await scanned([[w.x, 1]]);
    for (const bad of [
      { occasion: 'بدون مستلم' },
      { recipient: shipper.recipient, occasion: ' ' },
    ]) {
      await expect(gifts.confirmGift(id, bad, w.owner)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
    await expect(sessions.commitSession({ sessionId: id }, w.owner)).rejects.toMatchObject({
      code: 'GIFT_NEEDS_RECIPIENT',
    });
    expect(await at(w.x)).toBe(10);
  });

  it('is the owner’s alone', async () => {
    const manager = withoutPermission(w.owner, 'admin.gifts');
    await expect(
      sessions.openSession({ kind: 'GIFT', locationId: w.wh1.id }, manager),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const id = await scanned([[w.x, 1]]);
    await expect(gifts.confirmGift(id, shipper, manager)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await at(w.x)).toBe(10);
  });

  it('given by mistake, is put back exactly with «تراجع»', async () => {
    const gift = await gifts.confirmGift(await scanned([[w.x, 1]]), shipper, w.owner);
    const [movement] = (await inv.getMovements({ variantId: w.x.id }, w.owner)).filter(
      (m) => m.type === 'GIFT',
    );
    await inv.undoMovement(movement!.id, { reason: 'ما انعطت' }, write(w.owner));
    expect(await at(w.x)).toBe(10);
    expect(await account('5212')).toBe(0n);
    expect(await gifts.getGift(gift.sessionId, w.owner)).toMatchObject({
      undone: true,
      valueBaseAmount: 0n,
    });
  });

  it('no longer goes through a manual adjustment', async () => {
    await expect(
      inv.requestAdjustment(
        { variantId: w.x.id, locationId: w.wh1.id, delta: -1, reasonCode: 'GIFT', note: 'X' },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
