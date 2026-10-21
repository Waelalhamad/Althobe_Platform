# Accounting Module

## Responsibility

The general ledger (ADR-013): the chart of accounts, journal entries, cash boxes, vouchers, the
financial reports, and closing a month. Base currency USD; each line also keeps its own currency.

## Depends On

- `inventory`: `movementsAfter` and `valueByLocation`, both trusted reads.
- `locations`: `allLocations`, for one stock account per location.
- `currency`: the owner's rates.

## Used By

- the warehouse app, under «المالية»
- payroll (ADR-015): `postAdvanceCash`, `postPayrollAccrual`, `postPayrollPayment`,
  `reverseSystemEntry` — 1104 and 2102 move only this way
- parties (ADR-016): `postPartyEntry`, `todayValue`, `todayAmount` — 1103 and 2101 move only
  this way (and purchases from the stock ledger)
- later: purchasing orders

## Important Rules

- **Only `posting.ts` (`postEntries`) writes `journal_entries` and `journal_lines`.** New
  behaviour means building a `DraftEntry`, not writing new SQL.
- Entries are append-only. A correction is a reversing entry. Stock and revaluation entries are
  never reversed by hand.
- The database also enforces balance, append-only, closed months and account currency
  (migration `20261019000000_accounting_ledger`). Never remove those triggers.
- Stock accounts (kind `INVENTORY`) take postings only from stock movements, so the books check
  (stock account = stock value per location) holds.
- Money is `bigint` minor units. Rates are decimal strings. No floats.
- Business dates are Damascus dates (`businessDate`).

## Main Services

```
installChart  syncInventory
listAccounts  createAccount  updateAccount
postVoucher   reverseEntry
boxes  entries  entry  statement  trialBalance  incomeStatement  balanceSheet  checkBooks
closingStatus  closeMonth
```

## Tests

- `accounting.unit.test.ts`: posting rules, money lines, revaluation, chart.
- `accounting.int.test.ts`: stock posting and the books check, vouchers, idempotency, reversal,
  database rules, closing a month, permissions.
