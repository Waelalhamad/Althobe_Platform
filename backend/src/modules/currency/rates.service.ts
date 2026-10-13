import { z } from 'zod';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db } from '../../shared/db.js';
import { rateSchema } from '../../shared/money.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';

/** ADR-012: the currencies with a rate against the dollar (the base, always 1). */
export const RATE_CURRENCIES = ['SYP', 'LYD'] as const;
export type RateCurrency = (typeof RATE_CURRENCIES)[number];

export const setRateSchema = z.object({
  currency: z.enum(RATE_CURRENCIES),
  /** Units of the currency per 1 USD, e.g. "14000". */
  rate: rateSchema,
});

export interface RateView {
  currency: RateCurrency;
  /** Units per 1 USD; null until the owner sets it. */
  rate: string | null;
  updatedAt: Date | null;
}

export function createRatesService(db: Db) {
  return {
    /** Everyone signed in may read the rates: whoever enters a cost needs them. */
    async listRates(): Promise<RateView[]> {
      const rows = await db.exchangeRate.findMany();
      return RATE_CURRENCIES.map((currency) => {
        const row = rows.find((r) => r.currency === currency);
        return {
          currency,
          rate: row ? row.rate.toString() : null,
          updatedAt: row?.updatedAt ?? null,
        };
      });
    },

    async setRate(input: z.input<typeof setRateSchema>, ctx: ActorContext): Promise<RateView> {
      assertPermission(ctx, PERMISSIONS.admin.rates);
      const data = parse(setRateSchema, input);
      return inTransaction(db, async (tx) => {
        const before = await tx.exchangeRate.findUnique({ where: { currency: data.currency } });
        const row = await tx.exchangeRate.upsert({
          where: { currency: data.currency },
          create: { currency: data.currency, rate: data.rate, updatedBy: ctx.userId },
          update: { rate: data.rate, updatedBy: ctx.userId, updatedAt: new Date() },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'rates.set',
          entityType: 'exchange_rate',
          before: before ? { currency: before.currency, rate: before.rate.toString() } : null,
          after: { currency: data.currency, rate: row.rate.toString() },
        });
        return { currency: data.currency, rate: row.rate.toString(), updatedAt: row.updatedAt };
      });
    },
  };
}
