import { describe, expect, it } from 'vitest';
import { divRoundHalfUp, rateToMicros, toBaseAmount, unitCostSchema } from './money.js';

describe('money (ADR-004)', () => {
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

  it('converts 1.00 USD at 13,000 to 13,000.00 SYP', () => {
    expect(toBaseAmount(100n, '13000')).toBe(1_300_000n);
  });

  it('keeps SYP amounts unchanged at rate 1', () => {
    expect(toBaseAmount(100_000n, '1')).toBe(100_000n);
  });

  it('requires a rate for USD, and fixes the SYP rate at 1', () => {
    expect(unitCostSchema.safeParse({ amount: 100n, currency: 'USD' }).success).toBe(false);
    expect(
      unitCostSchema.safeParse({ amount: 100n, currency: 'SYP', rateToBase: '2' }).success,
    ).toBe(false);
    expect(unitCostSchema.parse({ amount: 100n, currency: 'SYP' })).toEqual({
      amount: 100n,
      currency: 'SYP',
      rateToBase: '1',
    });
  });

  it('accepts amounts as digit strings, the way they cross the API', () => {
    expect(
      unitCostSchema.parse({ amount: '150', currency: 'USD', rateToBase: '13000' }).amount,
    ).toBe(150n);
    expect(
      unitCostSchema.safeParse({ amount: '1.5', currency: 'USD', rateToBase: '13000' }).success,
    ).toBe(false);
    expect(unitCostSchema.safeParse({ amount: -1n, currency: 'SYP' }).success).toBe(false);
  });
});
