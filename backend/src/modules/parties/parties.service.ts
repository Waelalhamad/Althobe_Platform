import type { Party } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Queryable, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/ids.js';
import { withIdempotency } from '../../shared/idempotency.js';
import type { Currency } from '../../shared/money.js';
import {
  assertPermission,
  PERMISSIONS,
  type ActorContext,
  type WriteContext,
} from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import type { AccountingService } from '../accounting/accounting.service.js';
import type { Branch } from '../accounting/accounting.types.js';
import type { ScanSessionService } from '../inventory/scan-session.service.js';
import { settledBase } from './parties-money.js';
import {
  CashMustCoverGoodsError,
  PartyCurrencyLockedError,
  PartyCurrencyMismatchError,
  PartyNotUsableError,
  UnassignedTooSmallError,
  WrongSessionKindError,
} from './parties.errors.js';
import {
  createPartySchema,
  goodsOutTermsSchema,
  partiesQuerySchema,
  partyCashSchema,
  receiptTermsSchema,
  settleSchema,
  updatePartySchema,
  type PartyKind,
} from './parties.schema.js';

export interface PartiesDeps {
  accounting: AccountingService;
  scanSessions: ScanSessionService;
}

export interface PartyView {
  id: string;
  kind: PartyKind;
  nameAr: string;
  phone: string | null;
  currency: Currency;
  branch: Branch;
  notes: string | null;
  isActive: boolean;
  /** What is outstanding: they owe us (customer) or we owe them (supplier). Null without parties.read. */
  balance: bigint | null;
}

/** A source that is not another module's record: the party entry itself (a payment). */
const OWN = 'PARTY_ENTRY';

/** Suppliers and customers (ADR-016): what is owed both ways, posted to the books as it happens. */
export function createPartiesService(db: Db, deps: PartiesDeps) {
  const canRead = (ctx: ActorContext) =>
    ctx.permissions.has(PERMISSIONS.parties.read) ||
    ctx.permissions.has(PERMISSIONS.parties.manage);

  async function balances(q: Queryable, partyIds?: string[]) {
    const rows = await q.partyEntry.groupBy({
      by: ['partyId'],
      where: partyIds ? { partyId: { in: partyIds } } : {},
      _sum: { amount: true, amountBase: true },
    });
    return new Map(
      rows.map((r) => [r.partyId, { amount: r._sum.amount ?? 0n, base: r._sum.amountBase ?? 0n }]),
    );
  }

  /** The party, locked for the rest of the transaction: its balance changes one move at a time. */
  async function lockParty(tx: Tx, id: string): Promise<Party> {
    const [row] = await tx.$queryRaw<
      {
        id: string;
        kind: string;
        name_ar: string;
        phone: string | null;
        currency: string;
        branch: string;
        notes: string | null;
        is_active: boolean;
        created_at: Date;
        updated_at: Date;
      }[]
    >(Prisma.sql`SELECT * FROM "parties" WHERE id = ${id}::uuid FOR UPDATE`);
    if (!row) throw new NotFoundError('party', id);
    return {
      id: row.id,
      kind: row.kind,
      nameAr: row.name_ar,
      phone: row.phone,
      currency: row.currency,
      branch: row.branch,
      notes: row.notes,
      isActive: row.is_active,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function owedBy(tx: Tx, partyId: string) {
    return (await balances(tx, [partyId])).get(partyId) ?? { amount: 0n, base: 0n };
  }

  function usable(party: Party, kind: PartyKind): Party {
    if (!party.isActive) throw new PartyNotUsableError(party.id, 'INACTIVE');
    if (party.kind !== kind) {
      throw new PartyNotUsableError(
        party.id,
        kind === 'SUPPLIER' ? 'NOT_SUPPLIER' : 'NOT_CUSTOMER',
      );
    }
    return party;
  }

  function toView(p: Party, balance: bigint | null): PartyView {
    return {
      id: p.id,
      kind: p.kind as PartyKind,
      nameAr: p.nameAr,
      phone: p.phone,
      currency: p.currency as Currency,
      branch: p.branch as Branch,
      notes: p.notes,
      isActive: p.isActive,
      balance,
    };
  }

  /** The control account side of a party, and the sign that makes "more outstanding" a debit. */
  const sideOf = (kind: string) =>
    kind === 'CUSTOMER'
      ? { side: 'RECEIVABLE' as const, sign: 1n }
      : { side: 'PAYABLE' as const, sign: -1n };

  /**
   * Money that settles part of what is outstanding: out of a box to a supplier, or into a box
   * from a customer. The box may hold another currency; the party is credited the same value at
   * today's rates. Returns the party row.
   */
  async function settleWithBox(
    tx: Tx,
    party: Party,
    box: { boxId: string; amount: bigint },
    r: {
      sourceType: string;
      sourceId: string;
      note: string | null;
      memo: string;
      ctx: ActorContext;
    },
  ) {
    const currency = party.currency as Currency;
    const { currency: boxCurrency } = await deps.accounting.cashBox(tx, box.boxId);
    const boxValue = await deps.accounting.todayValue(boxCurrency, box.amount);
    const part =
      boxCurrency === currency ? box.amount : await deps.accounting.todayAmount(currency, boxValue);
    const owed = await owedBy(tx, party.id);
    const base = settledBase(
      owed.amount,
      owed.base,
      part,
      await deps.accounting.todayValue(currency, part),
    );
    const { side, sign } = sideOf(party.kind);
    const id = uuidv7();
    const entryId = await deps.accounting.postPartyEntry(tx, {
      side,
      control: { currency, amount: -sign * part, base: -sign * base },
      // Customers pay in; suppliers are paid out.
      other: { boxId: box.boxId, amount: sign * box.amount },
      voucherType: party.kind === 'CUSTOMER' ? 'RECEIPT' : 'PAYMENT',
      sourceType: OWN,
      sourceId: id,
      branch: party.branch as Branch,
      memo: r.memo,
      createdById: r.ctx.userId,
    });
    return tx.partyEntry.create({
      data: {
        id,
        partyId: party.id,
        kind: party.kind === 'CUSTOMER' ? 'RECEIPT' : 'PAYMENT',
        amount: -part,
        amountBase: -base,
        sourceType: r.sourceType === OWN ? OWN : r.sourceType,
        sourceId: r.sourceType === OWN ? id : r.sourceId,
        journalEntryId: entryId,
        note: r.note,
        createdById: r.ctx.userId,
      },
    });
  }

  /** What is in the books (1103, 2101) with no name on it: before suppliers existed, or unnamed. */
  async function unassigned(q: Queryable) {
    const owed = await balances(q);
    const kinds = new Map(
      (await q.party.findMany({ select: { id: true, kind: true } })).map((p) => [p.id, p.kind]),
    );
    let customers = 0n;
    let suppliers = 0n;
    for (const [id, b] of owed) {
      if (kinds.get(id) === 'CUSTOMER') customers += b.base;
      else suppliers += b.base;
    }
    const receivable = await deps.accounting.balanceOfRole(q, 'RECEIVABLE');
    const payable = -(await deps.accounting.balanceOfRole(q, 'PAYABLE'));
    return {
      receivable: { books: receivable, named: customers, unassigned: receivable - customers },
      payable: { books: payable, named: suppliers, unassigned: payable - suppliers },
    };
  }

  return {
    // ─── Parties ─────────────────────────────────────────────────────────────────────────────

    /**
     * Names for whoever picks a supplier or customer at work (a receipt, the till); balances
     * only with parties.read.
     */
    async listParties(input: unknown, ctx: ActorContext): Promise<PartyView[]> {
      const withBalance = canRead(ctx);
      if (!withBalance) {
        const picks = [
          PERMISSIONS.inventory.receive,
          PERMISSIONS.inventory.issue,
          PERMISSIONS.retail.sell,
        ];
        if (!picks.some((p) => ctx.permissions.has(p))) {
          assertPermission(ctx, PERMISSIONS.parties.read);
        }
      }
      const q = parse(partiesQuerySchema, input ?? {});
      const rows = await db.party.findMany({
        where: {
          ...(q.kind ? { kind: q.kind } : {}),
          ...(q.includeInactive === 'true' ? {} : { isActive: true }),
        },
        orderBy: { nameAr: 'asc' },
      });
      const owed = withBalance ? await balances(db) : new Map<string, { amount: bigint }>();
      return rows.map((p) => toView(p, withBalance ? (owed.get(p.id)?.amount ?? 0n) : null));
    },

    /** One party and its statement (كشف حساب): every movement, oldest first, with the balance. */
    async getParty(id: string, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.parties.read);
      const party = await db.party.findUnique({ where: { id } });
      if (!party) throw new NotFoundError('party', id);
      const rows = await db.partyEntry.findMany({
        where: { partyId: id },
        orderBy: { createdAt: 'asc' },
        include: { createdBy: { select: { nameAr: true } } },
      });
      let running = 0n;
      const entries = rows.map((r) => {
        running += r.amount;
        return {
          id: r.id,
          kind: r.kind,
          amount: r.amount,
          balance: running,
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          journalEntryId: r.journalEntryId,
          note: r.note,
          createdBy: r.createdBy.nameAr,
          createdAt: r.createdAt,
        };
      });
      return { ...toView(party, running), entries: entries.reverse() };
    },

    async createParty(input: unknown, ctx: ActorContext): Promise<PartyView> {
      assertPermission(ctx, PERMISSIONS.parties.manage);
      const data = parse(createPartySchema, input);
      return inTransaction(db, async (tx) => {
        const row = await tx.party.create({
          data: {
            kind: data.kind,
            nameAr: data.nameAr,
            phone: data.phone || null,
            currency: data.currency,
            branch: data.branch,
            notes: data.notes || null,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'parties.create',
          entityType: 'party',
          entityId: row.id,
          after: { kind: row.kind, nameAr: row.nameAr, currency: row.currency },
        });
        return toView(row, 0n);
      });
    },

    async updateParty(id: string, input: unknown, ctx: ActorContext): Promise<PartyView> {
      assertPermission(ctx, PERMISSIONS.parties.manage);
      const data = parse(updatePartySchema, input);
      return inTransaction(db, async (tx) => {
        const before = await lockParty(tx, id);
        if (data.currency && data.currency !== before.currency) {
          if ((await tx.partyEntry.count({ where: { partyId: id } })) > 0) {
            throw new PartyCurrencyLockedError(id);
          }
        }
        const row = await tx.party.update({
          where: { id },
          data: {
            ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
            ...(data.phone !== undefined ? { phone: data.phone || null } : {}),
            ...(data.currency !== undefined ? { currency: data.currency } : {}),
            ...(data.branch !== undefined ? { branch: data.branch } : {}),
            ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'parties.update',
          entityType: 'party',
          entityId: id,
          before: { nameAr: before.nameAr, currency: before.currency, isActive: before.isActive },
          after: { nameAr: row.nameAr, currency: row.currency, isActive: row.isActive },
        });
        return toView(row, (await owedBy(tx, id)).amount);
      });
    },

    /** دفعة لمورد · قبض من زبون: from or into any box; the party is credited today's value. */
    async settle(partyId: string, input: unknown, ctx: WriteContext) {
      assertPermission(ctx, PERMISSIONS.parties.manage);
      const data = parse(partyCashSchema, input);
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'parties.settle', request: { partyId, ...data } },
          async () => {
            const party = await lockParty(tx, partyId);
            if (!party.isActive) throw new PartyNotUsableError(partyId, 'INACTIVE');
            const row = await settleWithBox(
              tx,
              party,
              { boxId: data.boxId, amount: data.amount },
              {
                sourceType: OWN,
                sourceId: '',
                note: data.note ?? null,
                memo: `${party.kind === 'CUSTOMER' ? 'قبض من' : 'دفعة إلى'} ${party.nameAr}${data.note ? ` — ${data.note}` : ''}`,
                ctx,
              },
            );
            await writeAudit(tx, {
              actorId: ctx.userId,
              action: 'parties.settle',
              entityType: 'party',
              entityId: partyId,
              after: { boxId: data.boxId, amount: data.amount, partyAmount: -row.amount },
            });
            return { entryId: row.journalEntryId, balance: (await owedBy(tx, partyId)).amount };
          },
        ),
      );
    },

    // ─── Goods in and out ────────────────────────────────────────────────────────────────────

    /**
     * Confirms a receipt (استلام) with its terms: the supplier it is owed to, and what was paid
     * out of a box on the spot. With no supplier, cash pays it in full; with neither, it is owed
     * with no name, as before suppliers existed. A retried confirm returns the first result.
     */
    async commitReceipt(sessionId: string, input: unknown, ctx: ActorContext) {
      const terms = parse(receiptTermsSchema, input ?? {});
      // Money out of a box is the accounts' business; where goods came from is the receiver's.
      if (terms.paid) assertPermission(ctx, PERMISSIONS.parties.manage);
      return inTransaction(db, async (tx) => {
        const done = await deps.scanSessions.commitInTx(tx, sessionId, ctx);
        if (done.kind !== 'RECEIVE')
          throw new WrongSessionKindError(sessionId, done.kind, 'RECEIVE');
        if (done.alreadyCommitted) return done.result;

        await tx.receiptTerms.create({
          data: {
            sessionId,
            source: terms.source,
            partyId: terms.partyId ?? null,
            invoiceNo: terms.invoiceNo ?? null,
            createdById: ctx.userId,
          },
        });
        const goods = done.movements.filter((m) => m.type === 'PURCHASE');
        const value = goods.reduce((s, m) => s + (m.valueBaseAmount ?? 0n), 0n);
        const currencies = [...new Set(goods.map((m) => m.unitCost?.currency ?? 'USD'))];
        const amount = goods.reduce(
          (s, m) => s + (m.unitCost?.amount ?? 0n) * BigInt(m.quantity),
          0n,
        );

        let party: Party | null = null;
        if (terms.partyId) {
          party = usable(await lockParty(tx, terms.partyId), 'SUPPLIER');
          if (currencies.some((c) => c !== party!.currency)) {
            throw new PartyCurrencyMismatchError(party.id, party.currency, currencies);
          }
          // The books get the purchase from the goods themselves (ADR-013); this is its detail.
          await tx.partyEntry.create({
            data: {
              partyId: party.id,
              kind: 'BILL',
              amount,
              amountBase: value,
              sourceType: 'SCAN_SESSION',
              sourceId: sessionId,
              note: terms.invoiceNo ? `فاتورة ${terms.invoiceNo}` : null,
              createdById: ctx.userId,
            },
          });
        }

        // Not bought at all: the purchase the stock ledger posts to 2101 is moved, in the same
        // currency and value, to opening balances or the owner — nothing is owed to anyone.
        if ((terms.source === 'OPENING' || terms.source === 'OWNER') && value !== 0n) {
          const single = currencies.length === 1 ? (currencies[0] as Currency) : 'USD';
          await deps.accounting.postPartyEntry(tx, {
            side: 'PAYABLE',
            control:
              single === 'USD'
                ? { currency: 'USD', amount: value, base: value }
                : { currency: single, amount, base: value },
            other: {
              role: terms.source === 'OPENING' ? 'OPENING_EQUITY' : 'OWNER_CURRENT',
              base: -value,
            },
            voucherType: 'JOURNAL',
            sourceType: 'SCAN_SESSION_SOURCE',
            sourceId: sessionId,
            branch: 'SY',
            memo:
              terms.source === 'OPENING'
                ? 'بضاعة موجودة قبل النظام — رصيد افتتاحي'
                : 'بضاعة من المالك أو إنتاج داخلي',
            createdById: ctx.userId,
          });
        }

        if (terms.paid) {
          if (party) {
            await settleWithBox(tx, party, terms.paid, {
              sourceType: 'SCAN_SESSION',
              sourceId: sessionId,
              note: 'كاش عند الاستلام',
              memo: `دفعة إلى ${party.nameAr} — عند الاستلام`,
              ctx,
            });
          } else {
            // Cash for goods from no one in particular: the purchase is settled in full here.
            const { currency: boxCurrency } = await deps.accounting.cashBox(tx, terms.paid.boxId);
            const single = currencies.length === 1 ? (currencies[0] as Currency) : 'USD';
            const covered =
              boxCurrency === single
                ? terms.paid.amount >= amount
                : (await deps.accounting.todayValue(boxCurrency, terms.paid.amount)) >= value;
            if (!covered) throw new CashMustCoverGoodsError();
            await deps.accounting.postPartyEntry(tx, {
              side: 'PAYABLE',
              control:
                single === 'USD'
                  ? { currency: 'USD', amount: value, base: value }
                  : { currency: single, amount, base: value },
              other: { boxId: terms.paid.boxId, amount: -terms.paid.amount },
              voucherType: 'PAYMENT',
              sourceType: 'SCAN_SESSION_CASH',
              sourceId: sessionId,
              branch: 'SY',
              memo: 'بضاعة مدفوعة كاش عند الاستلام',
              createdById: ctx.userId,
            });
          }
        }
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'parties.receipt',
          entityType: 'scan_session',
          entityId: sessionId,
          after: {
            source: terms.source,
            partyId: party?.id ?? null,
            paid: terms.paid ?? null,
            value,
          },
        });
        return done.result;
      });
    },

    /**
     * تصحيح الاستلام (developer report F-02): corrects a confirmed receipt on the receipt itself.
     * The stock moves at the line's own cost (inventory); what the receipt was owed against moves
     * with it — the supplier's bill, or opening balances / the owner — and nothing reaches the
     * profit. Receipts from before sources were kept stay owed with no name, as they were.
     */
    async correctReceipt(sessionId: string, input: unknown, ctx: WriteContext) {
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          {
            key: ctx.idempotencyKey,
            operation: 'parties.receipt.correct',
            request: { sessionId, input },
          },
          async () => {
            const { movements } = await deps.scanSessions.correctReceiptInTx(
              tx,
              sessionId,
              input,
              ctx,
            );
            const terms = await tx.receiptTerms.findUnique({ where: { sessionId } });
            const value = movements.reduce((s, m) => s + (m.valueBaseAmount ?? 0n), 0n);
            const byCurrency = new Map<Currency, { amount: bigint; base: bigint }>();
            for (const m of movements) {
              const c = m.unitCost?.currency ?? 'USD';
              const t = byCurrency.get(c) ?? { amount: 0n, base: 0n };
              t.amount += (m.unitCost?.amount ?? 0n) * BigInt(m.quantity);
              t.base += m.valueBaseAmount ?? 0n;
              byCurrency.set(c, t);
            }
            const reason = (input as { reason?: string }).reason ?? '';

            if (terms?.partyId && value !== 0n) {
              const party = await lockParty(tx, terms.partyId);
              const own = byCurrency.get(party.currency as Currency) ?? { amount: 0n, base: 0n };
              await tx.partyEntry.create({
                data: {
                  partyId: party.id,
                  kind: 'BILL_CORRECTION',
                  amount: own.amount,
                  amountBase: value,
                  sourceType: 'SCAN_SESSION',
                  sourceId: uuidv7(),
                  note: `تصحيح استلام — ${reason}`,
                  createdById: ctx.userId,
                },
              });
            }
            if (terms && (terms.source === 'OPENING' || terms.source === 'OWNER')) {
              for (const [currency, t] of byCurrency) {
                if (t.base === 0n) continue;
                await deps.accounting.postPartyEntry(tx, {
                  side: 'PAYABLE',
                  control: {
                    currency,
                    amount: currency === 'USD' ? t.base : t.amount,
                    base: t.base,
                  },
                  other: {
                    role: terms.source === 'OPENING' ? 'OPENING_EQUITY' : 'OWNER_CURRENT',
                    base: -t.base,
                  },
                  voucherType: 'JOURNAL',
                  sourceType: 'RECEIPT_CORRECTION_SOURCE',
                  sourceId: uuidv7(),
                  branch: 'SY',
                  memo: `تصحيح استلام — ${reason}`,
                  createdById: ctx.userId,
                });
              }
            }
            await writeAudit(tx, {
              actorId: ctx.userId,
              action: 'parties.receipt.correct',
              entityType: 'scan_session',
              entityId: sessionId,
              after: { value, source: terms?.source ?? null, movements: movements.length },
            });
            return { sessionId, value, movements };
          },
        ),
      );
    },

    /**
     * Confirms goods out of a warehouse (إخراج بضاعة) sold to a wholesale customer on account,
     * at the total agreed with them: their account and the wholesale sales take it.
     */
    async commitGoodsOut(sessionId: string, input: unknown, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.parties.manage);
      const terms = parse(goodsOutTermsSchema, input);
      return inTransaction(db, async (tx) => {
        const done = await deps.scanSessions.commitInTx(tx, sessionId, ctx);
        if (done.kind !== 'SALE') throw new WrongSessionKindError(sessionId, done.kind, 'SALE');
        if (done.alreadyCommitted) return done.result;
        const party = usable(await lockParty(tx, terms.partyId), 'CUSTOMER');
        const currency = party.currency as Currency;
        const base = await deps.accounting.todayValue(currency, terms.amount);
        const id = uuidv7();
        const entryId = await deps.accounting.postPartyEntry(tx, {
          side: 'RECEIVABLE',
          control: { currency, amount: terms.amount, base },
          other: { role: 'WHOLESALE_SALES', base: -base },
          voucherType: 'INVOICE',
          sourceType: OWN,
          sourceId: id,
          branch: party.branch as Branch,
          memo: `فاتورة جملة — ${party.nameAr}${terms.note ? ` — ${terms.note}` : ''}`,
          createdById: ctx.userId,
        });
        await tx.partyEntry.create({
          data: {
            id,
            partyId: party.id,
            kind: 'INVOICE',
            amount: terms.amount,
            amountBase: base,
            sourceType: 'SCAN_SESSION',
            sourceId: sessionId,
            journalEntryId: entryId,
            note: terms.note ?? null,
            createdById: ctx.userId,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'parties.invoice',
          entityType: 'scan_session',
          entityId: sessionId,
          after: { partyId: party.id, amount: terms.amount, entryId },
        });
        return done.result;
      });
    },

    // ─── The store's على الحساب (trusted calls for retail, in its transaction) ───────────────

    /** The customer a sale may go on: active, a customer, and kept in SYP like the till. */
    async customerForSale(tx: Tx, partyId: string): Promise<{ id: string; nameAr: string }> {
      const party = usable(await lockParty(tx, partyId), 'CUSTOMER');
      if (party.currency !== 'SYP') throw new PartyNotUsableError(partyId, 'NOT_SYP');
      return { id: party.id, nameAr: party.nameAr };
    },

    /** Part of a store sale goes on the customer's account, and into the store's sales now. */
    async recordPosSale(
      tx: Tx,
      s: {
        saleId: string;
        partyId: string;
        amount: bigint;
        base: bigint;
        receipt: string;
        createdById: string;
      },
    ): Promise<void> {
      const party = await lockParty(tx, s.partyId);
      const id = uuidv7();
      const entryId = await deps.accounting.postPartyEntry(tx, {
        side: 'RECEIVABLE',
        control: { currency: 'SYP', amount: s.amount, base: s.base },
        other: { role: 'RETAIL_SALES_SY', base: -s.base },
        voucherType: 'INVOICE',
        sourceType: OWN,
        sourceId: id,
        branch: 'SY',
        memo: `على الحساب — ${party.nameAr} — فاتورة ${s.receipt}`,
        createdById: s.createdById,
      });
      await tx.partyEntry.create({
        data: {
          id,
          partyId: party.id,
          kind: 'POS_SALE',
          amount: s.amount,
          amountBase: s.base,
          sourceType: 'POS_SALE',
          sourceId: s.saleId,
          journalEntryId: entryId,
          note: `فاتورة ${s.receipt}`,
          createdById: s.createdById,
        },
      });
    },

    /**
     * A refund of a sale on account goes back onto the account: the returns at today's value
     * (`returnsBase`), the account at the value it carried, an exchange difference between.
     */
    async recordPosRefund(
      tx: Tx,
      r: {
        refundId: string;
        partyId: string;
        amount: bigint;
        returnsBase: bigint;
        receipt: string;
        createdById: string;
      },
    ): Promise<void> {
      const party = await lockParty(tx, r.partyId);
      const owed = await owedBy(tx, party.id);
      const base = settledBase(owed.amount, owed.base, r.amount, r.returnsBase);
      const id = uuidv7();
      const entryId = await deps.accounting.postPartyEntry(tx, {
        side: 'RECEIVABLE',
        control: { currency: 'SYP', amount: -r.amount, base: -base },
        other: { role: 'SALES_RETURNS', base: r.returnsBase },
        voucherType: 'INVOICE',
        sourceType: OWN,
        sourceId: id,
        branch: 'SY',
        memo: `مرتجع على الحساب — ${party.nameAr} — ${r.receipt}`,
        createdById: r.createdById,
      });
      await tx.partyEntry.create({
        data: {
          id,
          partyId: party.id,
          kind: 'POS_REFUND',
          amount: -r.amount,
          amountBase: -base,
          sourceType: 'POS_SALE',
          sourceId: r.refundId,
          journalEntryId: entryId,
          note: `مرتجع ${r.receipt}`,
          createdById: r.createdById,
        },
      });
    },

    // ─── Totals ──────────────────────────────────────────────────────────────────────────────

    /**
     * «مين إلك عنده، ومين إله عليك»: what customers owe us and what we owe suppliers, per
     * currency, and what the books hold with no name on it (receipts before suppliers existed).
     */
    async summary(ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.parties.read);
      // Purchases reach the books from the stock ledger; bring them in before comparing.
      await deps.accounting.syncInventory();
      const parties = await db.party.findMany({ select: { id: true, kind: true, currency: true } });
      const owed = await balances(db);
      const totals = {
        CUSTOMER: new Map<Currency, bigint>(),
        SUPPLIER: new Map<Currency, bigint>(),
      };
      for (const p of parties) {
        const amount = owed.get(p.id)?.amount ?? 0n;
        if (amount === 0n) continue;
        const t = totals[p.kind as PartyKind];
        t.set(p.currency as Currency, (t.get(p.currency as Currency) ?? 0n) + amount);
      }
      const list = (m: Map<Currency, bigint>) =>
        [...m].map(([currency, amount]) => ({ currency, amount }));
      return {
        customers: list(totals.CUSTOMER),
        suppliers: list(totals.SUPPLIER),
        books: await unassigned(db),
      };
    },

    /**
     * Closes what the books hold with no name on it: paid from a box (any currency, at today's
     * value), or — with no box — already paid by the owner before the system (USD cents).
     */
    async settleUnassigned(input: unknown, ctx: WriteContext) {
      assertPermission(ctx, PERMISSIONS.parties.manage);
      const data = parse(settleSchema, input);
      await deps.accounting.syncInventory();
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'parties.unassigned', request: data },
          async () => {
            // One at a time: two of these could otherwise both fit in what is left.
            await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${UNASSIGNED_LOCK})`);
            const left = (await unassigned(tx))[data.side === 'PAYABLE' ? 'payable' : 'receivable']
              .unassigned;
            const sign = data.side === 'RECEIVABLE' ? 1n : -1n;
            const id = uuidv7();
            const base = data.boxId
              ? await deps.accounting.todayValue(
                  (await deps.accounting.cashBox(tx, data.boxId)).currency,
                  data.amount,
                )
              : data.amount;
            if (base > left) throw new UnassignedTooSmallError(left, base);
            const entryId = await deps.accounting.postPartyEntry(tx, {
              side: data.side,
              control: { currency: 'USD', amount: -sign * base, base: -sign * base },
              other: data.boxId
                ? { boxId: data.boxId, amount: sign * data.amount }
                : {
                    role: data.as === 'OPENING' ? 'OPENING_EQUITY' : 'OWNER_CURRENT',
                    base: sign * base,
                  },
              voucherType: data.boxId
                ? data.side === 'PAYABLE'
                  ? 'PAYMENT'
                  : 'RECEIPT'
                : 'JOURNAL',
              sourceType: 'PARTY_UNASSIGNED',
              sourceId: id,
              branch: 'SY',
              memo:
                (data.side === 'PAYABLE' ? 'بضاعة مستلمة بدون مورد' : 'ديون زبائن بدون اسم') +
                (data.boxId
                  ? ' — دُفعت من الصندوق'
                  : data.as === 'OPENING'
                    ? ' — كانت بضاعة موجودة قبل النظام (رصيد افتتاحي)'
                    : ' — دفعها المالك') +
                (data.note ? ` — ${data.note}` : ''),
              createdById: ctx.userId,
            });
            await writeAudit(tx, {
              actorId: ctx.userId,
              action: 'parties.unassigned',
              entityType: 'journal_entry',
              entityId: entryId,
              after: data,
            });
            return { entryId, left: left - base };
          },
        ),
      );
    },
  };
}

const UNASSIGNED_LOCK = 72_707_402;

export type PartiesService = ReturnType<typeof createPartiesService>;
