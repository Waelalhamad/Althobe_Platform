import type { Currency } from '../../shared/money.js';
import type { Branch, SystemRole, VoucherType } from './accounting.types.js';

// What the parties module (ADR-016) hands the books. Amounts are signed, debit positive: minor
// units of their currency; *base are USD cents.

export interface PartyPosting {
  /** 1103 (customers owe us) or 2101 (we owe suppliers). */
  side: 'RECEIVABLE' | 'PAYABLE';
  /** The control account's line, at the value the party detail carries. */
  control: { currency: Currency; amount: bigint; base: bigint };
  /** A box, valued at today's rate; or an account by role, at a USD value. */
  other: { boxId: string; amount: bigint } | { role: SystemRole; base: bigint };
  voucherType: VoucherType;
  sourceType: string;
  sourceId: string;
  branch: Branch;
  memo: string;
  lineMemo?: string;
  createdById: string;
}
