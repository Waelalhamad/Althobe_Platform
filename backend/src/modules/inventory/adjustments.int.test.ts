import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from '../../shared/permissions.js';
import { createTestContext, stock, USD, write, type World } from '../../../test/helpers.js';

// Developer report F-03: a manual adjustment has a fixed reason, each posting to its own account,
// and past a limit it waits for someone else before it touches stock. Neon test database.

const t = createTestContext();
const inv = t.services.inventory;
let w: World;

beforeEach(async () => {
  w = await t.reset();
  await t.services.accounting.installChart();
  await stock(t.services, w, w.x, w.wh1, 20, USD(10));
});
afterAll(async () => t.close());

const quantity = async () =>
  (await inv.getBalance({ variantId: w.x.id, locationId: w.wh1.id }, w.owner)).quantity;
const account = async (code: string) =>
  (await t.services.accounting.trialBalance({}, w.owner)).rows.find((r) => r.account.code === code)
    ?.closing ?? 0n;
const ask = async (
  delta: number,
  reasonCode: 'COUNT_DIFFERENCE' | 'DAMAGE' | 'SAMPLE' | 'INTERNAL_USE' | 'GIFT',
  note?: string,
) =>
  inv.requestAdjustment(
    { variantId: w.x.id, locationId: w.wh1.id, delta, reasonCode, ...(note ? { note } : {}) },
    write(w.owner),
  );

describe('manual adjustments (developer report F-03)', () => {
  it('each reason posts to its account; a small take-away applies at once', async () => {
    expect((await ask(-1, 'SAMPLE')).status).toBe('APPLIED');
    expect((await ask(-1, 'INTERNAL_USE')).status).toBe('APPLIED');
    expect((await ask(-1, 'DAMAGE')).status).toBe('APPLIED');
    expect((await ask(-1, 'COUNT_DIFFERENCE')).status).toBe('APPLIED');
    expect(await quantity()).toBe(16);
    expect(
      await Promise.all(['5210', '5299', '5102', '5103'].map(async (c) => account(c))),
    ).toEqual([1_000n, 1_000n, 1_000n, 1_000n]);
  });

  it('an increase, or a bigger take-away, waits for a second person and changes nothing until then', async () => {
    const up = await ask(2, 'COUNT_DIFFERENCE', 'لقيناهم بالرف');
    expect(up.status).toBe('PENDING');
    const out = await ask(-5, 'COUNT_DIFFERENCE');
    expect(out.status).toBe('PENDING');
    expect(await quantity()).toBe(20);
    expect(await account('5103')).toBe(0n);

    // The asker cannot approve their own.
    await expect(inv.approveAdjustment(up.requestId!, {}, write(w.owner))).rejects.toMatchObject({
      code: 'SELF_APPROVAL',
    });
    await inv.approveAdjustment(up.requestId!, {}, write(w.approver));
    expect(await quantity()).toBe(22);
    await expect(inv.approveAdjustment(up.requestId!, {}, write(w.approver))).rejects.toMatchObject(
      { code: 'ADJUSTMENT_NOT_PENDING' },
    );
    await inv.rejectAdjustment(out.requestId!, { note: 'عدّ مرة تانية' }, write(w.approver));
    expect(await quantity()).toBe(22);
    const listed = await inv.listAdjustmentRequests({}, w.owner);
    expect(listed.map((r) => r.status).sort()).toEqual(['APPROVED', 'REJECTED']);
  });

  it('with nobody else who may approve, the asker decides alone, and it says so', async () => {
    await t.db.user.update({ where: { id: w.approver.userId }, data: { isActive: false } });
    const up = await ask(2, 'COUNT_DIFFERENCE', 'لقيناهم');
    const listed = await inv.listAdjustmentRequests({ status: 'PENDING' }, w.owner);
    expect(listed[0]).toMatchObject({ decideAlone: true });
    await inv.approveAdjustment(up.requestId!, {}, write(w.owner));
    expect(await quantity()).toBe(22);
    const [done] = await inv.listAdjustmentRequests({ status: 'APPROVED' }, w.owner);
    expect(done).toMatchObject({ selfApproved: true });
    expect(done!.decisionNote).toMatch(/لحالو/);
  });

  it('refuses a reason outside the list, an increase that is not a count, and a gift (F-06 has its own)', async () => {
    for (const bad of [
      { delta: -1, reasonCode: 'خطأ إدخال' },
      { delta: 1, reasonCode: 'DAMAGE' },
      { delta: -1, reasonCode: 'GIFT' },
    ]) {
      await expect(
        inv.requestAdjustment(
          { variantId: w.x.id, locationId: w.wh1.id, ...bad } as never,
          write(w.owner),
        ),
      ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
});

describe('«تراجع»: the owner undoes an adjustment or a damage write-off exactly', () => {
  const undo = async (id: string, actor = w.owner, reason = 'انعمل بالغلط') =>
    inv.undoMovement(id, { reason }, write(actor));
  const value = async () =>
    (await inv.getBalance({ variantId: w.x.id, locationId: w.wh1.id }, w.owner)).valueBaseAmount;

  it('puts stock and the books back at the original value, not today’s average', async () => {
    const out = await ask(-1, 'COUNT_DIFFERENCE');
    // A dearer delivery moves the average; the undo still returns exactly what left.
    await stock(t.services, w, w.x, w.wh1, 10, USD(20));
    const before = await value();
    const result = await undo(out.movements[0]!.id);
    expect(result.movements[0]).toMatchObject({ quantity: 1, valueBaseAmount: 1_000n });
    expect(await quantity()).toBe(30);
    expect(await value()).toBe(before! + 1_000n);
    expect(await account('5103')).toBe(0n);

    const damaged = await inv.damageStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 2, reason: 'انكب عليها شاي' },
      write(w.owner),
    );
    await undo(damaged.movements[0]!.id);
    expect(await quantity()).toBe(30);
    expect(await account('5102')).toBe(0n);

    const history = await inv.getMovementHistory({ variantId: w.x.id }, w.owner);
    const undone = history.filter((r) => r.undoneById).map((r) => r.movement.id);
    expect(undone.sort()).toEqual([out.movements[0]!.id, damaged.movements[0]!.id].sort());
  });

  it('only once, never an undo, and only manual adjustments and damage', async () => {
    const out = await ask(-1, 'SAMPLE');
    const first = await undo(out.movements[0]!.id);
    await expect(undo(out.movements[0]!.id)).rejects.toMatchObject({
      code: 'MOVEMENT_NOT_UNDOABLE',
    });
    await expect(undo(first.movements[0]!.id)).rejects.toMatchObject({
      code: 'MOVEMENT_NOT_UNDOABLE',
    });
    const [received] = (await inv.getMovements({ variantId: w.x.id }, w.owner)).filter(
      (m) => m.quantity === 20,
    );
    await expect(undo(received!.id)).rejects.toMatchObject({ code: 'MOVEMENT_NOT_UNDOABLE' });
    await expect(undo(out.movements[0]!.id, w.owner, '')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('refuses when the pieces it would take back are gone', async () => {
    const up = await ask(2, 'COUNT_DIFFERENCE');
    const approved = await inv.approveAdjustment(up.requestId!, {}, write(w.approver));
    await inv.issueStock(
      { variantId: w.x.id, locationId: w.wh1.id, quantity: 22, referenceType: 'MANUAL' },
      write(w.owner),
    );
    await expect(undo(approved.movementId!)).rejects.toMatchObject({
      code: 'MOVEMENT_UNDO_NOT_POSSIBLE',
    });
    expect(await quantity()).toBe(0);
  });

  it('is the owner’s alone', async () => {
    const out = await ask(-1, 'COUNT_DIFFERENCE');
    const manager = {
      userId: w.approver.userId,
      permissions: new Set(ALL_PERMISSIONS.filter((p) => !p.startsWith('admin.'))),
    };
    await expect(undo(out.movements[0]!.id, manager)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await quantity()).toBe(19);
  });
});
