import type { Currency } from '../../shared/money.js';
import type { Branch } from './accounting.types.js';

// What payroll (ADR-015) hands the books. Amounts are minor units of `currency`; *Base are USD
// cents. The accounting service turns these into entries; payroll never builds journal lines.

export interface AdvanceCashPosting {
  kind: 'GIVE' | 'REPAY';
  /** The employee_advances row: one entry per row. */
  sourceId: string;
  boxId: string;
  currency: Currency;
  amount: bigint;
  /** REPAY: the USD value this part of the advance was carried at. */
  clearedBase?: bigint;
  branch: Branch;
  memo: string;
  createdById: string;
}

export interface PayrollAccrualPosting {
  runId: string;
  entryDate: string;
  memo: string;
  createdById: string;
  lines: {
    currency: Currency;
    branch: Branch;
    memo: string;
    /** Salary + bonus − deduction: the expense. */
    gross: bigint;
    /** Taken back from advances, and the USD value it was carried at. */
    advanceAmount: bigint;
    advanceBase: bigint;
    /** gross − advanceAmount: owed to the employee. */
    net: bigint;
  }[];
}

export interface PayrollPaymentPosting {
  paymentId: string;
  boxId: string;
  currency: Currency;
  memo: string;
  createdById: string;
  items: { net: bigint; netBase: bigint; branch: Branch; memo: string }[];
}
