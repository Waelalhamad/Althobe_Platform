import type { MovementType } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from '../../shared/db.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createServices } from '../../services.js';
import {
  createTestContext,
  stock,
  SYP,
  USD,
  withoutPermission,
  write,
  type World,
} from '../../../test/helpers.js';

// docs/testing.md → "Inventory: minimum required coverage", with its exact numbers.

const t = createTestContext();
const inv = t.services.inventory;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

const balanceOf = async (variantId: string, locationId: string) =>
  inv.getBalance({ variantId, locationId }, w.owner);

const movementCount = async (type?: MovementType) =>
  t.db.inventoryMovement.count(type ? { where: { type } } : undefined);

describe('receiveStock', () => {
  it('100 → receive 20 → 120, with one PURCHASE movement', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    const result = await inv.receiveStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 20, unitCost: SYP(1000) },
      write(w.owner),
    );
    expect(result.movements).toHaveLength(1);
    expect(result.movements[0]).toMatchObject({
      type: 'PURCHASE',
      quantity: 20,
      balanceAfter: 120,
    });
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(120);
  });

  it('rejects zero and negative quantities', async () => {
    for (const quantity of [0, -5]) {
      await expect(
        inv.receiveStock(
          { variantId: w.x.id, locationId: w.wh1.id, quantity, unitCost: SYP(1) },
          write(w.owner),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
    expect(await movementCount()).toBe(0);
  });

  it('rejects receiving at the store (location policy)', async () => {
    await expect(
      inv.receiveStock(
        { variantId: w.x.id, locationId: w.store.id, quantity: 10, unitCost: SYP(1) },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'MOVEMENT_NOT_ALLOWED_AT_LOCATION' });
  });

  it('rejects an actor without inventory.receive', async () => {
    const actor = withoutPermission(w.owner, PERMISSIONS.inventory.receive);
    await expect(
      inv.receiveStock(
        { variantId: w.x.id, locationId: w.wh1.id, quantity: 1, unitCost: SYP(1) },
        write(actor),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
  });
});

describe('issueStock', () => {
  it('100 → issue 20 → 80, with one SALE movement', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    const result = await inv.issueStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 20 },
      write(w.owner),
    );
    expect(result.movements[0]).toMatchObject({ type: 'SALE', quantity: -20, balanceAfter: 80 });
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(80);
  });

  it('100 → issue 101 → INSUFFICIENT_STOCK; quantity stays 100, no movement', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    await expect(
      inv.issueStock({ variantId: w.x.id, locationId: w.wh1.id, quantity: 101 }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(100);
    expect(await movementCount('SALE')).toBe(0);
  });

  it('lets exactly one of two truly parallel issues win', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    // A second client: a second connection pool, so the two transactions really overlap.
    const otherDb = createDb(t.url);
    const other = createServices(otherDb);
    try {
      const results = await Promise.allSettled([
        inv.issueStock({ variantId: w.x.id, locationId: w.wh1.id, quantity: 60 }, write(w.owner)),
        other.inventory.issueStock(
          { variantId: w.x.id, locationId: w.wh1.id, quantity: 60 },
          write(w.owner),
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected');
      expect(rejected?.reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
      expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(40);
      expect(await movementCount('SALE')).toBe(1);
    } finally {
      await otherDb.$disconnect();
    }
  });
});

describe('transferStock', () => {
  it('A=100, B=20, transfer 30 → A=70, B=50, two movements sharing one transfer id', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    await stock(t.services, w, w.x, w.wh2, 20);
    const result = await inv.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.wh2.id, quantity: 30 },
      write(w.owner),
    );
    expect(result.movements.map((m) => [m.type, m.quantity])).toEqual([
      ['TRANSFER_OUT', -30],
      ['TRANSFER_IN', 30],
    ]);
    expect(result.movements[0]!.transferId).toBe(result.movements[1]!.transferId);
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(70);
    expect((await balanceOf(w.x.id, w.wh2.id)).quantity).toBe(50);
  });

  it('rolls back both sides when the destination update fails mid-transaction', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    await stock(t.services, w, w.x, w.wh2, 20);
    // A real database failure, injected after the movements are written: a trigger that rejects
    // any update to the destination's balance row.
    await t.db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END; $$`);
    await t.db.$executeRawUnsafe(`
      CREATE TRIGGER test_fail_destination BEFORE UPDATE ON inventory_balances
      FOR EACH ROW WHEN (NEW.location_id = '${w.wh2.id}'::uuid)
      EXECUTE FUNCTION test_injected_failure()`);
    try {
      await expect(
        inv.transferStock(
          { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.wh2.id, quantity: 30 },
          write(w.owner),
        ),
      ).rejects.toThrow(/injected failure/);
    } finally {
      await t.db.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS test_fail_destination ON inventory_balances',
      );
    }
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(100);
    expect((await balanceOf(w.x.id, w.wh2.id)).quantity).toBe(20);
    expect(await movementCount('TRANSFER_OUT')).toBe(0);
    expect(await movementCount('TRANSFER_IN')).toBe(0);
  });

  it('allows WH1 → STORE (the store is stocked by transfer)', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    await inv.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.store.id, quantity: 10 },
      write(w.owner),
    );
    expect((await balanceOf(w.x.id, w.store.id)).quantity).toBe(10);
  });

  it('rejects an actor without inventory.transfer; nothing changes', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    const actor = withoutPermission(w.owner, PERMISSIONS.inventory.transfer);
    await expect(
      inv.transferStock(
        { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.wh2.id, quantity: 10 },
        write(actor),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(100);
    expect(await movementCount('TRANSFER_OUT')).toBe(0);
  });
});

describe('reservations', () => {
  it('100 → reserve 20 → available 80; issue 90 rejected; issue 80 allowed', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    await inv.reserveStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 20, orderId: crypto.randomUUID() },
      write(w.owner),
    );
    expect(await balanceOf(w.x.id, w.wh1.id)).toMatchObject({
      quantity: 100,
      reservedQuantity: 20,
      availableQuantity: 80,
    });

    await expect(
      inv.issueStock({ variantId: w.x.id, locationId: w.wh1.id, quantity: 90 }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_STOCK' });

    await inv.issueStock({ variantId: w.x.id, locationId: w.wh1.id, quantity: 80 }, write(w.owner));
    expect(await balanceOf(w.x.id, w.wh1.id)).toMatchObject({
      quantity: 20,
      reservedQuantity: 20,
      availableQuantity: 0,
    });
  });

  it('release: quantity 100, reserved 20 → reserved 0, available 100', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    const reservation = await inv.reserveStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 20, orderId: crypto.randomUUID() },
      write(w.owner),
    );
    await inv.releaseStock({ reservationId: reservation.id }, write(w.owner));
    expect(await balanceOf(w.x.id, w.wh1.id)).toMatchObject({
      quantity: 100,
      reservedQuantity: 0,
      availableQuantity: 100,
    });
    await expect(
      inv.releaseStock({ reservationId: reservation.id }, write(w.owner)),
    ).rejects.toMatchObject({
      code: 'RESERVATION_NOT_FOUND',
    });
  });

  it('rejects reserving at the store (retail does not reserve)', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    await inv.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.store.id, quantity: 10 },
      write(w.owner),
    );
    await expect(
      inv.reserveStock(
        { variantId: w.x.id, locationId: w.store.id, quantity: 5, orderId: crypto.randomUUID() },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'MOVEMENT_NOT_ALLOWED_AT_LOCATION' });
  });
});

describe('idempotency', () => {
  it('the same key twice acts once and returns the same result', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    const ctx = write(w.owner, 'receive-key-0001');
    const input = { variantId: w.x.id, locationId: w.wh1.id, quantity: 20, unitCost: SYP(1000) };
    const first = await inv.receiveStock(input, ctx);
    const second = await inv.receiveStock(input, ctx);
    expect(second).toEqual(first);
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(120);
    expect(
      await t.db.inventoryMovement.count({ where: { idempotencyKey: 'receive-key-0001' } }),
    ).toBe(1);
  });

  it('the same key with a different request is refused', async () => {
    const ctx = write(w.owner, 'receive-key-0002');
    await inv.receiveStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 20, unitCost: SYP(1) },
      ctx,
    );
    await expect(
      inv.receiveStock(
        { variantId: w.x.id, locationId: w.wh1.id, quantity: 21, unitCost: SYP(1) },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});

describe('adjust and damage', () => {
  it('adjustments need a reason; damage writes a DAMAGE movement', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    await expect(
      inv.adjustStock(
        { variantId: w.x.id, locationId: w.wh1.id, delta: -1, reason: '' },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await inv.adjustStock(
      { variantId: w.x.id, locationId: w.wh1.id, delta: -2, reason: 'Found mislabelled' },
      write(w.owner),
    );
    await inv.damageStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 3, reason: 'Water damage' },
      write(w.owner),
    );
    expect((await balanceOf(w.x.id, w.wh1.id)).quantity).toBe(5);
    expect(await movementCount('DAMAGE')).toBe(1);
  });
});

describe('moving weighted average (SYP + USD)', () => {
  it('10 @ 1,000 SYP + 10 @ 1.00 USD (rate 13,000) → average 7,000 SYP', async () => {
    await stock(t.services, w, w.x, w.wh1, 10, SYP(1000));
    const usd = await inv.receiveStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 10, unitCost: USD(1, '13000') },
      write(w.owner),
    );
    expect(usd.movements[0]).toMatchObject({
      unitCost: { amount: 100n, currency: 'USD', rateToBase: '13000' },
      unitCostBaseAmount: 1_300_000n,
    });
    expect((await balanceOf(w.x.id, w.wh1.id)).averageCostBaseAmount).toBe(700_000n);

    // Issues leave at the average; a transfer carries the average to the destination.
    await inv.issueStock({ variantId: w.x.id, locationId: w.wh1.id, quantity: 5 }, write(w.owner));
    await inv.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.wh2.id, quantity: 5 },
      write(w.owner),
    );
    expect(await balanceOf(w.x.id, w.wh1.id)).toMatchObject({
      quantity: 10,
      averageCostBaseAmount: 700_000n,
      valueBaseAmount: 7_000_000n,
    });
    expect(await balanceOf(w.x.id, w.wh2.id)).toMatchObject({
      quantity: 5,
      averageCostBaseAmount: 700_000n,
    });
  });

  it('taking the last unit leaves zero value, with no rounding residue', async () => {
    await stock(t.services, w, w.x, w.wh1, 3, { amount: 100n, currency: 'SYP' });
    await inv.receiveStock(
      {
        variantId: w.x.id,
        locationId: w.wh1.id,
        quantity: 1,
        unitCost: { amount: 101n, currency: 'SYP' },
      },
      write(w.owner),
    );
    for (let i = 0; i < 4; i++) {
      await inv.issueStock(
        { variantId: w.x.id, locationId: w.wh1.id, quantity: 1 },
        write(w.owner),
      );
    }
    expect(await balanceOf(w.x.id, w.wh1.id)).toMatchObject({ quantity: 0, valueBaseAmount: 0n });
  });

  it('hides every cost figure from an actor without inventory.cost.view', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    const viewer = withoutPermission(w.owner, PERMISSIONS.inventory.costView);
    expect(await inv.getBalance({ variantId: w.x.id, locationId: w.wh1.id }, viewer)).toMatchObject(
      {
        quantity: 10,
        valueBaseAmount: null,
        averageCostBaseAmount: null,
      },
    );
    const [movement] = await inv.getMovements({ variantId: w.x.id }, viewer);
    expect(movement).toMatchObject({
      unitCost: null,
      unitCostBaseAmount: null,
      valueBaseAmount: null,
    });
  });
});

describe('ledger guarantees', () => {
  it('balances always equal the sum of their movements', async () => {
    await stock(t.services, w, w.x, w.wh1, 100);
    await stock(t.services, w, w.y, w.wh1, 40, USD(2.5, '13100.25'));
    await inv.transferStock(
      { variantId: w.x.id, fromLocationId: w.wh1.id, toLocationId: w.store.id, quantity: 33 },
      write(w.owner),
    );
    await inv.issueStock(
      { variantId: w.x.id, locationId: w.store.id, quantity: 7 },
      write(w.owner),
    );
    await inv.adjustStock(
      { variantId: w.y.id, locationId: w.wh1.id, delta: 3, reason: 'Found behind shelf' },
      write(w.owner),
    );
    await inv.damageStock(
      { variantId: w.y.id, locationId: w.wh1.id, quantity: 4, reason: 'Torn' },
      write(w.owner),
    );

    expect(await inv.verifyLedger()).toEqual({ balances: [], runningTotals: [] });
  });

  it('the database rejects UPDATE and DELETE on movements, whatever the caller', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    await expect(
      t.db.$executeRawUnsafe('UPDATE inventory_movements SET quantity = 999'),
    ).rejects.toThrow(/append-only/);
    await expect(t.db.$executeRawUnsafe('DELETE FROM inventory_movements')).rejects.toThrow(
      /append-only/,
    );
  });

  it('the database refuses a negative balance even if a service were bypassed', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    await expect(
      t.db.$executeRawUnsafe('UPDATE inventory_balances SET quantity = -1'),
    ).rejects.toThrow(/ck_inventory_balances/);
  });
});
