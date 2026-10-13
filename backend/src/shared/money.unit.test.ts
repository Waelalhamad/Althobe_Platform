import { describe, expect, it } from 'vitest';
import { divRoundHalfUp, rateToMicros, toBaseAmount, unitCostSchema } from './money.js';

describe('money (ADR-004, ADR-012)', () => {
  it('rounds half away from zero', () => {
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(divRoundHalfUp(4n, 3n)).toBe(1n);
    expect(divRoundHalfUp(5n, 3n)).toBe(2n);
    expect(divRoundHalfUp(-5n, 2n)).toBe(-3n);
    expect(divRoundHalfUp(0n, 7n)).toBe(0n);
  });

  it('parses rates to micro-units without floating point', () => {
    expect(rateToMicros('1')).toBe(1_000_000n);
    expect(rateToMicros('13000')).toBe(13_000_000_000n);
    expect(rateToMicros('13000.5')).toBe(13_000_500_000n);
    expect(rateToMicros('0.000001')).toBe(1n);
  });

  it('converts 13,000.00 SYP at 13,000 per dollar to 1.00 USD', () => {
    expect(toBaseAmount(1_300_000n, 'SYP', '13000')).toBe(100n);
  });

  it('converts Libyan dinars with their 3 decimals: 7.000 LYD at 7 per dollar is 1.00 USD', () => {
    expect(toBaseAmount(7_000n, 'LYD', '7')).toBe(100n);
    expect(toBaseAmount(1n, 'LYD', '1')).toBe(0n);
  });

  it('keeps USD amounts unchanged at rate 1', () => {
    expect(toBaseAmount(1_765n, 'USD', '1')).toBe(1_765n);
  });

  it('requires a rate for SYP and LYD, and fixes the USD rate at 1', () => {
    expect(unitCostSchema.safeParse({ amount: 100n, currency: 'SYP' }).success).toBe(false);
    expect(unitCostSchema.safeParse({ amount: 100n, currency: 'LYD' }).success).toBe(false);
    expect(
      unitCostSchema.safeParse({ amount: 100n, currency: 'USD', rateToBase: '2' }).success,
    ).toBe(false);
    expect(unitCostSchema.parse({ amount: 100n, currency: 'USD' })).toEqual({
      amount: 100n,
      currency: 'USD',
      rateToBase: '1',
    });
  });

  it('accepts amounts as digit strings, the way they cross the API', () => {
    expect(
      unitCostSchema.parse({ amount: '150', currency: 'SYP', rateToBase: '13000' }).amount,
    ).toBe(150n);
    expect(
      unitCostSchema.safeParse({ amount: '1.5', currency: 'SYP', rateToBase: '13000' }).success,
    ).toBe(false);
    expect(unitCostSchema.safeParse({ amount: -1n, currency: 'USD' }).success).toBe(false);
  });
});
