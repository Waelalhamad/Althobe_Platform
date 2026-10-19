import { toBaseAmount, type Currency } from '../../shared/money.js';
import type { Branch, DraftLine } from './accounting.types.js';

export interface ForeignBalance {
  accountId: string;
  currency: Currency;
  branch: Branch | null;
  /** Minor units of `currency`. */
  balanceCurrency: bigint;
  /** What the books say it is worth, USD cents. */
  balanceBase: bigint;
}

/**
 * Month-end revaluation (IAS 21, ADR-013): money held in SYP or LYD is restated at the closing
 * rate, and the difference goes to unrealized exchange differences. Only the USD value changes;
 * the amount of pounds or dinars does not. Returns no lines when nothing moved.
 */
export function revaluationLines(
  balances: ForeignBalance[],
  rates: Map<Currency, string>,
  fxAccountId: string,
): DraftLine[] {
  const lines: DraftLine[] = [];
  const byBranch = new Map<Branch | null, bigint>();
  for (const b of balances) {
    const rate = rates.get(b.currency);
    if (!rate) continue;
    const magnitude = toBaseAmount(
      b.balanceCurrency < 0n ? -b.balanceCurrency : b.balanceCurrency,
      b.currency,
      rate,
    );
    const target = b.balanceCurrency < 0n ? -magnitude : magnitude;
    const diff = target - b.balanceBase;
    if (diff === 0n) continue;
    lines.push({
      accountId: b.accountId,
      currency: b.currency,
      amountCurrency: 0n,
      amountBase: diff,
      rate,
      branch: b.branch,
    });
    byBranch.set(b.branch, (byBranch.get(b.branch) ?? 0n) + diff);
  }
  // The gain or loss is booked per country, so each country's profit includes its own.
  for (const [branch, total] of byBranch) {
    if (total === 0n) continue;
    lines.push({
      accountId: fxAccountId,
      currency: 'USD',
      amountCurrency: -total,
      amountBase: -total,
      rate: '1',
      branch,
    });
  }
  return lines;
}
