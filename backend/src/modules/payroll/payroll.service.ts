import type { Employee, PayrollLine } from '@prisma/client';
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
import { businessDate, isoDate } from '../accounting/posting.js';
import { advanceBalance, clearedBase, grossPay, netPay, periodOf } from './payroll-money.js';
import {
  AdvanceExceedsBalanceError,
  EmployeeCurrencyLockedError,
  NoEmployeesError,
  NothingToPayError,
  PayrollPeriodTakenError,
  PayTooLowError,
  RunHasPaymentsError,
  RunNotApprovedError,
  RunNotDraftError,
} from './payroll.errors.js';
import {
  advanceSchema,
  createEmployeeSchema,
  createRunSchema,
  employeesQuerySchema,
  payRunSchema,
  updateEmployeeSchema,
  updateLineSchema,
  type Frequency,
} from './payroll.schema.js';

export interface PayrollDeps {
  accounting: AccountingService;
}

export interface EmployeeView {
  id: string;
  nameAr: string;
  phone: string | null;
  jobTitle: string | null;
  branch: Branch;
  frequency: Frequency;
  isActive: boolean;
  /** Only with payroll.manage; null otherwise. */
  currency: Currency | null;
  salary: bigint | null;
  advanceBalance: bigint | null;
  notes: string | null;
}

export interface PayrollLineView {
  id: string;
  employee: { id: string; nameAr: string; jobTitle: string | null };
  currency: Currency;
  branch: Branch;
  salary: bigint;
  bonus: bigint;
  deduction: bigint;
  deductionNote: string | null;
  advanceDeduct: bigint;
  gross: bigint;
  net: bigint;
  /** What the employee still owes in advances now (before this sheet, while it is a draft). */
  advanceBalance: bigint;
  paid: { paymentId: string; boxName: string; paidAt: Date } | null;
}

export interface PayrollRunView {
  id: string;
  frequency: Frequency;
  periodStart: string;
  periodEnd: string;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  accrualEntryId: string | null;
  reversalEntryId: string | null;
  createdBy: string;
  createdAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  /** Per currency: what the sheet costs, what it hands out, and what is still unpaid. */
  totals: { currency: Currency; gross: bigint; net: bigint; unpaid: bigint }[];
  employees: number;
  unpaidEmployees: number;
}

const runInclude = {
  createdBy: { select: { nameAr: true } },
  approvedBy: { select: { nameAr: true } },
  lines: {
    include: {
      employee: { select: { id: true, nameAr: true, jobTitle: true } },
      payment: { include: { box: { select: { nameAr: true } } } },
    },
    orderBy: { employee: { nameAr: 'asc' } },
  },
} satisfies Prisma.PayrollRunInclude;

type RunRow = Prisma.PayrollRunGetPayload<{ include: typeof runInclude }>;

const DEDUCTED = 'DEDUCTED';

/** Employees, their advances, and pay sheets (ADR-015). Posts to the books through accounting. */
export function createPayrollService(db: Db, deps: PayrollDeps) {
  const manage = (ctx: ActorContext) => assertPermission(ctx, PERMISSIONS.payroll.manage);

  async function balances(q: Queryable, employeeIds?: string[]) {
    const rows = await q.employeeAdvance.findMany({
      where: employeeIds ? { employeeId: { in: employeeIds } } : {},
      select: { employeeId: true, kind: true, amount: true, amountBase: true },
    });
    const by = new Map<string, typeof rows>();
    for (const r of rows) by.set(r.employeeId, [...(by.get(r.employeeId) ?? []), r]);
    return new Map([...by].map(([id, list]) => [id, advanceBalance(list)]));
  }

  /** Locks the employees for the rest of the transaction: their advances change one at a time. */
  async function lockEmployees(tx: Tx, ids: string[]) {
    if (ids.length === 0) return;
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM "employees" WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) FOR UPDATE`,
    );
  }

  async function employeeOr404(q: Queryable, id: string): Promise<Employee> {
    const row = await q.employee.findUnique({ where: { id } });
    if (!row) throw new NotFoundError('employee', id);
    return row;
  }

  function toEmployeeView(e: Employee, balance: bigint | null, withPay: boolean): EmployeeView {
    return {
      id: e.id,
      nameAr: e.nameAr,
      phone: e.phone,
      jobTitle: e.jobTitle,
      branch: e.branch as Branch,
      frequency: e.frequency as Frequency,
      isActive: e.isActive,
      currency: withPay ? (e.currency as Currency) : null,
      salary: withPay ? e.salary : null,
      advanceBalance: withPay ? balance : null,
      notes: withPay ? e.notes : null,
    };
  }

  async function runOr404(q: Queryable, id: string): Promise<RunRow> {
    const row = await q.payrollRun.findUnique({ where: { id }, include: runInclude });
    if (!row) throw new NotFoundError('payroll_run', id);
    return row;
  }

  function runSummary(r: RunRow): PayrollRunView {
    const totals = new Map<Currency, { gross: bigint; net: bigint; unpaid: bigint }>();
    for (const l of r.lines) {
      const t = totals.get(l.currency as Currency) ?? { gross: 0n, net: 0n, unpaid: 0n };
      const net = netPay(l);
      t.gross += grossPay(l);
      t.net += net;
      if (!l.paymentId) t.unpaid += net;
      totals.set(l.currency as Currency, t);
    }
    return {
      id: r.id,
      frequency: r.frequency as Frequency,
      periodStart: isoDate(r.periodStart),
      periodEnd: isoDate(r.periodEnd),
      status: r.status as PayrollRunView['status'],
      accrualEntryId: r.accrualEntryId,
      reversalEntryId: r.reversalEntryId,
      createdBy: r.createdBy.nameAr,
      createdAt: r.createdAt,
      approvedBy: r.approvedBy?.nameAr ?? null,
      approvedAt: r.approvedAt,
      totals: [...totals].map(([currency, t]) => ({ currency, ...t })),
      employees: r.lines.length,
      unpaidEmployees: r.lines.filter((l) => !l.paymentId).length,
    };
  }

  async function runView(q: Queryable, r: RunRow) {
    const owed = await balances(
      q,
      r.lines.map((l) => l.employeeId),
    );
    return {
      ...runSummary(r),
      lines: r.lines.map((l): PayrollLineView => ({
        id: l.id,
        employee: l.employee,
        currency: l.currency as Currency,
        branch: l.branch as Branch,
        salary: l.salary,
        bonus: l.bonus,
        deduction: l.deduction,
        deductionNote: l.deductionNote,
        advanceDeduct: l.advanceDeduct,
        gross: grossPay(l),
        net: netPay(l),
        advanceBalance: owed.get(l.employeeId)?.amount ?? 0n,
        paid: l.payment
          ? { paymentId: l.payment.id, boxName: l.payment.box.nameAr, paidAt: l.payment.paidAt }
          : null,
      })),
    };
  }

  /** One sheet line's own numbers must hold before it is saved or approved. */
  function assertLine(
    l: Pick<PayrollLine, 'employeeId' | 'salary' | 'bonus' | 'deduction' | 'advanceDeduct'>,
  ) {
    if (grossPay(l) < 0n || netPay(l) < 0n) throw new PayTooLowError(l.employeeId);
  }

  async function advanceMove(
    kind: 'GIVE' | 'REPAY',
    employeeId: string,
    input: unknown,
    ctx: WriteContext,
  ) {
    manage(ctx);
    const data = parse(advanceSchema, input);
    return inTransaction(db, async (tx) =>
      withIdempotency(
        tx,
        {
          key: ctx.idempotencyKey,
          operation: `payroll.advance.${kind}`,
          request: { employeeId, ...data },
        },
        async () => {
          await lockEmployees(tx, [employeeId]);
          const employee = await employeeOr404(tx, employeeId);
          const owed = (await balances(tx, [employeeId])).get(employeeId) ?? {
            amount: 0n,
            base: 0n,
          };
          if (kind === 'REPAY' && data.amount > owed.amount) {
            throw new AdvanceExceedsBalanceError(employeeId, owed.amount, data.amount);
          }
          const id = uuidv7();
          const { entryId, base } = await deps.accounting.postAdvanceCash(tx, {
            kind,
            sourceId: id,
            boxId: data.boxId,
            currency: employee.currency as Currency,
            amount: data.amount,
            clearedBase:
              kind === 'REPAY' ? clearedBase(owed.amount, owed.base, data.amount) : undefined,
            branch: employee.branch as Branch,
            memo: `${kind === 'GIVE' ? 'سلفة' : 'تسديد سلفة'} — ${employee.nameAr}${data.note ? ` — ${data.note}` : ''}`,
            createdById: ctx.userId,
          });
          await tx.employeeAdvance.create({
            data: {
              id,
              employeeId,
              kind: kind === 'GIVE' ? 'GIVEN' : 'REPAID',
              amount: data.amount,
              amountBase: base,
              journalEntryId: entryId,
              note: data.note ?? null,
              createdById: ctx.userId,
            },
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: `payroll.advance.${kind.toLowerCase()}`,
            entityType: 'employee',
            entityId: employeeId,
            after: { amount: data.amount, currency: employee.currency, entryId },
          });
          const after = (await balances(tx, [employeeId])).get(employeeId)?.amount ?? 0n;
          return { advanceId: id, entryId, balance: after };
        },
      ),
    );
  }

  return {
    // ─── Employees ───────────────────────────────────────────────────────────────────────────

    /** Everyone sees names and jobs with employees.read; pay figures need payroll.manage. */
    async listEmployees(input: unknown, ctx: ActorContext): Promise<EmployeeView[]> {
      const withPay = ctx.permissions.has(PERMISSIONS.payroll.manage);
      if (!withPay) assertPermission(ctx, PERMISSIONS.employees.read);
      const q = parse(employeesQuerySchema, input ?? {});
      const rows = await db.employee.findMany({
        where: q.includeInactive === 'true' ? {} : { isActive: true },
        orderBy: { nameAr: 'asc' },
      });
      const owed = withPay ? await balances(db) : new Map<string, { amount: bigint }>();
      return rows.map((e) => toEmployeeView(e, owed.get(e.id)?.amount ?? 0n, withPay));
    },

    /** One employee with their advances and pay history. Reading pay is audited (security.md). */
    async getEmployee(id: string, ctx: ActorContext) {
      manage(ctx);
      return inTransaction(db, async (tx) => {
        const e = await employeeOr404(tx, id);
        const advances = await tx.employeeAdvance.findMany({
          where: { employeeId: id },
          orderBy: { createdAt: 'desc' },
          include: { createdBy: { select: { nameAr: true } } },
        });
        const lines = await tx.payrollLine.findMany({
          where: { employeeId: id, run: { status: { not: 'CANCELLED' } } },
          include: { run: true, payment: { select: { paidAt: true } } },
          orderBy: { run: { periodStart: 'desc' } },
          take: 24,
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'payroll.employee.read',
          entityType: 'employee',
          entityId: id,
        });
        return {
          ...toEmployeeView(e, advanceBalance(advances).amount, true),
          advances: advances.map((a) => ({
            id: a.id,
            kind: a.kind,
            amount: a.amount,
            note: a.note,
            createdBy: a.createdBy.nameAr,
            createdAt: a.createdAt,
            journalEntryId: a.journalEntryId,
          })),
          pay: lines.map((l) => ({
            runId: l.runId,
            frequency: l.run.frequency,
            periodStart: isoDate(l.run.periodStart),
            periodEnd: isoDate(l.run.periodEnd),
            status: l.run.status,
            gross: grossPay(l),
            advanceDeduct: l.advanceDeduct,
            net: netPay(l),
            paidAt: l.payment?.paidAt ?? null,
          })),
        };
      });
    },

    async createEmployee(input: unknown, ctx: ActorContext): Promise<EmployeeView> {
      manage(ctx);
      const data = parse(createEmployeeSchema, input);
      return inTransaction(db, async (tx) => {
        const row = await tx.employee.create({
          data: {
            nameAr: data.nameAr,
            phone: data.phone || null,
            jobTitle: data.jobTitle || null,
            branch: data.branch,
            currency: data.currency,
            salary: data.salary,
            frequency: data.frequency,
            notes: data.notes || null,
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'payroll.employee.create',
          entityType: 'employee',
          entityId: row.id,
          after: { nameAr: row.nameAr, currency: row.currency, salary: row.salary },
        });
        return toEmployeeView(row, 0n, true);
      });
    },

    async updateEmployee(id: string, input: unknown, ctx: ActorContext): Promise<EmployeeView> {
      manage(ctx);
      const data = parse(updateEmployeeSchema, input);
      return inTransaction(db, async (tx) => {
        await lockEmployees(tx, [id]);
        const before = await employeeOr404(tx, id);
        if (data.currency && data.currency !== before.currency) {
          const used =
            (await tx.employeeAdvance.count({ where: { employeeId: id } })) +
            (await tx.payrollLine.count({ where: { employeeId: id } }));
          if (used > 0) throw new EmployeeCurrencyLockedError(id);
        }
        const row = await tx.employee.update({
          where: { id },
          data: {
            ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
            ...(data.phone !== undefined ? { phone: data.phone || null } : {}),
            ...(data.jobTitle !== undefined ? { jobTitle: data.jobTitle || null } : {}),
            ...(data.branch !== undefined ? { branch: data.branch } : {}),
            ...(data.currency !== undefined ? { currency: data.currency } : {}),
            ...(data.salary !== undefined ? { salary: data.salary } : {}),
            ...(data.frequency !== undefined ? { frequency: data.frequency } : {}),
            ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'payroll.employee.update',
          entityType: 'employee',
          entityId: id,
          before: { salary: before.salary, currency: before.currency, isActive: before.isActive },
          after: { salary: row.salary, currency: row.currency, isActive: row.isActive },
        });
        const owed = (await balances(tx, [id])).get(id)?.amount ?? 0n;
        return toEmployeeView(row, owed, true);
      });
    },

    // ─── Advances ────────────────────────────────────────────────────────────────────────────

    /** سلفة: money handed to an employee out of a box of their salary's currency. */
    giveAdvance: async (employeeId: string, input: unknown, ctx: WriteContext) =>
      advanceMove('GIVE', employeeId, input, ctx),

    /** تسديد سلفة: the employee pays an advance back in cash, into a box. */
    repayAdvance: async (employeeId: string, input: unknown, ctx: WriteContext) =>
      advanceMove('REPAY', employeeId, input, ctx),

    // ─── Pay sheets ──────────────────────────────────────────────────────────────────────────

    async listRuns(ctx: ActorContext): Promise<PayrollRunView[]> {
      manage(ctx);
      const rows = await db.payrollRun.findMany({
        include: runInclude,
        orderBy: [{ periodStart: 'desc' }, { createdAt: 'desc' }],
        take: 60,
      });
      return rows.map(runSummary);
    },

    async getRun(id: string, ctx: ActorContext) {
      manage(ctx);
      return runView(db, await runOr404(db, id));
    },

    /**
     * كشف جديد: every active employee paid at this frequency, at their salary, taking back all
     * they owe in advances up to their pay. The owner edits the draft before approving it.
     */
    async createRun(input: unknown, ctx: ActorContext) {
      manage(ctx);
      const data = parse(createRunSchema, input);
      const { start, end } = periodOf(data);
      return inTransaction(db, async (tx) => {
        const taken = await tx.payrollRun.findFirst({
          where: {
            frequency: data.frequency,
            periodStart: new Date(`${start}T00:00:00.000Z`),
            status: { not: 'CANCELLED' },
          },
        });
        if (taken) throw new PayrollPeriodTakenError(taken.id);
        const employees = await tx.employee.findMany({
          where: { isActive: true, frequency: data.frequency },
        });
        if (employees.length === 0) throw new NoEmployeesError(data.frequency);
        const owed = await balances(
          tx,
          employees.map((e) => e.id),
        );
        const run = await tx.payrollRun.create({
          data: {
            frequency: data.frequency,
            periodStart: new Date(`${start}T00:00:00.000Z`),
            periodEnd: new Date(`${end}T00:00:00.000Z`),
            createdById: ctx.userId,
          },
        });
        await tx.payrollLine.createMany({
          data: employees.map((e) => {
            const balance = owed.get(e.id)?.amount ?? 0n;
            return {
              runId: run.id,
              employeeId: e.id,
              currency: e.currency,
              branch: e.branch,
              salary: e.salary,
              advanceDeduct: balance <= 0n ? 0n : balance < e.salary ? balance : e.salary,
            };
          }),
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'payroll.run.create',
          entityType: 'payroll_run',
          entityId: run.id,
          after: { frequency: data.frequency, start, end, employees: employees.length },
        });
        return runView(tx, await runOr404(tx, run.id));
      });
    },

    /** Bonus, deduction, this period's salary, or how much advance to take back: drafts only. */
    async updateLine(runId: string, lineId: string, input: unknown, ctx: ActorContext) {
      manage(ctx);
      const data = parse(updateLineSchema, input);
      return inTransaction(db, async (tx) => {
        const run = await runOr404(tx, runId);
        if (run.status !== 'DRAFT') throw new RunNotDraftError(runId, run.status);
        const before = run.lines.find((l) => l.id === lineId);
        if (!before) throw new NotFoundError('payroll_line', lineId);
        const next = { ...before, ...data };
        assertLine(next);
        const owed = (await balances(tx, [before.employeeId])).get(before.employeeId)?.amount ?? 0n;
        if (next.advanceDeduct > owed) {
          throw new AdvanceExceedsBalanceError(before.employeeId, owed, next.advanceDeduct);
        }
        await tx.payrollLine.update({
          where: { id: lineId },
          data: {
            ...(data.salary !== undefined ? { salary: data.salary } : {}),
            ...(data.bonus !== undefined ? { bonus: data.bonus } : {}),
            ...(data.deduction !== undefined ? { deduction: data.deduction } : {}),
            ...(data.deductionNote !== undefined
              ? { deductionNote: data.deductionNote || null }
              : {}),
            ...(data.advanceDeduct !== undefined ? { advanceDeduct: data.advanceDeduct } : {}),
          },
        });
        return runView(tx, await runOr404(tx, runId));
      });
    },

    /** Takes someone off a draft (not paid this period). */
    async removeLine(runId: string, lineId: string, ctx: ActorContext) {
      manage(ctx);
      return inTransaction(db, async (tx) => {
        const run = await runOr404(tx, runId);
        if (run.status !== 'DRAFT') throw new RunNotDraftError(runId, run.status);
        if (!run.lines.some((l) => l.id === lineId))
          throw new NotFoundError('payroll_line', lineId);
        await tx.payrollLine.delete({ where: { id: lineId } });
        return runView(tx, await runOr404(tx, runId));
      });
    },

    /**
     * اعتماد: the sheet is fixed and its expense goes into the books, dated the period's last day
     * (or today, if the period has not ended), so the month's profit includes its salaries even
     * when they are handed out next month. Advances taken back leave the employees' balances now.
     */
    async approveRun(id: string, ctx: WriteContext) {
      manage(ctx);
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'payroll.run.approve', request: { id } },
          async () => {
            const run = await runOr404(tx, id);
            if (run.status !== 'DRAFT') throw new RunNotDraftError(id, run.status);
            const ids = run.lines.map((l) => l.employeeId);
            await lockEmployees(tx, ids);
            const owed = await balances(tx, ids);

            const planned = run.lines.map((l) => {
              assertLine(l);
              const balance = owed.get(l.employeeId) ?? { amount: 0n, base: 0n };
              if (l.advanceDeduct > balance.amount) {
                throw new AdvanceExceedsBalanceError(l.employeeId, balance.amount, l.advanceDeduct);
              }
              return {
                line: l,
                advanceBase:
                  l.advanceDeduct > 0n
                    ? clearedBase(balance.amount, balance.base, l.advanceDeduct)
                    : 0n,
              };
            });

            const periodEnd = isoDate(run.periodEnd);
            const today = businessDate(new Date());
            const label = periodLabel(
              run.frequency as Frequency,
              isoDate(run.periodStart),
              periodEnd,
            );
            const { entryId, netBases } = await deps.accounting.postPayrollAccrual(tx, {
              runId: id,
              entryDate: periodEnd < today ? periodEnd : today,
              memo: `كشف رواتب ${label}`,
              createdById: ctx.userId,
              lines: planned.map(({ line: l, advanceBase }) => ({
                currency: l.currency as Currency,
                branch: l.branch as Branch,
                memo: l.employee.nameAr,
                gross: grossPay(l),
                advanceAmount: l.advanceDeduct,
                advanceBase,
                net: netPay(l),
              })),
            });

            for (const [i, { line: l, advanceBase }] of planned.entries()) {
              await tx.payrollLine.update({
                where: { id: l.id },
                data: { netBase: netBases[i]! },
              });
              if (l.advanceDeduct > 0n) {
                await tx.employeeAdvance.create({
                  data: {
                    employeeId: l.employeeId,
                    kind: DEDUCTED,
                    amount: l.advanceDeduct,
                    amountBase: advanceBase,
                    journalEntryId: entryId,
                    payrollLineId: l.id,
                    note: `كشف رواتب ${label}`,
                    createdById: ctx.userId,
                  },
                });
              }
            }
            // Two approvals of one sheet: only the first finds it a draft.
            const moved = await tx.payrollRun.updateMany({
              where: { id, status: 'DRAFT' },
              data: {
                status: 'APPROVED',
                accrualEntryId: entryId,
                approvedById: ctx.userId,
                approvedAt: new Date(),
              },
            });
            if (moved.count !== 1) throw new RunNotDraftError(id, 'APPROVED');
            await writeAudit(tx, {
              actorId: ctx.userId,
              action: 'payroll.run.approve',
              entityType: 'payroll_run',
              entityId: id,
              after: { entryId, lines: run.lines.length },
            });
            return runView(tx, await runOr404(tx, id));
          },
        ),
      );
    },

    /** ادفع: hands net pay out of one box to everyone on the sheet owed in its currency. */
    async payRun(id: string, input: unknown, ctx: WriteContext) {
      manage(ctx);
      const data = parse(payRunSchema, input);
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'payroll.run.pay', request: { id, ...data } },
          async () => {
            // One payment at a time per sheet, so no line is paid twice.
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM "payroll_runs" WHERE id = ${id}::uuid FOR UPDATE`,
            );
            const run = await runOr404(tx, id);
            if (run.status !== 'APPROVED') throw new RunNotApprovedError(id, run.status);
            const { currency } = await deps.accounting.cashBox(tx, data.boxId);
            const wanted = data.lineIds ? new Set(data.lineIds) : null;
            const due = run.lines.filter(
              (l) => !l.paymentId && l.currency === currency && (!wanted || wanted.has(l.id)),
            );
            if (due.length === 0) throw new NothingToPayError(id, currency);

            const paymentId = uuidv7();
            const label = periodLabel(
              run.frequency as Frequency,
              isoDate(run.periodStart),
              isoDate(run.periodEnd),
            );
            const total = due.reduce((s, l) => s + netPay(l), 0n);
            const entryId = await deps.accounting.postPayrollPayment(tx, {
              paymentId,
              boxId: data.boxId,
              currency,
              memo: `رواتب ${label}`,
              createdById: ctx.userId,
              items: due.map((l) => ({
                net: netPay(l),
                netBase: l.netBase ?? 0n,
                branch: l.branch as Branch,
                memo: l.employee.nameAr,
              })),
            });
            await tx.payrollPayment.create({
              data: {
                id: paymentId,
                runId: id,
                boxAccountId: data.boxId,
                currency,
                amount: total,
                journalEntryId: entryId,
                paidById: ctx.userId,
              },
            });
            await tx.payrollLine.updateMany({
              where: { id: { in: due.map((l) => l.id) }, paymentId: null },
              data: { paymentId },
            });
            await writeAudit(tx, {
              actorId: ctx.userId,
              action: 'payroll.run.pay',
              entityType: 'payroll_run',
              entityId: id,
              after: { paymentId, entryId, currency, total, lines: due.length },
            });
            return runView(tx, await runOr404(tx, id));
          },
        ),
      );
    },

    /**
     * إلغاء: a draft is dropped; an approved sheet nobody was paid from is undone in the books
     * (a reversal today) and its advances go back on the employees. A paid sheet stays.
     */
    async cancelRun(id: string, ctx: WriteContext) {
      manage(ctx);
      return inTransaction(db, async (tx) =>
        withIdempotency(
          tx,
          { key: ctx.idempotencyKey, operation: 'payroll.run.cancel', request: { id } },
          async () => {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM "payroll_runs" WHERE id = ${id}::uuid FOR UPDATE`,
            );
            const run = await runOr404(tx, id);
            if (run.status === 'CANCELLED') throw new RunNotDraftError(id, run.status);
            if (run.lines.some((l) => l.paymentId)) throw new RunHasPaymentsError(id);
            let reversalEntryId: string | null = null;
            if (run.status === 'APPROVED') {
              if (run.accrualEntryId) {
                reversalEntryId = await deps.accounting.reverseSystemEntry(tx, run.accrualEntryId, {
                  createdById: ctx.userId,
                  memo: `إلغاء كشف رواتب ${periodLabel(run.frequency as Frequency, isoDate(run.periodStart), isoDate(run.periodEnd))}`,
                });
              }
              const deducted = await tx.employeeAdvance.findMany({
                where: { kind: DEDUCTED, payrollLine: { runId: id } },
              });
              await lockEmployees(tx, [...new Set(deducted.map((d) => d.employeeId))]);
              if (deducted.length) {
                await tx.employeeAdvance.createMany({
                  data: deducted.map((d) => ({
                    employeeId: d.employeeId,
                    kind: 'RESTORED',
                    amount: d.amount,
                    amountBase: d.amountBase,
                    journalEntryId: reversalEntryId,
                    payrollLineId: d.payrollLineId,
                    note: 'إلغاء الكشف',
                    createdById: ctx.userId,
                  })),
                });
              }
            }
            await tx.payrollRun.update({
              where: { id },
              data: { status: 'CANCELLED', cancelledAt: new Date(), reversalEntryId },
            });
            await writeAudit(tx, {
              actorId: ctx.userId,
              action: 'payroll.run.cancel',
              entityType: 'payroll_run',
              entityId: id,
              before: { status: run.status },
              after: { reversalEntryId },
            });
            return runView(tx, await runOr404(tx, id));
          },
        ),
      );
    },

    /**
     * For «اليوم» and the books check: advances outstanding and pay still owed, per currency;
     * whether last month's sheet is missing; and whether the books' 1104 and 2102 equal this
     * module's detail (any difference is a bug, shown the same day).
     */
    async summary(ctx: ActorContext) {
      manage(ctx);
      const owed = await balances(db);
      const employees = await db.employee.findMany({
        select: { id: true, currency: true, isActive: true, frequency: true },
      });
      const currencyOf = new Map(employees.map((e) => [e.id, e.currency as Currency]));
      const advances = new Map<Currency, bigint>();
      let advancesBase = 0n;
      for (const [id, b] of owed) {
        if (b.amount !== 0n) {
          const c = currencyOf.get(id)!;
          advances.set(c, (advances.get(c) ?? 0n) + b.amount);
        }
        advancesBase += b.base;
      }

      const unpaidLines = await db.payrollLine.findMany({
        where: { paymentId: null, run: { status: 'APPROVED' } },
        select: {
          currency: true,
          salary: true,
          bonus: true,
          deduction: true,
          advanceDeduct: true,
          netBase: true,
        },
      });
      const unpaid = new Map<Currency, bigint>();
      let unpaidBase = 0n;
      for (const l of unpaidLines) {
        unpaid.set(l.currency as Currency, (unpaid.get(l.currency as Currency) ?? 0n) + netPay(l));
        unpaidBase += l.netBase ?? 0n;
      }

      // Last month's sheet, once that month is over, when anyone is paid monthly.
      const today = businessDate(new Date());
      const [y, m] = today.split('-').map(Number) as [number, number];
      const last = new Date(Date.UTC(y, m - 2, 1));
      const lastMonth = last.toISOString().slice(0, 7);
      const monthly = employees.some((e) => e.isActive && e.frequency === 'MONTHLY');
      const lastMonthRun = monthly
        ? await db.payrollRun.findFirst({
            where: { frequency: 'MONTHLY', periodStart: last, status: { not: 'CANCELLED' } },
            select: { id: true, status: true },
          })
        : null;
      const drafts = await db.payrollRun.count({ where: { status: 'DRAFT' } });

      const booksAdvances = await deps.accounting.balanceOfRole(db, 'EMPLOYEE_ADVANCES');
      const booksPayable = -(await deps.accounting.balanceOfRole(db, 'SALARIES_PAYABLE'));
      return {
        advances: [...advances].map(([currency, amount]) => ({ currency, amount })),
        unpaid: [...unpaid].map(([currency, amount]) => ({ currency, amount })),
        unpaidEmployees: unpaidLines.length,
        drafts,
        missingMonth: monthly && !lastMonthRun ? lastMonth : null,
        books: {
          ok: booksAdvances === advancesBase && booksPayable === unpaidBase,
          advances: { books: booksAdvances, detail: advancesBase },
          payable: { books: booksPayable, detail: unpaidBase },
        },
      };
    },
  };
}

/** "2026-10" for a month; "2026-10-03 → 2026-10-09" for a week. */
function periodLabel(frequency: Frequency, start: string, end: string): string {
  return frequency === 'MONTHLY' ? start.slice(0, 7) : `${start} → ${end}`;
}

export type PayrollService = ReturnType<typeof createPayrollService>;
