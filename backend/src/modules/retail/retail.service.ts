import { Prisma } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Queryable, type Tx } from '../../shared/db.js';
import { NotFoundError, ValidationError } from '../../shared/errors.js';
import { uuidv7 } from '../../shared/ids.js';
import { withIdempotency } from '../../shared/idempotency.js';
import { toBaseAmount } from '../../shared/money.js';
import {
  assertPermission,
  PERMISSIONS,
  type ActorContext,
  type WriteContext,
} from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import type { AccountingService } from '../accounting/accounting.service.js';
import type { CatalogueService, VariantView } from '../catalogue/catalogue.service.js';
import type { RatesService } from '../currency/rates.service.js';
import type { InventoryService } from '../inventory/inventory.service.js';
import type { LocationsService } from '../locations/locations.service.js';
import {
  DRAWER_CURRENCIES,
  netTotals,
  refundValue,
  toSyp,
  type DrawerCurrency,
  type Rates,
} from './pos-money.js';
import {
  NoRetailPriceError,
  NotAStoreError,
  NotRefundableError,
  PaymentTooLowError,
  RateNotSetError,
  RefundTooLargeError,
  ShiftAlreadyOpenError,
  ShiftNotOpenError,
} from './retail.errors.js';
import {
  closeShiftSchema,
  openShiftSchema,
  refundSchema,
  saleSchema,
  salesQuerySchema,
  shiftsQuerySchema,
  type RefundInput,
  type SaleInput,
} from './retail.schema.js';

export interface RetailDeps {
  inventory: InventoryService;
  catalogue: CatalogueService;
  locations: LocationsService;
  rates: RatesService;
  accounting: AccountingService;
}

export interface ShiftCashView {
  currency: DrawerCurrency;
  opening: bigint;
  /** Paid in by customers. */
  takings: bigint;
  /** Given back as change (SYP only). */
  change: bigint;
  /** Paid back on refunds. */
  refunds: bigint;
  expected: bigint;
  counted: bigint | null;
  difference: bigint | null;
}

export interface ShiftView {
  id: string;
  locationId: string;
  status: 'OPEN' | 'CLOSED';
  openedBy: { id: string; nameAr: string };
  openedAt: Date;
  closedBy: { id: string; nameAr: string } | null;
  closedAt: Date | null;
  journalEntryId: string | null;
  cash: ShiftCashView[];
  salesCount: number;
  refundsCount: number;
  /** SYP minor units. */
  salesTotal: bigint;
  refundsTotal: bigint;
}

export interface SaleLineView {
  lineNo: number;
  variant: Pick<VariantView, 'id' | 'sku' | 'barcode' | 'title' | 'size'> & {
    productName: string;
  };
  quantity: number;
  unitPrice: bigint;
  netTotal: bigint;
  refundOfLine: number | null;
  /** On a sale: how many of these pieces were refunded since. */
  refunded: number;
}

export interface SaleView {
  id: string;
  kind: 'SALE' | 'REFUND';
  receiptYear: number;
  receiptNo: number;
  shiftId: string;
  locationId: string;
  refundOfId: string | null;
  subtotal: bigint;
  discount: bigint;
  total: bigint;
  totalBase: bigint;
  change: bigint;
  sypRate: string;
  note: string | null;
  createdBy: { id: string; nameAr: string };
  createdAt: Date;
  lines: SaleLineView[];
  payments: { currency: DrawerCurrency; amount: bigint; rate: string; base: bigint }[];
}

const saleInclude = {
  createdBy: { select: { id: true, nameAr: true } },
  lines: { orderBy: { lineNo: 'asc' } },
  payments: true,
  refunds: { select: { lines: { select: { refundOfLine: true, quantity: true } } } },
} satisfies Prisma.PosSaleInclude;

type SaleRow = Prisma.PosSaleGetPayload<{ include: typeof saleInclude }>;

/** The store's point of sale (ADR-014): shifts, sales, refunds; posting to stock and the books. */
export function createRetailService(db: Db, deps: RetailDeps) {
  async function ownerRates(): Promise<Rates> {
    const list = await deps.rates.listRates();
    const rates: Rates = { USD: '1' };
    for (const r of list) if (r.rate) rates[r.currency] = r.rate;
    return rates;
  }

  function requireRate(rates: Rates, currency: DrawerCurrency): string {
    const rate = rates[currency];
    if (!rate) throw new RateNotSetError(currency);
    return rate;
  }

  /** The shift row, locked: sales and the close of one drawer happen one at a time. */
  async function lockShift(tx: Tx, id: string) {
    const [row] = await tx.$queryRaw<
      { id: string; status: string; location_id: string; opened_by: string }[]
    >(Prisma.sql`
      SELECT "id", "status", "location_id", "opened_by" FROM "pos_shifts"
      WHERE "id" = ${id}::uuid FOR UPDATE`);
    if (!row) throw new NotFoundError('shift', id);
    return row;
  }

  async function openShiftOf(tx: Tx, id: string) {
    const shift = await lockShift(tx, id);
    if (shift.status !== 'OPEN') throw new ShiftNotOpenError(id);
    return shift;
  }

  /** Gap-free receipt numbers per kind and year; the counter row stays locked until commit. */
  async function nextReceipt(tx: Tx, kind: 'SALE' | 'REFUND', year: number): Promise<number> {
    const [row] = await tx.$queryRaw<{ last_no: number }[]>(Prisma.sql`
      INSERT INTO "pos_counters" ("kind", "year", "last_no") VALUES (${kind}, ${year}, 1)
      ON CONFLICT ("kind", "year") DO UPDATE SET "last_no" = "pos_counters"."last_no" + 1
      RETURNING "last_no"`);
    return row!.last_no;
  }

  async function shiftView(q: Queryable, id: string): Promise<ShiftView> {
    const shift = await q.posShift.findUnique({
      where: { id },
      include: {
        cash: true,
        openedBy: { select: { id: true, nameAr: true } },
        closedBy: { select: { id: true, nameAr: true } },
        sales: { select: { kind: true, total: true, change: true, payments: true } },
      },
    });
    if (!shift) throw new NotFoundError('shift', id);
    const cash = DRAWER_CURRENCIES.map((currency): ShiftCashView => {
      const row = shift.cash.find((c) => c.currency === currency);
      const paid = shift.sales.flatMap((s) => s.payments.filter((p) => p.currency === currency));
      const takings = paid.filter((p) => p.amount > 0n).reduce((s, p) => s + p.amount, 0n);
      const refunds = -paid.filter((p) => p.amount < 0n).reduce((s, p) => s + p.amount, 0n);
      const change = currency === 'SYP' ? shift.sales.reduce((s, sale) => s + sale.change, 0n) : 0n;
      const opening = row?.opening ?? 0n;
      const expected = opening + takings - change - refunds;
      const counted = row?.counted ?? null;
      return {
        currency,
        opening,
        takings,
        change,
        refunds,
        expected,
        counted,
        difference: counted === null ? null : counted - expected,
      };
    });
    const of = (kind: string) => shift.sales.filter((s) => s.kind === kind);
    return {
      id: shift.id,
      locationId: shift.locationId,
      status: shift.status as ShiftView['status'],
      openedBy: shift.openedBy,
      openedAt: shift.openedAt,
      closedBy: shift.closedBy,
      closedAt: shift.closedAt,
      journalEntryId: shift.journalEntryId,
      cash,
      salesCount: of('SALE').length,
      refundsCount: of('REFUND').length,
      salesTotal: of('SALE').reduce((s, x) => s + x.total, 0n),
      refundsTotal: of('REFUND').reduce((s, x) => s + x.total, 0n),
    };
  }

  async function saleViews(q: Queryable, rows: SaleRow[]): Promise<SaleView[]> {
    const variants = await deps.catalogue.variantsByIds(q, [
      ...new Set(rows.flatMap((r) => r.lines.map((l) => l.variantId))),
    ]);
    const byId = new Map(variants.map((v) => [v.id, v]));
    return rows.map((r) => {
      const refunded = new Map<number, number>();
      for (const refund of r.refunds) {
        for (const l of refund.lines) {
          if (l.refundOfLine !== null) {
            refunded.set(l.refundOfLine, (refunded.get(l.refundOfLine) ?? 0) + l.quantity);
          }
        }
      }
      return {
        id: r.id,
        kind: r.kind as SaleView['kind'],
        receiptYear: r.receiptYear,
        receiptNo: r.receiptNo,
        shiftId: r.shiftId,
        locationId: r.locationId,
        refundOfId: r.refundOfId,
        subtotal: r.subtotal,
        discount: r.discount,
        total: r.total,
        totalBase: r.totalBase,
        change: r.change,
        sypRate: r.sypRate.toString(),
        note: r.note,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        lines: r.lines.map((l) => {
          const v = byId.get(l.variantId);
          return {
            lineNo: l.lineNo,
            variant: {
              id: l.variantId,
              sku: v?.sku ?? '',
              barcode: v?.barcode ?? '',
              title: v?.title ?? '',
              size: v?.size ?? null,
              productName: v?.product.nameAr ?? '',
            },
            quantity: l.quantity,
            unitPrice: l.unitPrice,
            netTotal: l.netTotal,
            refundOfLine: l.refundOfLine,
            refunded: refunded.get(l.lineNo) ?? 0,
          };
        }),
        payments: r.payments.map((p) => ({
          currency: p.currency as DrawerCurrency,
          amount: p.amount,
          rate: p.rate.toString(),
          base: p.base,
        })),
      };
    });
  }

  async function saleView(q: Queryable, id: string): Promise<SaleView> {
    const row = await q.posSale.findUnique({ where: { id }, include: saleInclude });
    if (!row) throw new NotFoundError('sale', id);
    return (await saleViews(q, [row]))[0]!;
  }

  const year = () => new Date().getUTCFullYear();

  return {
    async openShift(input: unknown, ctx: ActorContext): Promise<ShiftView> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const data = parse(openShiftSchema, input);
      return inTransaction(db, async (tx) => {
        const [location] = await deps.locations.locationsByIds(tx, [data.locationId]);
        if (!location) throw new NotFoundError('location', data.locationId);
        if (location.kind !== 'STORE' || !location.isActive) throw new NotAStoreError(location.id);
        const open = await tx.posShift.findFirst({
          where: { locationId: location.id, status: 'OPEN' },
          select: { id: true },
        });
        if (open) throw new ShiftAlreadyOpenError(open.id);
        const shift = await tx.posShift.create({
          data: {
            locationId: location.id,
            openedById: ctx.userId,
            cash: {
              create: DRAWER_CURRENCIES.map((currency) => ({
                currency,
                opening: data.opening[currency] ?? 0n,
              })),
            },
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'retail.shift.open',
          entityType: 'pos_shift',
          entityId: shift.id,
          after: { locationId: location.id, opening: data.opening },
        });
        return shiftView(tx, shift.id);
      });
    },

    /** The open shift of a store, or null: the POS screen starts from here. */
    async currentShift(locationId: string, ctx: ActorContext): Promise<ShiftView | null> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const open = await db.posShift.findFirst({
        where: { locationId, status: 'OPEN' },
        select: { id: true },
      });
      return open ? shiftView(db, open.id) : null;
    },

    async getShift(id: string, ctx: ActorContext): Promise<ShiftView> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      return shiftView(db, id);
    },

    async listShifts(input: unknown, ctx: ActorContext): Promise<ShiftView[]> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const { locationId } = parse(shiftsQuerySchema, input);
      const rows = await db.posShift.findMany({
        where: { locationId },
        orderBy: { openedAt: 'desc' },
        take: 60,
        select: { id: true },
      });
      const views: ShiftView[] = [];
      for (const r of rows) views.push(await shiftView(db, r.id));
      return views;
    },

    /** What a scanned barcode is, its SYP price, and how many the store holds. */
    async lookup(barcode: string, locationId: string, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const variant = await deps.catalogue.lookupBarcode(db, barcode);
      const available = await deps.inventory
        .getBalance({ variantId: variant.id, locationId }, ctx)
        .then((b) => b.availableQuantity)
        .catch(() => null);
      return { variant, price: variant.prices.retailSyp?.amount ?? null, available };
    },

    /**
     * «اليوم» for the owner: what the store sold since midnight in Damascus (UTC+3), and what it
     * earned over what the pieces cost. Refunds count against both.
     */
    async today(ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(
        new Date(),
      );
      const since = new Date(`${day}T00:00:00+03:00`);
      const rows = await db.posSale.findMany({
        where: { createdAt: { gte: since } },
        select: {
          kind: true,
          total: true,
          totalBase: true,
          lines: { select: { quantity: true, unitCostBase: true } },
        },
      });
      const sign = (kind: string) => (kind === 'SALE' ? 1n : -1n);
      const sum = (f: (r: (typeof rows)[number]) => bigint) =>
        rows.reduce((s, r) => s + sign(r.kind) * f(r), 0n);
      const salesBase = sum((r) => r.totalBase);
      const costBase = sum((r) =>
        r.lines.reduce((s, l) => s + l.unitCostBase * BigInt(l.quantity), 0n),
      );
      return {
        day,
        receipts: rows.filter((r) => r.kind === 'SALE').length,
        refunds: rows.filter((r) => r.kind === 'REFUND').length,
        /** Net of refunds: SYP minor units, and USD cents. */
        total: sum((r) => r.total),
        totalBase: salesBase,
        /** Sales − what the pieces cost, USD cents. */
        profitBase: salesBase - costBase,
        pieces: rows.reduce(
          (s, r) => s + Number(sign(r.kind)) * r.lines.reduce((n, l) => n + l.quantity, 0),
          0,
        ),
      };
    },

    /** One sale: the pieces leave the store, the receipt is issued, all in one transaction. */
    async sell(input: SaleInput, ctx: WriteContext): Promise<SaleView> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const data = parse(saleSchema, input);
      const discount = data.discount ?? 0n;
      // ADR-014: the cashier gives no discount; a manager does.
      if (discount > 0n) assertPermission(ctx, PERMISSIONS.retail.manage);

      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'retail.sale', request: data },
          async () => {
            const shift = await openShiftOf(tx, data.shiftId);

            const quantities = new Map<string, number>();
            for (const l of data.lines) {
              quantities.set(l.variantId, (quantities.get(l.variantId) ?? 0) + l.quantity);
            }
            const ids = [...quantities.keys()];
            const variants = await deps.catalogue.variantsByIds(tx, ids);
            const byId = new Map(variants.map((v) => [v.id, v]));
            for (const vid of ids) if (!byId.has(vid)) throw new NotFoundError('variant', vid);
            const unpriced = ids.filter((vid) => !byId.get(vid)!.prices.retailSyp);
            if (unpriced.length) throw new NoRetailPriceError(unpriced);

            const prices = ids.map((vid) => byId.get(vid)!.prices.retailSyp!.amount);
            const lineTotals = ids.map((vid, i) => prices[i]! * BigInt(quantities.get(vid)!));
            const subtotal = lineTotals.reduce((s, t) => s + t, 0n);
            if (discount >= subtotal) {
              throw new ValidationError([
                { path: 'discount', message: 'The discount must be less than the total' },
              ]);
            }
            const total = subtotal - discount;

            const rates = await ownerRates();
            const sypRate = requireRate(rates, 'SYP');
            const paid = new Map<DrawerCurrency, bigint>();
            for (const p of data.payments)
              paid.set(p.currency, (paid.get(p.currency) ?? 0n) + p.amount);
            let paidSyp = 0n;
            for (const [currency, amount] of paid) {
              requireRate(rates, currency);
              paidSyp += toSyp(amount, currency, rates);
            }
            if (paidSyp < total) throw new PaymentTooLowError(total, paidSyp);

            const saleId = uuidv7();
            const movements = await deps.inventory.postRetailMovements(
              tx,
              {
                kind: 'SALE',
                locationId: shift.location_id,
                saleId,
                lines: ids.map((vid) => ({ variantId: vid, quantity: quantities.get(vid)! })),
                note: data.note ?? null,
              },
              ctx,
            );
            const costOf = new Map(movements.map((m) => [m.variantId, m.unitCostBaseAmount ?? 0n]));
            const nets = netTotals(lineTotals, discount);
            await tx.posSale.create({
              data: {
                id: saleId,
                kind: 'SALE',
                receiptYear: year(),
                receiptNo: await nextReceipt(tx, 'SALE', year()),
                shiftId: shift.id,
                locationId: shift.location_id,
                subtotal,
                discount,
                total,
                totalBase: toBaseAmount(total, 'SYP', sypRate),
                change: paidSyp - total,
                sypRate,
                note: data.note ?? null,
                createdById: ctx.userId,
                lines: {
                  create: ids.map((vid, i) => ({
                    lineNo: i + 1,
                    variantId: vid,
                    quantity: quantities.get(vid)!,
                    unitPrice: prices[i]!,
                    netTotal: nets[i]!,
                    unitCostBase: costOf.get(vid) ?? 0n,
                  })),
                },
                payments: {
                  create: [...paid].map(([currency, amount]) => ({
                    currency,
                    amount,
                    rate: rates[currency]!,
                    base:
                      currency === 'USD'
                        ? amount
                        : toBaseAmount(amount, currency, rates[currency]!),
                  })),
                },
              },
            });
            return saleView(tx, saleId);
          },
        ),
      );
    },

    /** مرتجع: pieces of one sale come back at the cost they left with; SYP goes back. */
    async refund(saleId: string, input: RefundInput, ctx: WriteContext): Promise<SaleView> {
      assertPermission(ctx, PERMISSIONS.retail.manage);
      const data = parse(refundSchema, input);
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'retail.refund', request: { saleId, ...data } },
          async () => {
            const shift = await openShiftOf(tx, data.shiftId);
            const original = await tx.posSale.findUnique({
              where: { id: saleId },
              include: saleInclude,
            });
            if (!original) throw new NotFoundError('sale', saleId);
            if (original.kind !== 'SALE') throw new NotRefundableError(saleId);
            if (original.locationId !== shift.location_id) throw new NotRefundableError(saleId);

            const [view] = await saleViews(tx, [original]);
            const wanted = new Map<number, number>();
            for (const l of data.lines)
              wanted.set(l.lineNo, (wanted.get(l.lineNo) ?? 0) + l.quantity);

            const lines = [...wanted].map(([lineNo, quantity]) => {
              const line = view!.lines.find((l) => l.lineNo === lineNo);
              if (!line) throw new NotFoundError('sale_line', String(lineNo));
              const remaining = line.quantity - line.refunded;
              if (quantity > remaining) throw new RefundTooLargeError(lineNo, remaining);
              const row = original.lines.find((l) => l.lineNo === lineNo)!;
              return {
                row,
                quantity,
                value: refundValue(line.netTotal, line.quantity, line.refunded, quantity),
              };
            });
            const subtotal = lines.reduce((s, l) => s + l.row.unitPrice * BigInt(l.quantity), 0n);
            const total = lines.reduce((s, l) => s + l.value, 0n);
            if (total <= 0n) {
              throw new ValidationError([{ path: 'lines', message: 'Nothing to give back' }]);
            }

            const sypRate = requireRate(await ownerRates(), 'SYP');
            const totalBase = toBaseAmount(total, 'SYP', sypRate);
            const refundId = uuidv7();
            await deps.inventory.postRetailMovements(
              tx,
              {
                kind: 'REFUND',
                locationId: shift.location_id,
                saleId: refundId,
                lines: lines.map((l) => ({
                  variantId: l.row.variantId,
                  quantity: l.quantity,
                  unitCostBase: l.row.unitCostBase,
                })),
                note: data.reason,
              },
              ctx,
            );
            await tx.posSale.create({
              data: {
                id: refundId,
                kind: 'REFUND',
                receiptYear: year(),
                receiptNo: await nextReceipt(tx, 'REFUND', year()),
                shiftId: shift.id,
                locationId: shift.location_id,
                refundOfId: original.id,
                subtotal,
                discount: subtotal - total,
                total,
                totalBase,
                sypRate,
                note: data.reason,
                createdById: ctx.userId,
                lines: {
                  create: lines.map((l, i) => ({
                    lineNo: i + 1,
                    variantId: l.row.variantId,
                    quantity: l.quantity,
                    unitPrice: l.row.unitPrice,
                    netTotal: l.value,
                    refundOfLine: l.row.lineNo,
                    unitCostBase: l.row.unitCostBase,
                  })),
                },
                payments: {
                  create: [{ currency: 'SYP', amount: -total, rate: sypRate, base: -totalBase }],
                },
              },
            });
            return saleView(tx, refundId);
          },
        ),
      );
    },

    /**
     * إغلاق الوردية: the drawer is counted; the shift's money posts to the books in one entry
     * (ADR-014), and the shift is closed. The person who opened it, or a manager, closes it.
     */
    async closeShift(id: string, input: unknown, ctx: ActorContext): Promise<ShiftView> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const data = parse(closeShiftSchema, input);
      return inTransaction(db, async (tx) => {
        const shift = await openShiftOf(tx, id);
        if (shift.opened_by !== ctx.userId) assertPermission(ctx, PERMISSIONS.retail.manage);

        const before = await shiftView(tx, id);
        const sales = await tx.posSale.findMany({
          where: { shiftId: id },
          select: { kind: true, totalBase: true },
        });
        const rates = await ownerRates();
        const cash = before.cash.map((c) => {
          const counted = data.counted[c.currency] ?? 0n;
          const net = c.takings - c.change - c.refunds;
          const difference = counted - c.expected;
          return {
            currency: c.currency,
            net,
            difference,
            counted,
            rate: net !== 0n || difference !== 0n ? requireRate(rates, c.currency) : '1',
          };
        });
        const journalEntryId = await deps.accounting.postRetailShift(tx, {
          shiftId: id,
          createdById: ctx.userId,
          memo: `وردية المتجر — ${before.salesCount} فاتورة، ${before.refundsCount} مرتجع`,
          cash,
          salesBase: sales.filter((s) => s.kind === 'SALE').reduce((s, x) => s + x.totalBase, 0n),
          refundsBase: sales
            .filter((s) => s.kind === 'REFUND')
            .reduce((s, x) => s + x.totalBase, 0n),
        });
        for (const c of cash) {
          await tx.posShiftCash.update({
            where: { shiftId_currency: { shiftId: id, currency: c.currency } },
            data: { counted: c.counted },
          });
        }
        await tx.posShift.update({
          where: { id },
          data: { status: 'CLOSED', closedById: ctx.userId, closedAt: new Date(), journalEntryId },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'retail.shift.close',
          entityType: 'pos_shift',
          entityId: id,
          after: { counted: data.counted, journalEntryId },
        });
        return shiftView(tx, id);
      });
    },

    async getSale(id: string, ctx: ActorContext): Promise<SaleView> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      return saleView(db, id);
    },

    /** A shift's receipts, or one receipt by its number ("2026/7", or "7" for this year). */
    async listSales(input: unknown, ctx: ActorContext): Promise<SaleView[]> {
      assertPermission(ctx, PERMISSIONS.retail.sell);
      const data = parse(salesQuerySchema, input);
      let where: Prisma.PosSaleWhereInput;
      if (data.receipt) {
        const [y, n] = data.receipt.includes('/')
          ? data.receipt.split('/').map(Number)
          : [year(), Number(data.receipt)];
        where = { kind: 'SALE', receiptYear: y, receiptNo: n };
      } else if (data.shiftId) {
        where = { shiftId: data.shiftId };
      } else {
        throw new ValidationError([{ path: 'shiftId', message: 'Give a shift or a receipt' }]);
      }
      const rows = await db.posSale.findMany({
        where,
        include: saleInclude,
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      return saleViews(db, rows);
    },
  };
}

export type RetailService = ReturnType<typeof createRetailService>;
