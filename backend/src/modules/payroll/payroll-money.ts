import { divRoundHalfUp } from '../../shared/money.js';

/** Salary + bonus − deduction: the period's expense. */
export function grossPay(l: { salary: bigint; bonus: bigint; deduction: bigint }): bigint {
  return l.salary + l.bonus - l.deduction;
}

/** What the employee is handed: gross less what is taken back from advances. */
export function netPay(l: {
  salary: bigint;
  bonus: bigint;
  deduction: bigint;
  advanceDeduct: bigint;
}): bigint {
  return grossPay(l) - l.advanceDeduct;
}

/**
 * The USD value carried by `part` of an advance balance worth `balanceBase`: proportional, and
 * the whole balance clears exactly, so 1104 reaches zero when the employee owes nothing.
 */
export function clearedBase(balance: bigint, balanceBase: bigint, part: bigint): bigint {
  if (part === balance) return balanceBase;
  if (balance === 0n) return 0n;
  return divRoundHalfUp(balanceBase * part, balance);
}

/** A pay period's first and last days: a calendar month, or seven days from `weekStart`. */
export function periodOf(
  input: { frequency: 'MONTHLY'; period: string } | { frequency: 'WEEKLY'; weekStart: string },
): { start: string; end: string } {
  if (input.frequency === 'MONTHLY') {
    const [year, month] = input.period.split('-').map(Number) as [number, number];
    return {
      start: `${input.period}-01`,
      end: new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10),
    };
  }
  const start = new Date(`${input.weekStart}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { start: input.weekStart, end: end.toISOString().slice(0, 10) };
}

/** Each employee's advance balance from their GIVEN / REPAID / DEDUCTED / RESTORED rows. */
export function advanceBalance(rows: { kind: string; amount: bigint; amountBase: bigint }[]): {
  amount: bigint;
  base: bigint;
} {
  let amount = 0n;
  let base = 0n;
  for (const r of rows) {
    const sign = r.kind === 'GIVEN' || r.kind === 'RESTORED' ? 1n : -1n;
    amount += sign * r.amount;
    base += sign * r.amountBase;
  }
  return { amount, base };
}
