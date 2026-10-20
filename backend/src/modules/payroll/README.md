# Payroll Module

## Responsibility

Employees, their advances (السلف) and pay sheets (كشوف الرواتب) — ADR-015.

## Depends On

- `accounting`: `postAdvanceCash`, `postPayrollAccrual`, `postPayrollPayment`,
  `reverseSystemEntry`, `cashBox`, `balanceOfRole` — every entry in the caller's transaction.

## Used By

- the warehouse app, under «المالية» → «الرواتب والسلف» (`/finance/payroll`)

## Important Rules

- Amounts are minor units of the employee's own currency; `*Base` / `amount_base` are USD cents.
- `employee_advances` and `payroll_payments` are append-only (trigger). An advance balance is
  the sum of its rows; each row carries the USD value it adds to or takes from 1104.
- A sheet is editable only while `DRAFT`. Approving posts the expense; paying clears exactly the
  `net_base` fixed at approval. A paid sheet cannot be cancelled.
- Advances change under a row lock on the employee; payments under a lock on the sheet.
- Salaries, advances and pay need `payroll.manage`; `employees.read` sees names and jobs only.
  Opening an employee's page is audited.

## Main Services

```
listEmployees  getEmployee  createEmployee  updateEmployee  giveAdvance  repayAdvance
listRuns  getRun  createRun  updateLine  removeLine  approveRun  payRun  cancelRun  summary
```

## Tests

- `payroll-money.unit.test.ts`: net pay, proportional clearing, balances, periods.
- `payroll.int.test.ts`: advance → sheet → approve → pay with a rate change in between, the
  books agreeing throughout; the refusals; cancelling an approved sheet; who sees salaries.
