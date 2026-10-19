import { Prisma } from '@prisma/client';
import type { Queryable, Tx } from '../../shared/db.js';
import { uuidv7 } from '../../shared/ids.js';
import {
  divRoundHalfUp,
  EXPONENT,
  rateToMicros,
  toBaseAmount,
  type Currency,
} from '../../shared/money.js';
import { EntryNotBalancedError, PeriodClosedError } from './accounting.errors.js';
import type { DraftEntry, DraftLine } from './accounting.types.js';

/**
 * The only code that writes journal_entries and journal_lines (ADR-013). Must run inside the
 * caller's transaction. The database checks the same rules again (balance, append-only, closed
 * months, account currency); these checks are here to give a clear error instead of a crash.
 */
export async function postEntries(tx: Tx, drafts: DraftEntry[]): Promise<string[]> {
  if (drafts.length === 0) return [];
  for (const draft of drafts) assertBalanced(draft);

  const closedThrough = await closedThroughDate(tx);
  if (closedThrough) {
    const inClosed = drafts.find((d) => d.entryDate <= closedThrough);
    if (inClosed) throw new PeriodClosedError(inClosed.entryDate, closedThrough);
  }

  const numbers = await allocateNumbers(tx, drafts);
  const ids = drafts.map(() => uuidv7());

  await tx.journalEntry.createMany({
    data: drafts.map((d, i) => ({
      id: ids[i]!,
      voucherType: d.voucherType,
      voucherYear: numbers[i]!.year,
      voucherNo: numbers[i]!.no,
      entryDate: asDate(d.entryDate),
      memo: d.memo ?? null,
      sourceType: d.sourceType ?? null,
      sourceId: d.sourceId ?? null,
      reversesId: d.reversesId ?? null,
      createdById: d.createdById,
    })),
  });
  await tx.journalLine.createMany({
    data: drafts.flatMap((d, i) =>
      d.lines.map((line, n) => ({
        id: uuidv7(),
        entryId: ids[i]!,
        lineNo: n + 1,
        accountId: line.accountId,
        amountBase: line.amountBase,
        currency: line.currency,
        amountCurrency: line.amountCurrency,
        rate: line.rate,
        branch: line.branch ?? null,
        locationId: line.locationId ?? null,
        memo: line.memo ?? null,
      })),
    ),
  });
  return ids;
}

export function assertBalanced(draft: DraftEntry): void {
  const total = draft.lines.reduce((sum, l) => sum + l.amountBase, 0n);
  if (draft.lines.length < 2 || total !== 0n) throw new EntryNotBalancedError(total);
}

/** The last day of the last closed month, or null when no month is closed yet. */
export async function closedThroughDate(q: Queryable): Promise<string | null> {
  const last = await q.accountingPeriod.findFirst({ orderBy: { endsOn: 'desc' } });
  return last ? isoDate(last.endsOn) : null;
}

/**
 * Gap-free numbers per voucher type and year. The counter row stays locked until the caller
 * commits, so a rollback gives the numbers back and two posters never share one.
 */
async function allocateNumbers(tx: Tx, drafts: DraftEntry[]) {
  const wanted = new Map<string, number>();
  for (const d of drafts) {
    const key = `${d.voucherType}|${d.entryDate.slice(0, 4)}`;
    wanted.set(key, (wanted.get(key) ?? 0) + 1);
  }
  const next = new Map<string, number>();
  for (const [key, count] of wanted) {
    const [type, year] = key.split('|') as [string, string];
    const [row] = await tx.$queryRaw<{ last_no: number }[]>(Prisma.sql`
      INSERT INTO "voucher_counters" ("voucher_type", "voucher_year", "last_no")
      VALUES (${type}, ${Number(year)}, ${count})
      ON CONFLICT ("voucher_type", "voucher_year")
      DO UPDATE SET "last_no" = "voucher_counters"."last_no" + ${count}
      RETURNING "last_no"`);
    next.set(key, row!.last_no - count + 1);
  }
  return drafts.map((d) => {
    const key = `${d.voucherType}|${d.entryDate.slice(0, 4)}`;
    const no = next.get(key)!;
    next.set(key, no + 1);
    return { year: Number(d.entryDate.slice(0, 4)), no };
  });
}

// ─── Building lines ──────────────────────────────────────────────────────────────────────────

/** A line of `amount` (signed minor units of `currency`) at `rate`, with its USD value. */
export function line(
  accountId: string,
  currency: Currency,
  amount: bigint,
  rate: string,
  extra: Pick<DraftLine, 'branch' | 'locationId' | 'memo'> = {},
): DraftLine {
  const base =
    currency === 'USD'
      ? amount
      : amount < 0n
        ? -toBaseAmount(-amount, currency, rate)
        : toBaseAmount(amount, currency, rate);
  return {
    accountId,
    currency,
    amountCurrency: amount,
    amountBase: base,
    rate: currency === 'USD' ? '1' : rate,
    ...extra,
  };
}

/** A line worth exactly `base` USD cents, holding `amount` of `currency`; its rate follows. */
export function lineAtBase(
  accountId: string,
  currency: Currency,
  amount: bigint,
  base: bigint,
  extra: Pick<DraftLine, 'branch' | 'locationId' | 'memo'> = {},
): DraftLine {
  if (currency === 'USD')
    return { accountId, currency, amountCurrency: base, amountBase: base, rate: '1', ...extra };
  return {
    accountId,
    currency,
    amountCurrency: amount,
    amountBase: base,
    rate: impliedRate(amount, currency, base),
    ...extra,
  };
}

/** Units of `currency` per 1 USD implied by `amount` (minor units) being worth `base` cents. */
export function impliedRate(amount: bigint, currency: Currency, base: bigint): string {
  const a = amount < 0n ? -amount : amount;
  const b = base < 0n ? -base : base;
  const micros = divRoundHalfUp(a * 100n * 1_000_000n, 10n ** BigInt(EXPONENT[currency]) * b);
  return microsToRate(micros > 0n ? micros : 1n);
}

export function microsToRate(micros: bigint): string {
  const whole = micros / 1_000_000n;
  const fraction = (micros % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function sameRate(a: string, b: string): boolean {
  return rateToMicros(a) === rateToMicros(b);
}

// ─── Dates (business dates are Damascus dates) ───────────────────────────────────────────────

const DAMASCUS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Damascus',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The calendar date in Damascus of a moment: "2026-10-19". */
export function businessDate(moment: Date): string {
  return DAMASCUS.format(moment);
}

export function asDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "2026-10" → "2026-10-31". */
export function monthEnd(period: string): string {
  const [year, month] = period.split('-').map(Number) as [number, number];
  return isoDate(new Date(Date.UTC(year, month, 0)));
}
