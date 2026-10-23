import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { createTestContext, stock, USD, write, type World } from '../../../test/helpers.js';
import type { VariantView } from '../catalogue/catalogue.service.js';

// Developer report F-04: Libya is a branch. Goods for it go as a shipment — sent to the road,
// received at what arrived, the rest lost — and someone kept to Libya sees and moves only
// Libya's stock. Neon test database.

const t = createTestContext();
const sessions = t.services.scanSessions;
const shipments = t.services.shipments;
const inv = t.services.inventory;
const books = t.services.accounting;
let w: World;
let libya: ActorContext;
let road: string;

beforeEach(async () => {
  w = await t.reset();
  await books.installChart();
  await stock(t.services, w, w.x, w.wh1, 10, USD(21));
  await stock(t.services, w, w.y, w.wh1, 10, USD(10));
  road = (await t.services.locations.transitLocation(t.db)).id;
  // A warehouse keeper in Libya: the keeper's permissions, kept to the Libya branch.
  libya = {
    userId: w.approver.userId,
    branch: 'LY',
    permissions: new Set([
      PERMISSIONS.inventory.view,
      PERMISSIONS.inventory.receive,
      PERMISSIONS.inventory.transfer,
      PERMISSIONS.inventory.damage,
      PERMISSIONS.inventory.stocktakeCount,
      PERMISSIONS.products.read,
    ]),
  };
});
afterAll(async () => t.close());

const at = async (v: VariantView, locationId: string) =>
  (await inv.getBalance({ variantId: v.id, locationId }, w.owner)).quantity;
const account = async (code: string, branch?: 'SY' | 'LY') =>
  (await books.trialBalance(branch ? { branch } : {}, w.owner)).rows.find(
    (r) => r.account.code === code,
  )?.closing ?? 0n;
/** A branch's books add up on their own: every debit has its credit within the branch. */
const balanced = async (branch: 'SY' | 'LY') =>
  (await books.trialBalance({ branch }, w.owner)).rows.reduce((s, r) => s + r.closing, 0n);

async function scanInto(sessionId: string, lines: [VariantView, number][], actor: ActorContext) {
  for (const [v, quantity] of lines) {
    await sessions.scan({ sessionId, barcode: v.barcode, scanId: randomUUID() }, actor);
    if (quantity > 1)
      await sessions.setLineQuantity({ sessionId, variantId: v.id, quantity }, actor);
  }
}

/** Sent from WH1 to the Libya warehouse; returns the shipment. */
async function send(lines: [VariantView, number][]) {
  const s = await sessions.openSession(
    { kind: 'TRANSFER', locationId: w.wh1.id, toLocationId: w.ly.id },
    w.owner,
  );
  await scanInto(s.id, lines, w.owner);
  await sessions.commitSession({ sessionId: s.id }, w.owner);
  const [shipment] = await shipments.listShipments({ status: 'IN_TRANSIT' }, w.owner);
  return shipment!;
}

async function receive(shipmentId: string, lines: [VariantView, number][]) {
  const { sessionId } = await shipments.openReceipt(shipmentId, libya);
  await scanInto(sessionId, lines, libya);
  await sessions.commitSession({ sessionId }, libya);
}

describe('shipments to Libya (developer report F-04)', () => {
  it('leave Syria for the road, and enter Libya at the value they travelled at', async () => {
    const shipment = await send([[w.x, 10]]);
    expect(shipment).toMatchObject({ sent: 10, received: null, valueBaseAmount: 21_000n });
    expect([await at(w.x, w.wh1.id), await at(w.x, road), await at(w.x, w.ly.id)]).toEqual([
      0, 10, 0,
    ]);
    expect((await books.checkBooks(w.owner)).ok).toBe(true);

    await receive(shipment.id, [[w.x, 10]]);
    expect([await at(w.x, road), await at(w.x, w.ly.id)]).toEqual([0, 10]);
    expect(
      (await inv.getBalance({ variantId: w.x.id, locationId: w.ly.id }, w.owner)).valueBaseAmount,
    ).toBe(21_000n);
    expect(await shipments.getShipment(shipment.id, w.owner)).toMatchObject({
      status: 'RECEIVED',
      received: 10,
      lost: 0,
    });
    // Each branch's books add up on their own, and the stock matches them.
    expect(await balanced('SY')).toBe(0n);
    expect(await balanced('LY')).toBe(0n);
    expect((await books.checkBooks(w.owner)).ok).toBe(true);
  });

  it('what did not arrive is lost in shipping, at cost', async () => {
    const shipment = await send([
      [w.x, 5],
      [w.y, 2],
    ]);
    await receive(shipment.id, [[w.x, 3]]);
    expect(await at(w.x, w.ly.id)).toBe(3);
    expect(await at(w.y, w.ly.id)).toBe(0);
    expect(await at(w.x, road)).toBe(0);
    // 2 × 21 $ + 2 × 10 $.
    expect(await account('5104')).toBe(6_200n);
    expect(await shipments.getShipment(shipment.id, w.owner)).toMatchObject({ lost: 4 });
    expect((await books.checkBooks(w.owner)).ok).toBe(true);
  });

  it('refuses more than was sent, or what was not sent, and a second receipt', async () => {
    const shipment = await send([[w.x, 2]]);
    const { sessionId } = await shipments.openReceipt(shipment.id, libya);
    await scanInto(sessionId, [[w.y, 1]], libya);
    await expect(sessions.commitSession({ sessionId }, libya)).rejects.toMatchObject({
      code: 'SHIPMENT_EXCESS',
    });
    expect(await at(w.x, road)).toBe(2);

    await sessions.cancelSession({ sessionId }, libya);
    await receive(shipment.id, [[w.x, 2]]);
    await expect(shipments.openReceipt(shipment.id, libya)).rejects.toMatchObject({
      code: 'SHIPMENT_NOT_IN_TRANSIT',
    });
  });

  it('never go as an instant transfer', async () => {
    await expect(
      inv.transferStock(
        { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.ly.id, quantity: 1 },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'SHIPMENT_REQUIRED' });
    // Nor does anyone open a session on the road.
    await expect(
      sessions.openSession({ kind: 'DAMAGE', locationId: road, reason: 'تجربة' }, w.owner),
    ).rejects.toMatchObject({ code: 'MOVEMENT_NOT_ALLOWED_AT_LOCATION' });
  });
});

describe('someone kept to Libya (F-04)', () => {
  it('sees and moves only Libya’s stock', async () => {
    const listed = await t.services.locations.listLocations(libya);
    expect(listed.filter((l) => l.mine).map((l) => l.code)).toEqual(['LY1']);
    expect(listed.some((l) => l.kind === 'TRANSIT')).toBe(false);

    for (const attempt of [
      sessions.openSession({ kind: 'DAMAGE', locationId: w.wh1.id, reason: 'تجربة' }, libya),
      inv.getBalance({ variantId: w.x.id, locationId: w.wh1.id }, libya),
      inv.listBalances({ locationId: w.wh1.id }, libya),
      t.services.stocktakes.createStocktake({ locationId: w.wh1.id, scope: 'FULL' }, libya),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'LOCATION_OUT_OF_BRANCH' });
    }
    // Syria's history is not Libya's.
    expect(await inv.getMovements({}, libya)).toHaveLength(0);

    // A shipment Syria sent is Libya's to see; one inside Syria is not.
    const shipment = await send([[w.x, 1]]);
    expect((await shipments.listShipments({}, libya)).map((s) => s.id)).toEqual([shipment.id]);
    // And no cost reaches the keeper.
    expect((await shipments.getShipment(shipment.id, libya)).valueBaseAmount).toBeNull();
  });
});
