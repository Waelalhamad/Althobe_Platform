import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { permissionsFor } from '../auth/roles.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { actorWith, createTestContext, write, type World } from '../../../test/helpers.js';

// ADR-015: employees, advances and pay sheets, on the Neon test database (docs/testing.md).

const t = createTestContext();
const pay = t.services.payroll;
const books = t.services.accounting;
let w: World;
let sypBox: string;
let usdBox: string;

beforeEach(async () => {
  w = await t.reset();
  await books.installChart();
  await t.services.rates.setRate({ currency: 'SYP', rate: '122' }, w.owner);
  const accounts = await books.listAccounts(w.owner);
  sypBox = accounts.find((a) => a.systemRole === 'STORE_CASH_SYP')!.id;
  usdBox = accounts.find((a) => a.code === '110105')!.id;
});
afterAll(async () => t.close());

/** 122,000.00 ل.س a month: 1,000.00 $ at 122. */
const ahmad = async () =>
  pay.createEmployee({ nameAr: 'أحمد', currency: 'SYP', salary: '12200000' }, w.owner);
/** 500.00 $ a month. */
const sami = async () =>
  pay.createEmployee({ nameAr: 'سامي', currency: 'USD', salary: '50000' }, w.owner);

const september = async () => pay.createRun({ frequency: 'MONTHLY', period: '2026-09' }, w.owner);

describe('advances and pay sheets (ADR-015)', () => {
  it('gives an advance, takes part of it back on the sheet, pays, and the books agree throughout', async () => {
    const a = await ahmad();
    const s = await sami();
    // 24,400.00 ل.س (200.00 $) out of the store box.
    const given = await pay.giveAdvance(a.id, { boxId: sypBox, amount: '2440000' }, write(w.owner));
    expect(given.balance).toBe(2_440_000n);

    const draft = await september();
    expect(draft.status).toBe('DRAFT');
    const lineA = draft.lines.find((l) => l.employee.id === a.id)!;
    // By default the whole advance comes back, up to the pay.
    expect(lineA.advanceDeduct).toBe(2_440_000n);
    // The owner takes back half, and adds a 12,200.00 ل.س bonus.
    const edited = await pay.updateLine(
      draft.id,
      lineA.id,
      { bonus: '1220000', advanceDeduct: '1220000' },
      w.owner,
    );
    expect(edited.lines.find((l) => l.id === lineA.id)!.net).toBe(12_200_000n);

    const approved = await pay.approveRun(draft.id, write(w.owner));
    expect(approved.status).toBe('APPROVED');
    const accrual = await books.entry(approved.accrualEntryId!, w.owner);
    expect(accrual).toMatchObject({ voucherType: 'PAYROLL', entryDate: '2026-09-30' });

    let summary = await pay.summary(w.owner);
    expect(summary.books.ok).toBe(true);
    expect(summary.advances).toEqual([{ currency: 'SYP', amount: 1_220_000n }]);
    expect(summary.unpaid).toEqual(
      expect.arrayContaining([
        { currency: 'SYP', amount: 12_200_000n },
        { currency: 'USD', amount: 50_000n },
      ]),
    );

    // The pound moves before pay day: the difference is an exchange difference, not a mismatch.
    await t.services.rates.setRate({ currency: 'SYP', rate: '125' }, w.owner);
    await pay.payRun(draft.id, { boxId: sypBox }, write(w.owner));
    const done = await pay.payRun(draft.id, { boxId: usdBox }, write(w.owner));
    expect(done.unpaidEmployees).toBe(0);
    expect(done.lines.every((l) => l.paid)).toBe(true);

    summary = await pay.summary(w.owner);
    expect(summary.books).toMatchObject({ ok: true, payable: { books: 0n, detail: 0n } });
    expect(summary.unpaid).toEqual([]);

    const detail = await pay.getEmployee(a.id, w.owner);
    expect(detail.advanceBalance).toBe(1_220_000n);
    expect(detail.advances.map((x) => x.kind)).toEqual(['DEDUCTED', 'GIVEN']);
    expect(detail.pay).toMatchObject([{ net: 12_200_000n, advanceDeduct: 1_220_000n }]);
    expect(s.salary).toBe(50_000n);
  });

  it('refuses taking back more than is owed, a second sheet for the period, and paying twice', async () => {
    const a = await ahmad();
    await pay.giveAdvance(a.id, { boxId: sypBox, amount: '100000' }, write(w.owner));
    await expect(
      pay.repayAdvance(a.id, { boxId: sypBox, amount: '200000' }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'ADVANCE_EXCEEDS_BALANCE' });
    // An advance is in the salary's currency.
    await expect(
      pay.giveAdvance(a.id, { boxId: usdBox, amount: '100' }, write(w.owner)),
    ).rejects.toMatchObject({ code: 'CURRENCY_MISMATCH' });

    const run = await september();
    const line = run.lines[0]!;
    await expect(
      pay.updateLine(run.id, line.id, { advanceDeduct: '200000' }, w.owner),
    ).rejects.toMatchObject({ code: 'ADVANCE_EXCEEDS_BALANCE' });
    await expect(
      pay.updateLine(run.id, line.id, { deduction: '99999999' }, w.owner),
    ).rejects.toMatchObject({ code: 'PAY_BELOW_ZERO' });
    await expect(september()).rejects.toMatchObject({ code: 'PAYROLL_PERIOD_TAKEN' });

    await expect(pay.payRun(run.id, { boxId: sypBox }, write(w.owner))).rejects.toMatchObject({
      code: 'PAYROLL_NOT_APPROVED',
    });
    const approved = await pay.approveRun(run.id, write(w.owner));
    await expect(pay.approveRun(run.id, write(w.owner))).rejects.toMatchObject({
      code: 'PAYROLL_NOT_DRAFT',
    });
    await pay.payRun(run.id, { boxId: sypBox }, write(w.owner));
    await expect(pay.payRun(run.id, { boxId: sypBox }, write(w.owner))).rejects.toMatchObject({
      code: 'NOTHING_TO_PAY',
    });
    await expect(pay.cancelRun(run.id, write(w.owner))).rejects.toMatchObject({
      code: 'PAYROLL_HAS_PAYMENTS',
    });

    // The books' side of payroll moves only with payroll.
    const advances = (await books.listAccounts(w.owner)).find(
      (x) => x.systemRole === 'EMPLOYEE_ADVANCES',
    )!;
    await expect(
      books.postVoucher(
        {
          kind: 'PAYMENT',
          boxId: sypBox,
          counterAccountId: advances.id,
          amount: '1000',
          memo: 'x',
        },
        write(w.owner),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_USABLE' });
    await expect(
      books.reverseEntry(approved.accrualEntryId!, {}, write(w.owner)),
    ).rejects.toMatchObject({
      code: 'ENTRY_NOT_REVERSIBLE',
    });
  });

  it('cancelling an approved, unpaid sheet undoes it in the books and gives the advances back', async () => {
    const a = await ahmad();
    await pay.giveAdvance(a.id, { boxId: sypBox, amount: '2440000' }, write(w.owner));
    const run = await pay.approveRun((await september()).id, write(w.owner));
    expect((await pay.summary(w.owner)).advances).toEqual([]);

    const cancelled = await pay.cancelRun(run.id, write(w.owner));
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.reversalEntryId).toBeTruthy();
    const summary = await pay.summary(w.owner);
    expect(summary.advances).toEqual([{ currency: 'SYP', amount: 2_440_000n }]);
    expect(summary.books.ok).toBe(true);
    expect(summary.unpaid).toEqual([]);
    // The period is free again.
    expect((await september()).status).toBe('DRAFT');
  });

  it('keeps salaries from everyone without payroll.manage', async () => {
    await ahmad();
    const manager = { userId: w.owner.userId, permissions: permissionsFor(['manager']) };
    await expect(pay.listRuns(manager)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(pay.summary(manager)).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const list = await pay.listEmployees({}, manager);
    expect(list).toMatchObject([{ nameAr: 'أحمد', salary: null, advanceBalance: null }]);
    const cashier = actorWith(w.owner, [PERMISSIONS.retail.sell]);
    await expect(pay.listEmployees({}, cashier)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    const accountant = { userId: w.owner.userId, permissions: permissionsFor(['accountant']) };
    expect((await pay.listEmployees({}, accountant))[0]!.salary).toBe(12_200_000n);
  });
});
