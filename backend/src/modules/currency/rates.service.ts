import { z } from 'zod';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db } from '../../shared/db.js';
import { rateSchema } from '../../shared/money.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';

/** ADR-012: the currencies with a rate against the dollar (the base, always 1). */
export const RATE_CURRENCIES = ['SYP', 'LYD', 'TRY'] as const;
export type RateCurrency = (typeof RATE_CURRENCIES)[number];

export const setRateSchema = z.object({
  currency: z.enum(RATE_CURRENCIES),
  /** Units of the currency per 1 USD, e.g. "122" (new Syrian pounds since 2026-01-01). */
  rate: rateSchema,
  /** The central bank's rate, kept for reference (ADR-013). Omit to keep it; null clears it. */
  officialRate: rateSchema.nullable().optional(),
});

export interface RateView {
  currency: RateCurrency;
  /** Units per 1 USD; null until the owner sets it. */
  rate: string | null;
  /** The central bank's rate, for reference only. */
  officialRate: string | null;
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
          officialRate: row?.officialRate?.toString() ?? null,
          updatedAt: row?.updatedAt ?? null,
        };
      });
    },

    /**
     * The rates that applied at `moment` (the last one set before it, per currency): what
     * closing a month revalues at. Null for a currency with no rate set by then.
     */
    async ratesAt(moment: Date): Promise<Map<RateCurrency, string>> {
      const out = new Map<RateCurrency, string>();
      for (const currency of RATE_CURRENCIES) {
        const row = await db.exchangeRateHistory.findFirst({
          where: { currency, setAt: { lt: moment } },
          orderBy: { setAt: 'desc' },
        });
        if (row) out.set(currency, row.rate.toString());
      }
      return out;
    },

    /** Who set each rate, from when: newest first. */
    async rateHistory(ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.accounting.view);
      const rows = await db.exchangeRateHistory.findMany({
        orderBy: { setAt: 'desc' },
        take: 200,
        include: { setBy: { select: { nameAr: true } } },
      });
      return rows.map((r) => ({
        currency: r.currency as RateCurrency,
        rate: r.rate.toString(),
        officialRate: r.officialRate?.toString() ?? null,
        setBy: r.setBy.nameAr,
        setAt: r.setAt,
      }));
    },

    async setRate(input: z.input<typeof setRateSchema>, ctx: ActorContext): Promise<RateView> {
      assertPermission(ctx, PERMISSIONS.admin.rates);
      const data = parse(setRateSchema, input);
      return inTransaction(db, async (tx) => {
        const before = await tx.exchangeRate.findUnique({ where: { currency: data.currency } });
        const official = data.officialRate === undefined ? {} : { officialRate: data.officialRate };
        const row = await tx.exchangeRate.upsert({
          where: { currency: data.currency },
          create: { currency: data.currency, rate: data.rate, updatedBy: ctx.userId, ...official },
          update: { rate: data.rate, updatedBy: ctx.userId, updatedAt: new Date(), ...official },
        });
        await tx.exchangeRateHistory.create({
          data: {
            currency: data.currency,
            rate: data.rate,
            officialRate: row.officialRate,
            setById: ctx.userId,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'rates.set',
          entityType: 'exchange_rate',
          before: before
            ? {
                currency: before.currency,
                rate: before.rate.toString(),
                officialRate: before.officialRate?.toString() ?? null,
              }
            : null,
          after: {
            currency: data.currency,
            rate: row.rate.toString(),
            officialRate: row.officialRate?.toString() ?? null,
          },
        });
        return {
          currency: data.currency,
          rate: row.rate.toString(),
          officialRate: row.officialRate?.toString() ?? null,
          updatedAt: row.updatedAt,
        };
      });
    },
  };
}

export type RatesService = ReturnType<typeof createRatesService>;
