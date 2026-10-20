import { describe, expect, it } from 'vitest';
import { advanceBalance, clearedBase, netPay, periodOf } from './payroll-money.js';

describe('payroll money (ADR-015)', () => {
  it('net pay is salary plus bonus, less the deduction and the advance taken back', () => {
    expect(netPay({ salary: 1000n, bonus: 200n, deduction: 50n, advanceDeduct: 300n })).toBe(850n);
  });

  it('clears an advance in proportion, and the whole balance exactly', () => {
    // 300 owed, carried at 1.00 $ … 2.00 $ over time: 7 cents, not a rounding remainder.
    expect(clearedBase(300n, 7n, 100n)).toBe(2n);
    expect(clearedBase(300n, 7n, 300n)).toBe(7n);
    expect(clearedBase(0n, 0n, 0n)).toBe(0n);
  });

  it('sums an advance balance from its movements', () => {
    expect(
      advanceBalance([
        { kind: 'GIVEN', amount: 500n, amountBase: 50n },
        { kind: 'DEDUCTED', amount: 200n, amountBase: 20n },
        { kind: 'RESTORED', amount: 200n, amountBase: 20n },
        { kind: 'REPAID', amount: 100n, amountBase: 10n },
      ]),
    ).toEqual({ amount: 400n, base: 40n });
  });

  it('a month runs to its last day; a week runs seven days', () => {
    expect(periodOf({ frequency: 'MONTHLY', period: '2026-02' })).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
    expect(periodOf({ frequency: 'WEEKLY', weekStart: '2026-10-31' })).toEqual({
      start: '2026-10-31',
      end: '2026-11-06',
    });
  });
});
