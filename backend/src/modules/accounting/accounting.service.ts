import type { GlAccount } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Queryable, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { withIdempotency } from '../../shared/idempotency.js';
import type { Currency } from '../../shared/money.js';
import {
  assertPermission,
  PERMISSIONS,
  type ActorContext,
  type WriteContext,
} from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import type { RatesService } from '../currency/rates.service.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { LocationsService } from '../locations/locations.service.js';
import {
  AccountNotUsableError,
  AmountTooSmallError,
  CurrencyMismatchError,
  DateInFutureError,
  EntryNotReversibleError,
  PeriodNotClosableError,
  RateNotSetError,
  SystemAccountError,
} from './accounting.errors.js';
import {
  asOfSchema,
  closeSchema,
  createAccountSchema,
  entriesQuerySchema,
  rangeSchema,
  reverseSchema,
  updateAccountSchema,
  voucherSchema,
  type Voucher,
  type VoucherInput,
} from './accounting.schema.js';
import type {
  AccountKind,
  AccountView,
  Branch,
  DraftEntry,
  DraftLine,
  EntryView,
  SystemRole,
} from './accounting.types.js';
import { ensureLocationAccounts, installChart } from './chart.js';
import { entryForMovement, INVENTORY_SOURCE, type InventoryAccounts } from './inventory-posting.js';
import {
  businessDate,
  closedThroughDate,
  isoDate,
  line,
  lineAtBase,
  monthEnd,
  postEntries,
} from './posting.js';
import * as reports from './reports.js';
import { revaluationLines, type ForeignBalance } from './revaluation.js';

export interface AccountingDeps {
  inventory: InventoryService;
  locations: LocationsService;
  rates: RatesService;
}

const SYNC_LOCK = 72_707_401; // any constant: one inventory posting run at a time
const SYNC_BATCH = 500;
/**
 * The cursor only moves past movements older than this. A transaction lasts at most 20 s
 * (shared/db.ts), so an older movement is committed or gone; a newer one may still appear below a
 * seq already seen. Posting itself is immediate: the cursor only saves rereading.
 */
const SETTLED_MS = 5 * 60 * 1000;

export function createAccountingService(db: Db, deps: AccountingDeps) {
  async function accounts(q: Queryable = db): Promise<AccountView[]> {
    const rows = await q.glAccount.findMany({ orderBy: { code: 'asc' } });
    return rows.map(toAccountView);
  }

  async function accountByRole(q: Queryable, role: SystemRole): Promise<string> {
    const row = await q.glAccount.findUnique({ where: { systemRole: role }, select: { id: true } });
    if (!row) throw new NotFoundError('account', role);
    return row.id;
  }

  async function ownerRates(): Promise<Map<Currency, string>> {
    const rates = await deps.rates.listRates();
    return new Map(
      rates.filter((r) => r.rate !== null).map((r) => [r.currency as Currency, r.rate!]),
    );
  }

  /**
   * Posts every stock movement not yet in the books (ADR-013). Runs before every read of the
   * books and before a month is closed, so reports are never behind the warehouse. Idempotent:
   * a movement has at most one entry (unique source), whatever runs twice.
   */
  async function syncInventory(): Promise<number> {
    let posted = 0;
    for (;;) {
      const { count, more } = await inTransaction(db, async (tx) => syncBatch(tx));
      posted += count;
      if (!more) return posted;
    }
  }

  // A page asks for several reports at once: they share the posting run in progress instead of
  // each queueing on the lock for one of their own.
  let running: Promise<number> | null = null;
  async function syncForReading(): Promise<void> {
    running ??= syncInventory().finally(() => {
      running = null;
    });
    await running;
  }

  async function syncBatch(tx: Tx): Promise<{ count: number; more: boolean }> {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${SYNC_LOCK})`);
    const state = await tx.accountingSyncState.findUnique({ where: { name: 'inventory' } });
    const afterSeq = state?.lastSeq ?? 0n;
    const movements = await deps.inventory.movementsAfter(tx, afterSeq, SYNC_BATCH);
    if (movements.length === 0) return { count: 0, more: false };

    const already = await tx.journalEntry.findMany({
      where: { sourceType: INVENTORY_SOURCE, sourceId: { in: movements.map((m) => m.id) } },
      select: { sourceId: true },
    });
    const done = new Set(already.map((e) => e.sourceId));
    const pending = movements.filter((m) => !done.has(m.id));

    let drafts: DraftEntry[] = [];
    if (pending.length) {
      let posting = await inventoryAccounts(tx);
      if (pending.some((m) => !posting.byLocation.has(m.locationId))) {
        await ensureLocationAccounts(tx, await deps.locations.allLocations(tx));
        posting = await inventoryAccounts(tx);
      }
      drafts = pending.flatMap((m) => entryForMovement(m, posting) ?? []);
      await postEntries(tx, drafts);
    }

    const [clock] = await tx.$queryRaw<{ now: Date }[]>(Prisma.sql`SELECT now() AS now`);
    const now = clock!.now;
    const settled = movements.filter((m) => m.createdAt.getTime() < now.getTime() - SETTLED_MS);
    if (settled.length) {
      const lastSeq = settled[settled.length - 1]!.seq;
      await tx.accountingSyncState.upsert({
        where: { name: 'inventory' },
        create: { name: 'inventory', lastSeq },
        update: { lastSeq },
      });
    }
    // More to read only when the batch was full and the cursor moved; otherwise the rest is
    // recent and was just posted.
    return { count: drafts.length, more: movements.length === SYNC_BATCH && settled.length > 0 };
  }

  async function inventoryAccounts(q: Queryable): Promise<InventoryAccounts> {
    const located = await q.glAccount.findMany({
      where: { kind: 'INVENTORY', locationId: { not: null } },
      select: { id: true, locationId: true, branch: true },
    });
    return {
      byLocation: new Map(
        located.map((a) => [a.locationId!, { id: a.id, branch: a.branch as Branch | null }]),
      ),
      transit: await accountByRole(q, 'INVENTORY_TRANSIT'),
      payable: await accountByRole(q, 'PAYABLE'),
      openingEquity: await accountByRole(q, 'OPENING_EQUITY'),
      cogs: await accountByRole(q, 'COGS'),
      damage: await accountByRole(q, 'DAMAGE'),
      adjustment: await accountByRole(q, 'STOCK_ADJUSTMENT'),
    };
  }

  /** Read access: syncs first, so what is shown includes every stock movement. */
  async function forReading(ctx: ActorContext) {
    assertPermission(ctx, PERMISSIONS.accounting.view);
    await syncForReading();
    return accounts();
  }

  // ─── Vouchers ──────────────────────────────────────────────────────────────────────────────

  async function buildVoucher(tx: Tx, v: Voucher, ctx: ActorContext): Promise<DraftEntry> {
    const today = businessDate(new Date());
    const entryDate = v.date ?? today;
    if (entryDate > today) throw new DateInFutureError(entryDate);
    const base = { entryDate, createdById: ctx.userId, memo: v.memo ?? null };

    // قيد يومية: the accountant's free entry, in USD.
    if (v.kind === 'JOURNAL') {
      const lines: DraftLine[] = [];
      for (const l of v.lines) {
        const account = await usableAccount(tx, l.accountId, 'journal');
        if (account.currency && account.currency !== 'USD') {
          throw new CurrencyMismatchError({ account: account.currency, journal: 'USD' });
        }
        const amount = (l.debit ?? 0n) - (l.credit ?? 0n);
        lines.push(
          line(account.id, 'USD', amount, '1', { branch: v.branch ?? null, memo: l.memo }),
        );
      }
      return { ...base, voucherType: 'JOURNAL', lines };
    }

    if (v.kind === 'RECEIPT' || v.kind === 'PAYMENT') {
      const box = await usableAccount(tx, v.boxId, 'cash');
      const counter = await usableAccount(tx, v.counterAccountId, 'counter');
      if (counter.currency && counter.currency !== box.currency) {
        throw new CurrencyMismatchError({ box: box.currency, account: counter.currency });
      }
      const currency = box.currency as Currency;
      const rate = await rateFor(currency, v.rate);
      const sign = v.kind === 'RECEIPT' ? 1n : -1n;
      const extra = { branch: box.branch as Branch | null };
      const boxLine = line(box.id, currency, sign * v.amount, rate, extra);
      if (boxLine.amountBase === 0n) throw new AmountTooSmallError();
      return {
        ...base,
        voucherType: v.kind,
        lines: [boxLine, opposite(counter.id, boxLine)],
      };
    }

    if (v.kind === 'TRANSFER') {
      const from = await usableAccount(tx, v.fromBoxId, 'cash');
      const to = await usableAccount(tx, v.toBoxId, 'cash');
      if (from.id === to.id) throw new AccountNotUsableError(to.id, 'SAME_ACCOUNT');
      if (from.currency !== to.currency) {
        throw new CurrencyMismatchError({ from: from.currency, to: to.currency });
      }
      const currency = from.currency as Currency;
      const rate = await rateFor(currency, v.rate);
      const out = line(from.id, currency, -v.amount, rate, { branch: from.branch as Branch });
      if (out.amountBase === 0n) throw new AmountTooSmallError();
      return {
        ...base,
        voucherType: 'TRANSFER',
        lines: [out, { ...opposite(to.id, out), branch: to.branch as Branch | null }],
      };
    }

    if (v.kind === 'EXCHANGE') {
      const from = await usableAccount(tx, v.fromBoxId, 'cash');
      const to = await usableAccount(tx, v.toBoxId, 'cash');
      const fromCurrency = from.currency as Currency;
      const toCurrency = to.currency as Currency;
      if (fromCurrency === toCurrency) {
        throw new CurrencyMismatchError({ from: fromCurrency, to: toCurrency, same: true });
      }
      // The dollar side, when there is one, is the value of the deal; the other side's rate is
      // the deal's own. Differences from the owner's rate come out at the month-end revaluation.
      const value =
        toCurrency === 'USD'
          ? v.toAmount
          : line(from.id, fromCurrency, v.fromAmount, await rateFor(fromCurrency, v.rate))
              .amountBase;
      if (value === 0n) throw new AmountTooSmallError();
      return {
        ...base,
        voucherType: 'EXCHANGE',
        lines: [
          lineAtBase(from.id, fromCurrency, -v.fromAmount, -value, {
            branch: from.branch as Branch | null,
          }),
          lineAtBase(to.id, toCurrency, v.toAmount, value, { branch: to.branch as Branch | null }),
        ],
      };
    }
    // TypeScript does not narrow the two-kind member away; the schema admits no other kind.
    throw new Error(`unknown voucher kind`);
  }

  async function usableAccount(
    tx: Tx,
    id: string,
    use: 'cash' | 'counter' | 'journal',
  ): Promise<GlAccount> {
    const account = await tx.glAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundError('account', id);
    if (!account.isPostable) throw new AccountNotUsableError(id, 'HEADING');
    if (!account.isActive) throw new AccountNotUsableError(id, 'INACTIVE');
    // Stock accounts move only with the goods (the books check depends on it).
    if (account.kind === 'INVENTORY') throw new AccountNotUsableError(id, 'INVENTORY');
    if (use === 'cash' && account.kind !== 'CASH') throw new AccountNotUsableError(id, 'NOT_CASH');
    // Box to box is a transfer or an exchange, not a receipt.
    if (use === 'counter' && account.kind === 'CASH')
      throw new AccountNotUsableError(id, 'IS_CASH');
    return account;
  }

  async function rateFor(currency: Currency, typed: string | undefined): Promise<string> {
    if (currency === 'USD') return '1';
    if (typed) return typed;
    const rate = (await ownerRates()).get(currency);
    if (!rate) throw new RateNotSetError(currency);
    return rate;
  }

  async function postOne(tx: Tx, draft: DraftEntry, action: string, ctx: ActorContext) {
    const [id] = await postEntries(tx, [draft]);
    await writeAudit(tx, {
      actorId: ctx.userId,
      action,
      entityType: 'journal_entry',
      entityId: id!,
      after: { voucherType: draft.voucherType, entryDate: draft.entryDate, lines: draft.lines },
    });
    return (await reports.getEntry(tx, id!))!;
  }

  return {
    syncInventory,

    /** At start-up (main.ts) and in tests: the default chart, once. */
    async installChart(): Promise<number> {
      return inTransaction(db, async (tx) =>
        installChart(tx, await deps.locations.allLocations(tx)),
      );
    },

    async listAccounts(ctx: ActorContext): Promise<AccountView[]> {
      assertPermission(ctx, PERMISSIONS.accounting.view);
      return accounts();
    },

    async createAccount(input: unknown, ctx: ActorContext): Promise<AccountView> {
      assertPermission(ctx, PERMISSIONS.accounting.close);
      const data = parse(createAccountSchema, input);
      return inTransaction(db, async (tx) => {
        const parent = await tx.glAccount.findUnique({ where: { id: data.parentId } });
        if (!parent) throw new NotFoundError('account', data.parentId);
        // Accounts hang under headings; a stock account only comes from a location.
        if (parent.isPostable) throw new AccountNotUsableError(parent.id, 'HEADING');
        if (parent.systemRole === 'INVENTORY_PARENT') {
          throw new AccountNotUsableError(parent.id, 'INVENTORY');
        }
        const kind: AccountKind = data.kind;
        if (kind === 'CASH' && !data.currency) {
          throw new CurrencyMismatchError({ cash: 'a cash box needs a currency' });
        }
        const siblings = await tx.glAccount.findMany({
          where: { parentId: parent.id },
          select: { code: true },
        });
        // The first free number under the parent: 5299 (misc.) stays last, new ones fill in.
        const width = parent.code.length >= 2 ? 2 : 1;
        const used = new Set(siblings.map((s) => Number(s.code.slice(parent.code.length))));
        let next = 1;
        while (used.has(next)) next += 1;
        if (next >= 10 ** width) throw new AccountNotUsableError(parent.id, 'HEADING');
        const code = `${parent.code}${String(next).padStart(width, '0')}`;
        const row = await tx.glAccount.create({
          data: {
            code,
            nameAr: data.nameAr,
            class: parent.class,
            parentId: parent.id,
            kind,
            currency: data.currency ?? null,
            branch: data.branch ?? parent.branch ?? null,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'accounting.account.create',
          entityType: 'gl_account',
          entityId: row.id,
          after: { code, nameAr: row.nameAr, kind, currency: row.currency },
        });
        return toAccountView(row);
      });
    },

    async updateAccount(id: string, input: unknown, ctx: ActorContext): Promise<AccountView> {
      assertPermission(ctx, PERMISSIONS.accounting.close);
      const data = parse(updateAccountSchema, input);
      return inTransaction(db, async (tx) => {
        const before = await tx.glAccount.findUnique({ where: { id } });
        if (!before) throw new NotFoundError('account', id);
        if (data.isActive === false && (before.systemRole || before.kind === 'INVENTORY')) {
          throw new SystemAccountError(id);
        }
        const row = await tx.glAccount.update({
          where: { id },
          data: {
            ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            ...(data.branch !== undefined ? { branch: data.branch } : {}),
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'accounting.account.update',
          entityType: 'gl_account',
          entityId: id,
          before: { nameAr: before.nameAr, isActive: before.isActive, branch: before.branch },
          after: { nameAr: row.nameAr, isActive: row.isActive, branch: row.branch },
        });
        return toAccountView(row);
      });
    },

    /** سند قبض · سند صرف · تحويل · صرافة · قيد يومية. Idempotent per request key. */
    async postVoucher(input: VoucherInput, ctx: WriteContext): Promise<EntryView> {
      assertPermission(ctx, PERMISSIONS.accounting.post);
      const v = parse(voucherSchema, input);
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'accounting.voucher', request: v },
          async () => postOne(tx, await buildVoucher(tx, v, ctx), 'accounting.voucher', ctx),
        ),
      );
    },

    /** قيد عكسي: the same lines with opposite signs. Stock and revaluation entries are not. */
    async reverseEntry(id: string, input: unknown, ctx: WriteContext): Promise<EntryView> {
      assertPermission(ctx, PERMISSIONS.accounting.post);
      const data = parse(reverseSchema, input ?? {});
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'accounting.reverse', request: { id, ...data } },
          async () => {
            const entry = await reports.getEntry(tx, id);
            if (!entry) throw new NotFoundError('entry', id);
            if (entry.sourceType === INVENTORY_SOURCE || entry.voucherType === 'REVALUATION') {
              throw new EntryNotReversibleError(id, 'SYSTEM');
            }
            if (entry.voucherType === 'REVERSAL') {
              throw new EntryNotReversibleError(id, 'IS_REVERSAL');
            }
            if (entry.reversedById) throw new EntryNotReversibleError(id, 'ALREADY_REVERSED');
            const today = businessDate(new Date());
            const entryDate = data.date ?? today;
            if (entryDate > today) throw new DateInFutureError(entryDate);
            return postOne(
              tx,
              {
                voucherType: 'REVERSAL',
                entryDate,
                memo: data.memo || `عكس القيد ${entry.voucherYear}/${entry.voucherNo}`,
                reversesId: entry.id,
                createdById: ctx.userId,
                lines: entry.lines.map((l) => ({
                  accountId: l.account.id,
                  amountBase: -l.amountBase,
                  currency: l.currency,
                  amountCurrency: -l.amountCurrency,
                  rate: l.rate,
                  branch: l.branch,
                  locationId: l.locationId,
                  memo: l.memo,
                })),
              },
              'accounting.reverse',
              ctx,
            );
          },
        ),
      );
    },

    // ─── Reading ───────────────────────────────────────────────────────────────────────────

    async boxes(ctx: ActorContext) {
      const all = await forReading(ctx);
      return reports.boxBalances(db, all, await ownerRates());
    },

    async entries(input: unknown, ctx: ActorContext): Promise<EntryView[]> {
      await forReading(ctx);
      return reports.listEntries(db, parse(entriesQuerySchema, input ?? {}));
    },

    async entry(id: string, ctx: ActorContext): Promise<EntryView> {
      await forReading(ctx);
      const entry = await reports.getEntry(db, id);
      if (!entry) throw new NotFoundError('entry', id);
      return entry;
    },

    async statement(accountId: string, input: unknown, ctx: ActorContext) {
      const all = await forReading(ctx);
      const account = all.find((a) => a.id === accountId);
      if (!account) throw new NotFoundError('account', accountId);
      return reports.accountStatement(db, account, parse(rangeSchema, input ?? {}));
    },

    async trialBalance(input: unknown, ctx: ActorContext) {
      const all = await forReading(ctx);
      return reports.trialBalance(db, all, parse(rangeSchema, input ?? {}));
    },

    async incomeStatement(input: unknown, ctx: ActorContext) {
      const all = await forReading(ctx);
      return reports.incomeStatement(db, all, parse(rangeSchema, input ?? {}));
    },

    async balanceSheet(input: unknown, ctx: ActorContext) {
      const all = await forReading(ctx);
      const data = parse(asOfSchema, input ?? {});
      return reports.balanceSheet(db, all, data.asOf ?? businessDate(new Date()), data.branch);
    },

    /**
     * مطابقة المخزون: each location's inventory account equals the stock value the warehouse
     * holds there, and goods in transit net to zero. Any difference is a bug, shown the same day.
     */
    async checkBooks(ctx: ActorContext) {
      const all = await forReading(ctx);
      const sums = await reports.sumsByAccount(db);
      const stock = new Map(
        (await deps.inventory.valueByLocation(db)).map((r) => [r.locationId, r.valueBaseAmount]),
      );
      const locations = await deps.locations.allLocations(db);
      const rows = locations.map((l) => {
        const account = all.find((a) => a.locationId === l.id);
        const books = account ? (sums.get(account.id)?.base ?? 0n) : 0n;
        const value = stock.get(l.id) ?? 0n;
        return {
          locationId: l.id,
          nameAr: l.nameAr,
          books,
          stock: value,
          difference: books - value,
        };
      });
      const transitAccount = all.find((a) => a.systemRole === 'INVENTORY_TRANSIT');
      const transit = transitAccount ? (sums.get(transitAccount.id)?.base ?? 0n) : 0n;
      return {
        ok: transit === 0n && rows.every((r) => r.difference === 0n),
        locations: rows,
        transit,
      };
    },

    // ─── Closing a month ───────────────────────────────────────────────────────────────────

    /** The month that can be closed next, and what its revaluation would post at today's rates. */
    async closingStatus(ctx: ActorContext) {
      await forReading(ctx);
      const closedThrough = await closedThroughDate(db);
      const next = await nextClosable(db, closedThrough);
      const rates = await ownerRates();
      const preview = next ? await revaluationFor(db, monthEnd(next), rates) : null;
      const closed = await db.accountingPeriod.findMany({
        orderBy: { endsOn: 'desc' },
        take: 24,
        include: { closedBy: { select: { nameAr: true } } },
      });
      return {
        closedThrough,
        next,
        rates: Object.fromEntries(rates),
        missingRates: preview?.missingRates ?? [],
        preview: preview?.lines ?? [],
        closed: closed.map((p) => ({
          period: p.period,
          endsOn: isoDate(p.endsOn),
          closedBy: p.closedBy.nameAr,
          closedAt: p.closedAt,
          revaluationEntryId: p.revaluationEntryId,
        })),
      };
    },

    /**
     * إقفال الشهر: revalues SYP and LYD money at the owner's current rates, then locks the month.
     * Months close in order, only once they have ended. Nothing dated in it can be posted after.
     */
    async closeMonth(input: unknown, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.accounting.close);
      const { period } = parse(closeSchema, input);
      await syncInventory();
      return inTransaction(db, async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${SYNC_LOCK})`);
        const next = await nextClosable(tx, await closedThroughDate(tx));
        if (next !== period) throw new PeriodNotClosableError(period, next);
        const endsOn = monthEnd(period);
        const { lines, missingRates } = await revaluationFor(tx, endsOn, await ownerRates());
        if (missingRates.length) throw new RateNotSetError(missingRates.join(','));

        let revaluationEntryId: string | null = null;
        if (lines.length) {
          [revaluationEntryId] = (await postEntries(tx, [
            {
              voucherType: 'REVALUATION',
              entryDate: endsOn,
              memo: `إعادة تقييم العملات — ${period}`,
              createdById: ctx.userId,
              lines,
            },
          ])) as [string];
        }
        await tx.accountingPeriod.create({
          data: {
            period,
            endsOn: new Date(`${endsOn}T00:00:00.000Z`),
            revaluationEntryId,
            closedById: ctx.userId,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'accounting.period.close',
          entityType: 'accounting_period',
          after: { period, revaluationEntryId, lines: lines.length },
        });
        return { period, endsOn, revaluationEntryId };
      });
    },
  };

  /** The oldest month with entries after the last closed one, if it has already ended. */
  async function nextClosable(q: Queryable, closedThrough: string | null): Promise<string | null> {
    const first = await q.journalEntry.findFirst({
      where: closedThrough ? { entryDate: { gt: new Date(`${closedThrough}T00:00:00.000Z`) } } : {},
      orderBy: { entryDate: 'asc' },
      select: { entryDate: true },
    });
    if (!first) return null;
    const period = isoDate(first.entryDate).slice(0, 7);
    return monthEnd(period) < businessDate(new Date()) ? period : null;
  }

  async function revaluationFor(q: Queryable, endsOn: string, rates: Map<Currency, string>) {
    const foreign = (await accounts(q)).filter(
      (a) => a.isPostable && a.currency !== null && a.currency !== 'USD',
    );
    const sums = await reports.sumsByAccount(q, { to: endsOn });
    const balances: ForeignBalance[] = foreign.map((a) => ({
      accountId: a.id,
      currency: a.currency!,
      branch: a.branch,
      balanceCurrency: sums.get(a.id)?.currency ?? 0n,
      balanceBase: sums.get(a.id)?.base ?? 0n,
    }));
    const missingRates = [
      ...new Set(
        balances
          .filter(
            (b) => (b.balanceCurrency !== 0n || b.balanceBase !== 0n) && !rates.has(b.currency),
          )
          .map((b) => b.currency),
      ),
    ];
    const fx = await accountByRole(q, 'FX_UNREALIZED');
    return { lines: revaluationLines(balances, rates, fx), missingRates };
  }
}

/** The other side of a line: same amount and currency, opposite sign, on `accountId`. */
function opposite(accountId: string, l: DraftLine): DraftLine {
  return {
    ...l,
    accountId,
    amountBase: -l.amountBase,
    amountCurrency: -l.amountCurrency,
  };
}

function toAccountView(a: GlAccount): AccountView {
  return {
    id: a.id,
    code: a.code,
    nameAr: a.nameAr,
    class: a.class,
    parentId: a.parentId,
    isPostable: a.isPostable,
    currency: a.currency as Currency | null,
    kind: a.kind as AccountKind,
    systemRole: a.systemRole as SystemRole | null,
    locationId: a.locationId,
    branch: a.branch as Branch | null,
    isActive: a.isActive,
  };
}

export type AccountingService = ReturnType<typeof createAccountingService>;
