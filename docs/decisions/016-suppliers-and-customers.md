# ADR-016: Suppliers and customers

- Status: **Accepted**
- Date: 2026-10-21
- Builds on: ADR-013 (the general ledger), ADR-014 (the point of sale), ADR-015 (payroll's
  detail-plus-totals pattern)

## Decision

The owner decided this on 2026-10-21:

- **Suppliers:** some receipts are paid in cash on the spot, some are owed and paid later.
- **Customers who owe us:** known store customers buying on account (على الحساب) at the POS,
  and wholesale merchants.
- **Currency:** each supplier or customer keeps their own (SYP, USD, TRY, LYD).
- **No opening debts** to enter: the system starts from zero.

**The parties module holds the detail; the books hold the totals.** 1103 الزبائن (`RECEIVABLE`)
and 2101 الموردون (`PAYABLE`) can no longer take vouchers or journals. Only the parties module
posts to them now, or the stock ledger for purchases.

- **A party** is a supplier or a customer, with a name, phone, currency, country and notes. The
  currency cannot change once there are movements. A party who stops trading is stopped, not
  deleted.
- **Every change** to what is outstanding is an append-only `party_entries` row: `BILL`,
  `PAYMENT`, `INVOICE`, `RECEIPT`, `POS_SALE`, `POS_REFUND`. A positive amount means more is
  outstanding; a negative one settles it. Each row carries its USD value, as payroll's advances
  do, so a party's balance and the books agree.

**Receipts (استلام)** are confirmed with terms (`POST /parties/receipts/:sessionId`), in the
same transaction as the stock (`scanSessions.commitInTx`):

- **A supplier:** the goods' cost must be in the supplier's currency. A `BILL` row records it, at
  the movements' value. The books get the purchase from the stock ledger, as before (ADR-013).
- **Cash on the spot:** paid from any box. With a supplier, the payment settles part or all of
  the bill. Without one, it must cover the goods in full.
- **Neither:** owed with no name, as before suppliers existed.

**Paying and collecting (`/parties/:id/settle`).** Money goes out of, or into, any box. In another
currency than the party's, the party is credited the same value at today's rates.

- **Within the balance:** the control account is cleared at the value the debt was carried at,
  in proportion, so a full settlement clears it exactly. The box is valued at today's rate; the
  difference is a realized exchange difference.
- **Beyond the balance:** a prepayment, valued today.

**Wholesale (until phase 6).** Goods out of a warehouse (إخراج بضاعة) can be confirmed for a
customer at the total agreed with them (`/parties/goods-out/:sessionId`). It posts one INVOICE
entry: 1103 debited, 4103 مبيعات الجملة (`WHOLESALE_SALES`) credited. The cost of the goods
posts from the stock ledger as for any goods out.

**The store's على الحساب.**

- **Selling:** a sale may put part or all of its total on a customer kept in SYP; change comes
  from the cash part only. That part posts at once, as an INVOICE entry against 4101. The shift's
  close posts the cash part only: `total_base − on_account_base`.
- **Refunding:** a refund of such a sale goes back onto the account first, as far as the sale
  went on it. It debits sales returns at today's value; the account is cleared at its carried
  value.
- **Who:** the cashier picks an existing customer. Adding customers needs `parties.manage`.

**What has no name (`summary.books.*.unassigned`)** is the books' control balance minus the
named detail. On 2026-10-21 the live suppliers account held 13,902.45 $ from 62 receipts
confirmed before suppliers existed. The owner closes it from the parties page, either way:

- paid from a box;
- already paid by the owner before the system (owner's current account).

«اليوم» shows it until it is closed.

**Permissions.**

- `parties.read`: balances and statements.
- `parties.manage`: add, edit, pay, collect, wholesale invoices, cash at a receipt.
- **Granted to** the owner, the manager and the accountant.
- **Picking a party without its balance:** whoever receives goods or sells may pick a supplier
  or customer by name.

## Not now

- Credit limits.
- Debt ageing.
- Reminders.
- Opening balances per party.
- A party that is both supplier and customer.
- Full wholesale: prices, orders, reservations (phase 6).

## Consequences

- The books check for 1103 and 2101 is the unassigned line. It should change only with old
  entries and with receipts confirmed without a supplier.
- Scan-session commit is now shared: `commitSession` and `commitInTx` run the same code, and
  `commitInTx` lets another module add its records in the same transaction.

## Addendum — where received goods came from (2026-10-22)

The developer report of 2026-10-21 (F-01) found the live opening stock entered as receipts:
62 movements, 13,902.45 $ owed to «الموردون» with no supplier, and equity at 0.

**A receipt now always states its source** (`receiptTermsSchema.source`):

- **`SUPPLIER`:** owed to the named supplier (required), with their invoice number.
- **`CASH`:** paid from a box, with or without a supplier.
- **`OPENING`:** stock owned before the system. The purchase the stock ledger posts to 2101 is
  moved to 3901 in the same transaction, in the same currency and value. 2101 nets to zero for
  it, and the stock stands against opening balances.
- **`OWNER`:** the owner's own goods or production. The same, to 3201 جاري المالك.

Plain `commitSession` refuses a receipt (`RECEIPT_NEEDS_SOURCE`). The unnamed balance can be
closed as opening stock (`/parties/unassigned`, `as: OPENING`). That is the report's correction
(أ), for the owner to do once they confirm the goods were theirs.

