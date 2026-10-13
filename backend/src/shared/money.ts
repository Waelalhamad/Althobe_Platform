import { z } from 'zod';

// ADR-004 / ADR-012: integer minor units with each currency's ISO 4217 exponent, base (reporting)
// currency USD. Nothing in this file ever touches a floating-point number.
export const CURRENCIES = ['SYP', 'USD', 'LYD'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const BASE_CURRENCY = 'USD' satisfies Currency;

/** Decimal places: the Libyan dinar has 1000 dirhams, the others 100 subunits. */
export const EXPONENT: Record<Currency, number> = { SYP: 2, USD: 2, LYD: 3 };

// Rates are held as a decimal string with at most 6 fractional digits ("13000", "13000.5"),
// matching numeric(18,6) in the database. A rate is units of the currency per 1 USD.
const RATE_SCALE = 1_000_000n;
const RATE_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;

export const currencySchema = z.enum(CURRENCIES);
export const minorAmountSchema = z
  .union([z.bigint(), z.string().regex(/^\d{1,18}$/, 'Expected minor units as digits')])
  .transform((value) => BigInt(value))
  .refine((value) => value >= 0n, 'Amount cannot be negative');
export const rateSchema = z
  .string()
  .regex(RATE_PATTERN, 'Expected a positive rate with at most 6 decimals')
  // Zod runs this even after the pattern fails: a malformed rate must not reach rateToMicros.
  .refine(
    (value) => RATE_PATTERN.test(value) && rateToMicros(value) > 0n,
    'Rate must be greater than zero',
  );

/**
 * A unit cost as entered: amount in minor units of `currency`, and the rate in force (units of
 * that currency per 1 USD; always 1 for USD).
 */
export const unitCostSchema = z
  .object({
    amount: minorAmountSchema,
    currency: currencySchema,
    rateToBase: rateSchema.optional(),
  })
  .transform((cost, ctx) => {
    if (cost.currency === BASE_CURRENCY) {
      if (cost.rateToBase !== undefined && rateToMicros(cost.rateToBase) !== RATE_SCALE) {
        ctx.addIssue({ code: 'custom', message: `The rate for ${BASE_CURRENCY} must be 1` });
      }
      return { amount: cost.amount, currency: cost.currency, rateToBase: '1' };
    }
    if (cost.rateToBase === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: `An exchange rate is required for ${cost.currency}`,
      });
      return z.NEVER;
    }
    return { amount: cost.amount, currency: cost.currency, rateToBase: cost.rateToBase };
  });

export type UnitCost = z.output<typeof unitCostSchema>;
export type UnitCostInput = z.input<typeof unitCostSchema>;

export function rateToMicros(rate: string): bigint {
  const [whole = '0', fraction = ''] = rate.split('.');
  return BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(6, '0'));
}

/** Integer division rounded half away from zero. */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = (n * 2n + d) / (d * 2n);
  return negative ? -quotient : quotient;
}

/**
 * Minor units of `currency` → USD cents, at `rate` units of that currency per 1 USD:
 * cents = amount × 10^(2 − exponent) ÷ rate.
 */
export function toBaseAmount(amount: bigint, currency: Currency, rate: string): bigint {
  const scale = 10n ** BigInt(EXPONENT[currency]);
  return divRoundHalfUp(amount * 100n * RATE_SCALE, scale * rateToMicros(rate));
}
