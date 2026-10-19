# ADR-014: The store's point of sale, and the Turkish lira

- Status: **Accepted**
- Date: 2026-10-20
- Builds on: ADR-012 (prices and rates), ADR-013 (the general ledger)

## Decision

The owner decided this on 2026-10-20:

- **The Syrian store only, for now.** A Libyan store comes when it exists in the system.
- **Customers pay cash** in Syrian pounds, US dollars or Turkish lira.
- **Receipts** print on an 80 mm thermal printer.
- **The cashier gives no discount.** A manager does.

**The Turkish lira (TRY, 2 decimals)** becomes a fourth currency (`CURRENCIES`).

- It has an owner-set rate per 1 USD, like SYP and LYD.
- The store has a TRY cash box (110106).
- Costs may be typed in TRY.
- Selling prices stay SYP, LYD and USD (ADR-012).

**Shifts (الورديات).** A store has one drawer, so at most one shift is open per store (a partial
unique index).

- **Opening:** the cashier counts the drawer per currency (SYP, USD, TRY).
- **Closing:** it is counted again, against the expected amount: opening + takings − change −
  refunds.
- **Who closes:** the person who opened the shift, or a manager (`retail.manage`).

**A sale is one transaction.** It does all of this together, or nothing:

- the pieces leave the store through `InventoryService.postRetailMovements` (SALE movements at
  their moving-average cost);
- the receipt gets a gap-free number per year;
- the payments are recorded with the rate of the moment;
- the change is given in SYP and recorded.

It is idempotent per request key, so a double tap issues one receipt.

**Sale rules:**

- **Price:** the price is the effective `retailSyp` price. A piece without one cannot be sold.
- **Paying:** payments are valued in SYP through the dollar rates (`SYP per USD ÷ currency per
  USD`). What is paid must cover the total.
- **Discount:** an invoice discount needs `retail.manage`. It is spread over the lines, so each
  line knows what it was really sold for.

**Receipts are append-only** (trigger): `pos_sales`, `pos_sale_lines` and `pos_payments`.

**A refund (مرتجع) is a new receipt**, by a manager, inside an open shift:

- The pieces come back (RETURN) **at the cost they left with**, taken from the sale line.
- The customer gets back what the pieces were sold for after the discount, in SYP.
- A line can never be refunded beyond what was sold.

**The books.** Closing a shift posts **one** `RETAIL` journal entry (ADR-013), in the same
transaction:

| Line | Debit / credit |
| --- | --- |
| Net cash per currency | Dr the store box of that currency, valued at today's rate |
| Sales | Cr retail sales — Syria (4101), valued when rung up |
| Refunds | Dr sales returns (4109) |
| Counted − expected | the box against cash over/short (5298) |
| What remains | realized exchange differences (5501): sales valued at the moment against cash valued at the close |

Cost of goods sold posts from the stock movements as before.

**Permissions:**

| Permission | Who | Allows |
| --- | --- | --- |
| `retail.sell` | store staff | open and close one's own shift, sell, read |
| `retail.manage` | owner, manager | discounts, refunds, closing another person's shift |

**The app.** The switch at the top has three sides: المخزون | المتجر | المالية.

- The sell screen is built for a barcode scanner: a big scan field that keeps focus, and a big
  total.
- Change is shown live.
- The receipt prints itself on the 80 mm roll.

## Not yet

- Card or transfer payments.
- A Libyan store selling in LYD.
- Customer accounts and credit sales (7b).
- Receipts with a tax QR code: they come with the Syrian e-invoicing rules (see the ADR-013
  research).
- Moving cash from the drawer to the safe between shifts: today that is a transfer voucher on
  «المالية».
- The opening count is not compared with the books' balance of the store boxes. Record the
  drawer's starting money once with a receipt voucher (opening balances), as for any box.
