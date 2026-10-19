import { describe, expect, it } from 'vitest';
import { netTotals, refundValue, toSyp } from './pos-money.js';

// SYP 122 per dollar, TRY 41 per dollar.
const rates = { SYP: '122', USD: '1', TRY: '41' };

describe('POS money (ADR-014)', () => {
  it('values dollars and Turkish lira in Syrian pounds through the dollar rates', () => {
    expect(toSyp(10_000n, 'USD', rates)).toBe(1_220_000n); // 100.00 $ = 12,200.00 ل.س
    expect(toSyp(4_100n, 'TRY', rates)).toBe(12_200n); // 41.00 ₺ = 1 $ = 122.00 ل.س
    expect(toSyp(500n, 'SYP', rates)).toBe(500n);
  });

  it('rounds a Turkish-lira payment to the nearest Syrian piastre', () => {
    // 1.00 ₺ = 122 / 41 = 2.9756… ل.س
    expect(toSyp(100n, 'TRY', rates)).toBe(298n);
  });

  it('spreads a discount over the lines exactly, by size', () => {
    expect(netTotals([30_000n, 10_000n], 4_000n)).toEqual([27_000n, 9_000n]);
    const nets = netTotals([100n, 100n, 100n], 100n);
    expect(nets.reduce((s, n) => s + n, 0n)).toBe(200n);
    expect(netTotals([5_000n], 0n)).toEqual([5_000n]);
  });

  it('refunds pieces of a line in parts that add up to what the line was sold for', () => {
    // 3 pieces sold for 100 together: refunded one by one, they give back 33 + 33 + 34.
    const parts = [
      refundValue(100n, 3, 0, 1),
      refundValue(100n, 3, 1, 1),
      refundValue(100n, 3, 2, 1),
    ];
    expect(parts.reduce((s, p) => s + p, 0n)).toBe(100n);
    expect(refundValue(100n, 3, 0, 3)).toBe(100n);
  });
});
