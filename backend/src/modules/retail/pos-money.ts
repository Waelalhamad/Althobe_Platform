import { divRoundHalfUp, EXPONENT, rateToMicros, type Currency } from '../../shared/money.js';

/** What the store drawer holds and is paid in (ADR-014). Change is always given in SYP. */
export const DRAWER_CURRENCIES = ['SYP', 'USD', 'TRY'] as const;
export type DrawerCurrency = (typeof DRAWER_CURRENCIES)[number];

/** Units of each currency per 1 USD; USD is 1. */
export type Rates = Partial<Record<Currency, string>>;

/**
 * `amount` (minor units of `currency`) in SYP minor units, through the dollar rates:
 * syp = amount × (SYP per USD ÷ currency per USD), rounded half away from zero.
 */
export function toSyp(amount: bigint, currency: DrawerCurrency, rates: Rates): bigint {
  if (currency === 'SYP') return amount;
  const syp = rateToMicros(rates.SYP!);
  const own = currency === 'USD' ? 1_000_000n : rateToMicros(rates[currency]!);
  return divRoundHalfUp(
    amount * syp * 10n ** BigInt(EXPONENT.SYP),
    own * 10n ** BigInt(EXPONENT[currency]),
  );
}

/**
 * Spreads an invoice discount over its lines in proportion to their totals, so each line knows
 * what it was really sold for (a refund gives back that, not the list price). The shares sum to
 * the discount exactly: the cents left by rounding down go to the largest remainders.
 */
export function netTotals(lineTotals: bigint[], discount: bigint): bigint[] {
  const subtotal = lineTotals.reduce((s, t) => s + t, 0n);
  if (discount === 0n || subtotal === 0n) return [...lineTotals];
  const shares = lineTotals.map((t) => (t * discount) / subtotal);
  const remainders = lineTotals.map((t, i) => ({ i, r: (t * discount) % subtotal }));
  let left = discount - shares.reduce((s, x) => s + x, 0n);
  remainders.sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i));
  for (const { i } of remainders) {
    if (left === 0n) break;
    shares[i]! += 1n;
    left -= 1n;
  }
  return lineTotals.map((t, i) => t - shares[i]!);
}

/**
 * What refunding `quantity` more pieces of a line gives back, when `already` were refunded
 * before: cumulative shares, so refunding every piece returns the line's net total exactly.
 */
export function refundValue(
  netTotal: bigint,
  sold: number,
  already: number,
  quantity: number,
): bigint {
  const upTo = (n: number) => (netTotal * BigInt(n)) / BigInt(sold);
  return upTo(already + quantity) - upTo(already);
}
