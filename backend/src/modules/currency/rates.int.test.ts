import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createTestContext, withoutPermission, type World } from '../../../test/helpers.js';

const t = createTestContext();
const rates = t.services.rates;
let w: World;

beforeEach(async () => {
  w = await t.reset();
});
afterAll(async () => t.close());

describe('exchange rates (ADR-012)', () => {
  it('start empty; the owner sets and changes them, and each change is audited', async () => {
    expect(await rates.listRates()).toEqual([
      { currency: 'SYP', rate: null, updatedAt: null },
      { currency: 'LYD', rate: null, updatedAt: null },
    ]);
    await rates.setRate({ currency: 'SYP', rate: '14000' }, w.owner);
    await rates.setRate({ currency: 'SYP', rate: '13500.5' }, w.owner);
    await rates.setRate({ currency: 'LYD', rate: '7.25' }, w.owner);

    const list = await rates.listRates();
    expect(list.map((r) => [r.currency, r.rate])).toEqual([
      ['SYP', '13500.5'],
      ['LYD', '7.25'],
    ]);
    expect(await t.db.auditLog.count({ where: { action: 'rates.set' } })).toBe(3);
  });

  it('refuses a zero or malformed rate, USD, and anyone without admin.rates.write', async () => {
    await expect(rates.setRate({ currency: 'SYP', rate: '0' }, w.owner)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(rates.setRate({ currency: 'SYP', rate: '1,000' }, w.owner)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      rates.setRate({ currency: 'USD' as never, rate: '1' }, w.owner),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      rates.setRate(
        { currency: 'SYP', rate: '14000' },
        withoutPermission(w.owner, PERMISSIONS.admin.rates),
      ),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect((await rates.listRates())[0]!.rate).toBeNull();
  });
});
