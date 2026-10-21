import type { Prisma } from '@prisma/client';
import type { Queryable } from '../../shared/db.js';
import type { Currency } from '../../shared/money.js';
import type { AccountView, Branch, EntryView, LineView, VoucherType } from './accounting.types.js';
import { asDate, isoDate } from './posting.js';

export interface Range {
  from?: string;
  to?: string;
  branch?: Branch;
}

interface Sums {
  base: bigint;
  currency: bigint;
}

/** Lines in a date range (inclusive) and branch. `before` is exclusive. */
function lineWhere(f: Range & { before?: string; sign?: 'debit' | 'credit' }) {
  const entryDate: Prisma.DateTimeFilter = {};
  if (f.from) entryDate.gte = asDate(f.from);
  if (f.to) entryDate.lte = asDate(f.to);
  if (f.before) entryDate.lt = asDate(f.before);
  const where: Prisma.JournalLineWhereInput = {};
  if (Object.keys(entryDate).length) where.entry = { entryDate };
  if (f.branch) where.branch = f.branch;
  if (f.sign === 'debit') where.amountBase = { gt: 0n };
  if (f.sign === 'credit') where.amountBase = { lt: 0n };
  return where;
}

/** Sum of lines per account: USD cents, and the account's own currency. */
export async function sumsByAccount(
  q: Queryable,
  f: Range & { before?: string; sign?: 'debit' | 'credit' } = {},
): Promise<Map<string, Sums>> {
  const rows = await q.journalLine.groupBy({
    by: ['accountId'],
    where: lineWhere(f),
    _sum: { amountBase: true, amountCurrency: true },
  });
  return new Map(
    rows.map((r) => [
      r.accountId,
      { base: r._sum.amountBase ?? 0n, currency: r._sum.amountCurrency ?? 0n },
    ]),
  );
}

const ZERO: Sums = { base: 0n, currency: 0n };

// ─── Trial balance (ميزان المراجعة) ─────────────────────────────────────────────────────────────

export interface TrialRow {
  account: Pick<AccountView, 'id' | 'code' | 'nameAr' | 'class'>;
  opening: bigint;
  debit: bigint;
  /** Positive. */
  credit: bigint;
  closing: bigint;
}

export async function trialBalance(q: Queryable, accounts: AccountView[], range: Range) {
  const opening = range.from
    ? await sumsByAccount(q, { before: range.from, branch: range.branch })
    : new Map<string, Sums>();
  const debits = await sumsByAccount(q, { ...range, sign: 'debit' });
  const credits = await sumsByAccount(q, { ...range, sign: 'credit' });

  const rows: TrialRow[] = [];
  for (const a of accounts) {
    const o = (opening.get(a.id) ?? ZERO).base;
    const d = (debits.get(a.id) ?? ZERO).base;
    const c = -(credits.get(a.id) ?? ZERO).base;
    if (o === 0n && d === 0n && c === 0n) continue;
    rows.push({ account: pick(a), opening: o, debit: d, credit: c, closing: o + d - c });
  }
  const total = (k: 'opening' | 'debit' | 'credit' | 'closing') =>
    rows.reduce((s, r) => s + r[k], 0n);
  return {
    rows,
    totals: {
      opening: total('opening'),
      debit: total('debit'),
      credit: total('credit'),
      closing: total('closing'),
    },
  };
}

// ─── Income statement (الأرباح والخسائر) ───────────────────────────────────────────────────────

export type IncomeSectionKey = 'revenue' | 'costOfSales' | 'stockLosses' | 'expenses' | 'exchange';

export interface IncomeSection {
  key: IncomeSectionKey;
  rows: { account: Pick<AccountView, 'id' | 'code' | 'nameAr' | 'class'>; amount: bigint }[];
  /** Revenue positive; costs positive. */
  total: bigint;
}

function sectionOf(code: string): IncomeSectionKey | null {
  if (code.startsWith('4')) return 'revenue';
  // Developer report F-08: what sold pieces cost (5101) apart from damage and stock
  // differences (5102, 5103), so a month with no sales shows no cost of sales.
  if (code === '5101') return 'costOfSales';
  if (code.startsWith('51')) return 'stockLosses';
  if (code.startsWith('55')) return 'exchange';
  if (code.startsWith('5')) return 'expenses';
  return null;
}

export async function incomeStatement(q: Queryable, accounts: AccountView[], range: Range) {
  const sums = await sumsByAccount(q, range);
  const sections = new Map<IncomeSectionKey, IncomeSection>(
    (['revenue', 'costOfSales', 'stockLosses', 'expenses', 'exchange'] as const).map((key) => [
      key,
      { key, rows: [], total: 0n },
    ]),
  );
  for (const a of accounts) {
    const key = sectionOf(a.code);
    const base = sums.get(a.id)?.base ?? 0n;
    if (!key || base === 0n) continue;
    // Revenue sits on the credit side, costs on the debit side; both are shown positive.
    const amount = key === 'revenue' ? -base : base;
    const section = sections.get(key)!;
    section.rows.push({ account: pick(a), amount });
    section.total += amount;
  }
  const s = (k: IncomeSectionKey) => sections.get(k)!.total;
  const grossProfit = s('revenue') - s('costOfSales');
  return {
    sections: [...sections.values()],
    grossProfit,
    netProfit: grossProfit - s('stockLosses') - s('expenses') - s('exchange'),
  };
}

// ─── Balance sheet (الميزانية) ─────────────────────────────────────────────────────────────────

export async function balanceSheet(
  q: Queryable,
  accounts: AccountView[],
  asOf: string,
  branch?: Branch,
) {
  const sums = await sumsByAccount(q, { to: asOf, branch });
  const group = (cls: number, sign: 1n | -1n) => {
    const rows = accounts
      .filter((a) => a.class === cls)
      .map((a) => ({ account: pick(a), amount: sign * (sums.get(a.id)?.base ?? 0n) }))
      .filter((r) => r.amount !== 0n);
    return { rows, total: rows.reduce((s, r) => s + r.amount, 0n) };
  };
  const assets = group(1, 1n);
  const liabilities = group(2, -1n);
  const equity = group(3, -1n);
  // The profit not yet closed into retained earnings: everything in classes 4 and 5, to date.
  const profit = -accounts
    .filter((a) => a.class >= 4)
    .reduce((s, a) => s + (sums.get(a.id)?.base ?? 0n), 0n);
  return {
    asOf,
    assets,
    liabilities,
    equity,
    profit,
    totalLiabilitiesAndEquity: liabilities.total + equity.total + profit,
  };
}

// ─── Cash boxes (الصناديق) ─────────────────────────────────────────────────────────────────────

export async function boxBalances(
  q: Queryable,
  accounts: AccountView[],
  rates: Map<Currency, string>,
) {
  const sums = await sumsByAccount(q);
  return accounts
    .filter((a) => a.kind === 'CASH')
    .map((a) => {
      const s = sums.get(a.id) ?? ZERO;
      return {
        account: a,
        /** What is in the box, in its own currency. */
        balance: s.currency,
        /** Its value in the books, USD cents. */
        bookValue: s.base,
        /** Its rate for today's value; null when no rate is set. */
        rate: a.currency === 'USD' ? '1' : (rates.get(a.currency!) ?? null),
      };
    });
}

// ─── Account statement (كشف حساب) ─────────────────────────────────────────────────────────────

export async function accountStatement(q: Queryable, account: AccountView, range: Range) {
  const before = range.from
    ? ((await sumsByAccount(q, { before: range.from, branch: range.branch })).get(account.id) ??
      ZERO)
    : ZERO;
  const lines = await q.journalLine.findMany({
    where: { ...lineWhere(range), accountId: account.id },
    include: { entry: { select: entrySelect } },
    orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { createdAt: 'asc' } }, { lineNo: 'asc' }],
    take: 2000,
  });
  let base = before.base;
  let own = before.currency;
  const rows = lines.map((l) => {
    base += l.amountBase;
    own += l.amountCurrency;
    return {
      entry: entryHeader(l.entry),
      memo: l.memo,
      currency: l.currency as Currency,
      amountCurrency: l.amountCurrency,
      amountBase: l.amountBase,
      rate: l.rate.toString(),
      balanceBase: base,
      balanceCurrency: own,
    };
  });
  return {
    account,
    opening: { base: before.base, currency: before.currency },
    rows,
    closing: { base, currency: own },
  };
}

// ─── Entries (دفتر اليومية) ────────────────────────────────────────────────────────────────────

const entrySelect = {
  id: true,
  voucherType: true,
  voucherYear: true,
  voucherNo: true,
  entryDate: true,
  memo: true,
  sourceType: true,
  sourceId: true,
  reversesId: true,
  createdAt: true,
} as const;

function entryHeader(e: {
  id: string;
  voucherType: string;
  voucherYear: number;
  voucherNo: number;
  entryDate: Date;
  memo: string | null;
}) {
  return {
    id: e.id,
    voucherType: e.voucherType as VoucherType,
    voucherYear: e.voucherYear,
    voucherNo: e.voucherNo,
    entryDate: isoDate(e.entryDate),
    memo: e.memo,
  };
}

const entryInclude = {
  createdBy: { select: { id: true, nameAr: true } },
  reversedBy: { select: { id: true } },
  lines: {
    orderBy: { lineNo: 'asc' },
    include: { account: { select: { id: true, code: true, nameAr: true } } },
  },
} satisfies Prisma.JournalEntryInclude;

type EntryRow = Prisma.JournalEntryGetPayload<{ include: typeof entryInclude }>;

export function toEntryView(e: EntryRow): EntryView {
  return {
    ...entryHeader(e),
    sourceType: e.sourceType,
    sourceId: e.sourceId,
    reversesId: e.reversesId,
    reversedById: e.reversedBy?.id ?? null,
    createdBy: e.createdBy,
    createdAt: e.createdAt,
    lines: e.lines.map((l): LineView => ({
      lineNo: l.lineNo,
      account: l.account,
      amountBase: l.amountBase,
      currency: l.currency as Currency,
      amountCurrency: l.amountCurrency,
      rate: l.rate.toString(),
      branch: l.branch as Branch | null,
      locationId: l.locationId,
      memo: l.memo,
    })),
  };
}

export async function listEntries(
  q: Queryable,
  f: Range & { voucherType?: VoucherType; limit: number },
): Promise<EntryView[]> {
  const entryDate: Prisma.DateTimeFilter = {};
  if (f.from) entryDate.gte = asDate(f.from);
  if (f.to) entryDate.lte = asDate(f.to);
  const rows = await q.journalEntry.findMany({
    where: {
      ...(Object.keys(entryDate).length ? { entryDate } : {}),
      ...(f.voucherType ? { voucherType: f.voucherType } : {}),
      ...(f.branch ? { lines: { some: { branch: f.branch } } } : {}),
    },
    include: entryInclude,
    orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
    take: f.limit,
  });
  return rows.map(toEntryView);
}

export async function getEntry(q: Queryable, id: string): Promise<EntryView | null> {
  const row = await q.journalEntry.findUnique({ where: { id }, include: entryInclude });
  return row ? toEntryView(row) : null;
}

function pick(a: AccountView) {
  return { id: a.id, code: a.code, nameAr: a.nameAr, class: a.class };
}
