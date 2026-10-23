import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
    expect((await ask(-1, 'GIFT', 'شركة الشحن')).status).toBe('APPLIED');
    expect((await ask(-1, 'COUNT_DIFFERENCE')).status).toBe('APPLIED');
    expect(await quantity()).toBe(15);
    expect(
      await Promise.all(['5210', '5299', '5102', '5212', '5103'].map(async (c) => account(c))),
    ).toEqual([1_000n, 1_000n, 1_000n, 1_000n, 1_000n]);
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

  it('refuses a reason outside the list, an increase that is not a count, and a gift with no name', async () => {
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
