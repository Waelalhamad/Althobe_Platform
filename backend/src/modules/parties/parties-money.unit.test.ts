import { describe, expect, it } from 'vitest';
import { settledBase } from './parties-money.js';

describe('settling what a party owes (ADR-016)', () => {
  it('takes the carried value off in proportion, and all of it when it is all paid', () => {
    // 2,050 ₺ owed, carried at 50.00 $: 1,000 ₺ takes 24.39 $ off, whatever it is worth today.
    expect(settledBase(205_000n, 5_000n, 100_000n, 2_500n)).toBe(2_439n);
    expect(settledBase(205_000n, 5_000n, 205_000n, 9_999n)).toBe(5_000n);
  });

  it("values a payment beyond the balance, or with nothing owed, at today's rate", () => {
    expect(settledBase(0n, 0n, 1_000n, 25n)).toBe(25n);
    // 100 owed at 10 $, 200 paid worth 40 $ today: 10 $ for the debt, 20 $ ahead.
    expect(settledBase(100n, 1_000n, 200n, 4_000n)).toBe(3_000n);
  });
});
