# ADR-015: Payroll and employee advances

- Status: **Accepted**
- Date: 2026-10-20
- Builds on: ADR-013 (the general ledger)

## Decision

The owner decided this on 2026-10-20:

- **Pay frequency is per employee:** some are paid monthly, some weekly.
- **The salary currency is per employee:** SYP, USD, LYD (Libya staff) or TRY.
- **Advances (السلف):** each pay sheet shows what the employee owes; the owner types how much to
  take back this time. The default is all of it, up to the pay.
- **Who sees salaries:** the owner and the accountant (`payroll.manage`). The manager, warehouse
  and store staff do not.

**The payroll module holds the detail; the books hold the totals.** Three chart accounts get
system roles: 1104 سلف الموظفين (`EMPLOYEE_ADVANCES`), 2102 رواتب مستحقة (`SALARIES_PAYABLE`) and
5202 الرواتب والأجور (`SALARIES_EXPENSE`). Vouchers and journals cannot use the first two, and
entries that payroll (or stock, or a POS shift) posted cannot be reversed from the books. They
are undone in their own module, so its records and the books never drift apart.

**Employees** have a name, job, phone, country (SY/LY), salary per period, its currency and the
frequency. The currency cannot change once they have advances or pay sheets. An employee who
leaves is stopped, not deleted.

**An advance is money out of a box** of the salary's currency.

- **Given:** a PAYMENT entry, debit 1104 at the box's value today.
- **Paid back in cash:** a RECEIPT entry. 1104 is cleared at the value the advance was carried at,
  in proportion, and the box takes today's value. The difference goes to realized exchange
  differences.
- **Every change** is an append-only `employee_advances` row (GIVEN, REPAID, DEDUCTED, RESTORED)
  holding both the amount and its USD value. So the employee's balance and 1104 always agree.

**A pay sheet (كشف الرواتب)** is per frequency and period: a calendar month, or seven days from a
chosen first day. There is one per period unless it is cancelled.

- **New sheet:** it lists every active employee at that frequency, at their salary, taking back
  their advance up to the pay.
- **While a draft:** each line's salary, bonus, deduction (with a reason) and advance can be
  edited, or the line removed.
- **Approving (اعتماد)** fixes the sheet and posts one PAYROLL entry, dated the period's last day
  (or today, if the period has not ended):

  | Account | Amount | Rate |
  | --- | --- | --- |
  | 5202 (debit) | gross = salary + bonus − deduction | today's rate |
  | 1104 (credit) | the advance taken back | the value it was carried at |
  | 2102 (credit) | net = gross − advance | today's rate |

  Each employee's exchange difference goes to realized exchange differences, in their own
  country. A month's profit therefore includes its salaries even when they are paid next month.
- **Paying (ادفع)** posts one PAYMENT entry per box. It clears 2102 at exactly the value owed and
  takes the box at today's rate; any difference is an exchange difference. One box pays one
  currency: everyone on the sheet still owed in it, or chosen employees. A payment row is
  append-only, and the sheet row is locked while paying, so nobody is paid twice.
- **Cancelling:** a draft is simply cancelled. An approved sheet nobody was paid from is undone
  by a reversal dated today, and its advances return to the employees (RESTORED rows). A sheet
  with a payment stays.

**Checking itself.** `GET /payroll/summary` compares 1104 with the sum of advance values and 2102
with the unpaid lines' values. «اليوم» and the payroll page show a red warning if they differ.
They do not: it would take a bug. «اليوم» also shows unpaid approved salaries and a missing
sheet for last month. «إقفال الشهر» warns when the month's sheet is missing or not approved.

## Not now

- Commission on sales.
- Attendance and working hours.
- Social insurance and income tax: a local accountant should say whether they apply.
- A printed pay slip.
- Linking an employee to their user account.
- An employee paid in two currencies.

## Consequences

- A new money record is always detail in its module plus totals in the books, posted in the
  same transaction through the accounting service (`postAdvanceCash`, `postPayrollAccrual`,
  `postPayrollPayment`, `reverseSystemEntry`). Payroll never builds journal lines itself.
- Reversing any module-posted entry from the books is refused (`ENTRY_NOT_REVERSIBLE`,
  `SYSTEM`). This now also covers POS shift entries.
