import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BARCODE_ENTITY, buildInternalBarcode } from '../../shared/barcode.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import {
  createTestContext,
  stock,
  SYP,
  USD,
  withoutPermission,
  type World,
} from '../../../test/helpers.js';

// docs/inventory.md → "Barcode workflow — scan sessions"; docs/testing.md → scan session scenarios.

const t = createTestContext();
const sessions = t.services.scanSessions;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

const quantityAt = async (variantId: string, locationId: string) =>
  (await t.services.inventory.getBalance({ variantId, locationId }, w.owner)).quantity;

const scan = async (sessionId: string, barcode: string, scanId: string = randomUUID()) =>
  sessions.scan({ sessionId, barcode, scanId }, w.owner);

describe('RECEIVE session', () => {
  it('scan X 37 times → one line of 37; ledger untouched until commit; commit posts; commit again is a no-op', async () => {
    const session = await sessions.openSession({ kind: 'RECEIVE', locationId: w.wh1.id }, w.owner);

    // 37 distinct physical scans from 4 scanners working at once: each scanner scans in sequence,
    // the scanners overlap. Proves the per-line +1 is atomic under realistic concurrency.
    // (37 simultaneous transactions would only measure connection-pool exhaustion.)
    const scanners = 4;
    await Promise.all(
      Array.from({ length: scanners }, async (_, scanner) => {
        for (let i = scanner; i < 37; i += scanners) await scan(session.id, w.x.barcode);
      }),
    );
    await scan(session.id, w.y.barcode);
    await sessions.setLineQuantity(
      { sessionId: session.id, variantId: w.y.id, quantity: 20 },
      w.owner,
    );

    const draft = await sessions.getSession({ sessionId: session.id }, w.owner);
    expect(draft.lines.map((l) => [l.variant.id, l.quantity])).toEqual([
      [w.x.id, 37],
      [w.y.id, 20],
    ]);
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(0);

    await sessions.setLineCost(
      { sessionId: session.id, variantId: w.x.id, unitCost: SYP(1500) },
      w.owner,
    );
    await sessions.setLineCost(
      { sessionId: session.id, variantId: w.y.id, unitCost: USD(2, '13000') },
      w.owner,
    );

    const committed = await sessions.commitSession({ sessionId: session.id }, w.owner);
    expect(committed.movements.map((m) => [m.type, m.quantity, m.referenceType])).toEqual([
      ['PURCHASE', 37, 'SCAN_SESSION'],
      ['PURCHASE', 20, 'SCAN_SESSION'],
    ]);
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(37);
    expect(await quantityAt(w.y.id, w.wh1.id)).toBe(20);

    const again = await sessions.commitSession({ sessionId: session.id }, w.owner);
    expect(again.movements.map((m) => m.id)).toEqual(committed.movements.map((m) => m.id));
    expect(await t.db.inventoryMovement.count()).toBe(2);
  });

  it('refuses to commit a received line with no unit cost', async () => {
    const session = await sessions.openSession({ kind: 'RECEIVE', locationId: w.wh1.id }, w.owner);
    await scan(session.id, w.x.barcode);
    await expect(sessions.commitSession({ sessionId: session.id }, w.owner)).rejects.toMatchObject({
      code: 'SCAN_SESSION_MISSING_COST',
    });
    expect(await t.db.inventoryMovement.count()).toBe(0);
  });

  it('cannot even be opened at the store', async () => {
    await expect(
      sessions.openSession({ kind: 'RECEIVE', locationId: w.store.id }, w.owner),
    ).rejects.toMatchObject({
      code: 'MOVEMENT_NOT_ALLOWED_AT_LOCATION',
    });
  });

  it('refuses an actor without inventory.receive', async () => {
    const actor = withoutPermission(w.owner, PERMISSIONS.inventory.receive);
    await expect(
      sessions.openSession({ kind: 'RECEIVE', locationId: w.wh1.id }, actor),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });
});

describe('scanning', () => {
  it('the same scanId twice counts once (a double trigger pull)', async () => {
    const session = await sessions.openSession({ kind: 'OPENING', locationId: w.wh1.id }, w.owner);
    const first = await scan(session.id, w.x.barcode, 'scan-0000-0001');
    const second = await scan(session.id, w.x.barcode, 'scan-0000-0001');
    expect(first).toMatchObject({ duplicate: false, line: { quantity: 1 } });
    expect(second).toMatchObject({ duplicate: true, line: { quantity: 1 } });
    expect(await t.db.scanSessionEvent.count()).toBe(1);
  });

  it('an unknown barcode is refused and changes nothing', async () => {
    const session = await sessions.openSession({ kind: 'OPENING', locationId: w.wh1.id }, w.owner);
    const nobodysBarcode = buildInternalBarcode(BARCODE_ENTITY.variant, 999_999_999n);
    await expect(scan(session.id, nobodysBarcode)).rejects.toMatchObject({
      code: 'BARCODE_NOT_FOUND',
    });
    expect(await t.db.scanSessionLine.count()).toBe(0);
  });

  it('a misread (bad check digit) is reported as such, never guessed', async () => {
    const session = await sessions.openSession({ kind: 'OPENING', locationId: w.wh1.id }, w.owner);
    const misread = w.x.barcode.slice(0, 12) + String((Number(w.x.barcode[12]) + 1) % 10);
    await expect(scan(session.id, misread)).rejects.toMatchObject({ code: 'INVALID_BARCODE' });
  });

  it('a cancelled session never touches the ledger and cannot be committed', async () => {
    const session = await sessions.openSession({ kind: 'OPENING', locationId: w.wh1.id }, w.owner);
    await scan(session.id, w.x.barcode);
    await sessions.cancelSession({ sessionId: session.id }, w.owner);
    await expect(sessions.commitSession({ sessionId: session.id }, w.owner)).rejects.toMatchObject({
      code: 'SCAN_SESSION_NOT_OPEN',
    });
    await expect(scan(session.id, w.x.barcode)).rejects.toMatchObject({
      code: 'SCAN_SESSION_NOT_OPEN',
    });
    expect(await t.db.inventoryMovement.count()).toBe(0);
  });

  it('an empty session cannot be committed', async () => {
    const session = await sessions.openSession({ kind: 'OPENING', locationId: w.wh1.id }, w.owner);
    await expect(sessions.commitSession({ sessionId: session.id }, w.owner)).rejects.toMatchObject({
      code: 'SCAN_SESSION_EMPTY',
    });
  });
});

describe('OPENING session — the first real use', () => {
  it('counts stock in without cost, once per variant per location', async () => {
    const first = await sessions.openSession({ kind: 'OPENING', locationId: w.wh1.id }, w.owner);
    await scan(first.id, w.x.barcode);
    await scan(first.id, w.x.barcode);
    const result = await sessions.commitSession({ sessionId: first.id }, w.owner);
    expect(result.movements).toMatchObject([
      { type: 'OPENING', quantity: 2, referenceType: 'OPENING' },
    ]);

    const second = await sessions.openSession({ kind: 'OPENING', locationId: w.wh1.id }, w.owner);
    await scan(second.id, w.x.barcode);
    await expect(sessions.commitSession({ sessionId: second.id }, w.owner)).rejects.toMatchObject({
      code: 'OPENING_ALREADY_RECORDED',
    });
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(2);
  });
});

describe('TRANSFER session', () => {
  it('commits every line as an OUT/IN pair, all or nothing', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    await stock(t.services, w, w.y, w.wh1, 1);

    const session = await sessions.openSession(
      { kind: 'TRANSFER', locationId: w.wh1.id, toLocationId: w.store.id },
      w.owner,
    );
    await sessions.setLineQuantity(
      { sessionId: session.id, variantId: w.x.id, quantity: 4 },
      w.owner,
    );
    await sessions.setLineQuantity(
      { sessionId: session.id, variantId: w.y.id, quantity: 5 },
      w.owner,
    );

    // Y has only 1 — the whole session must fail, including X's line.
    await expect(sessions.commitSession({ sessionId: session.id }, w.owner)).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
    expect(await quantityAt(w.x.id, w.store.id)).toBe(0);

    await sessions.setLineQuantity(
      { sessionId: session.id, variantId: w.y.id, quantity: 1 },
      w.owner,
    );
    const result = await sessions.commitSession({ sessionId: session.id }, w.owner);
    expect(result.movements.map((m) => m.type)).toEqual([
      'TRANSFER_OUT',
      'TRANSFER_IN',
      'TRANSFER_OUT',
      'TRANSFER_IN',
    ]);
    expect(await quantityAt(w.x.id, w.wh1.id)).toBe(6);
    expect(await quantityAt(w.x.id, w.store.id)).toBe(4);
    expect(await quantityAt(w.y.id, w.store.id)).toBe(1);
  });

  it('refuses unit costs on a transfer (value moves with the goods)', async () => {
    const session = await sessions.openSession(
      { kind: 'TRANSFER', locationId: w.wh1.id, toLocationId: w.wh2.id },
      w.owner,
    );
    await sessions.setLineQuantity(
      { sessionId: session.id, variantId: w.x.id, quantity: 1 },
      w.owner,
    );
    await expect(
      sessions.setLineCost({ sessionId: session.id, variantId: w.x.id, unitCost: SYP(1) }, w.owner),
    ).rejects.toMatchObject({ code: 'COST_NOT_ALLOWED' });
  });
});
