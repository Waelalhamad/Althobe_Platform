# ADR-013: The general ledger — double entry in USD, posted from the stock ledger

- Status: **Accepted**
- Date: 2026-10-19
- Research: `reports/Thobe business accounting design.md` in the old working copy (sources:
  ERPNext, Odoo, IAS 21/2/29 summaries, Syrian Commercial Law 33/2007, PwC Libya)

## Decision

The owner decided this on 2026-10-19:

- **One company, one set of books.** Every journal line says which country it belongs to (`SY` or `LY`), so
  profit can be read for Syria, Libya or both.
- **Build the ledger core first, before the POS.** The POS will post into it later.
- **Opening stock carries its real cost.** The owner types it in the opening count, as for a receipt.

**Double entry, base currency USD.** Each line holds:

- `amount_base`: USD cents, signed, debit positive.
- The line's own currency, its amount in that currency's minor units, and the rate in units per
  1 USD (ADR-012).

SYP and LYD money is therefore kept in its own currency and also valued in dollars. USD is the
functional currency, so the IAS 29 hyperinflation rules do not apply. Neither country is on the
IPTF list.

**The database enforces the rules itself.** They are triggers in the migration:

1. **Balance:** an entry's lines sum to zero and there are at least two. This is a deferred
   constraint trigger, checked at commit.
2. **Append-only:** `journal_entries`, `journal_lines` and `accounting_periods` reject UPDATE and
   DELETE. A mistake is corrected with a **reversing entry** (قيد عكسي).
3. **Closed months:** no entry may be dated on or before the end of a closed month.
4. **Accounts:** a line goes to a postable account, in that account's currency when the account
   has one (cash boxes do).

This matches Syrian Commercial Law 33/2007 art. 16–19: a daybook (دفتر اليومية) and an inventory
book (دفتر الجرد), with no erasures, kept for 10 years. We keep everything for at least 15 years,
which is Libya's tax limitation period.

**Stock posts by itself.** Every stock movement becomes one entry (`INVENTORY`):

| Movement | Debit / credit (the location's stock account takes the movement's USD value) |
| --- | --- |
| OPENING | stock / opening balances (3901) |
| PURCHASE | stock / suppliers (2101), kept in the purchase currency |
| SALE, RETURN | cost of goods sold (5101) / stock, and the reverse |
| DAMAGE | damaged goods (5102) / stock |
| ADJUSTMENT, STOCKTAKE | stock differences (5103) / stock |
| TRANSFER_OUT / IN | goods in transit (110599) / stock; the two halves cancel |

- The ledger copies the value the stock ledger stored on each movement and never recomputes a cost.
- Each location has its own stock account (1105xx).
- The **books check** (مطابقة المخزون) compares each location's stock account with its stock value.
  Goods in transit must be zero.
- Nobody can post by hand to a stock account.

**Posting runs from the accounting side.** Accounting reads the stock ledger through
`InventoryService.movementsAfter`; it never queries the stock tables itself.

- It runs before every read of the books and before a month is closed.
- A movement has at most one entry (`UNIQUE(source_type, source_id)`), so a second run posts
  nothing.
- A cursor saves rereading. It only moves past movements more than 5 minutes old: a transaction
  lasts at most 20 seconds, so an older movement is committed or gone.
- The stock module is untouched and the dependency stays one-way (accounting → inventory).

**Vouchers** (vouchers are chosen and posted by people):

| Voucher | What it does |
| --- | --- |
| سند قبض / سند صرف | one cash box against one other account |
| تحويل | box to box in the same currency |
| صرافة | currency A out, currency B in |
| قيد يومية | free lines in USD, for the accountant |

- In a صرافة, the dollar side fixes the value and the other side's rate is the deal's own rate.
- Each voucher type has gap-free numbers per year. A locked counter row hands them out, so a rollback gives a number back.
- Posting is idempotent per request key.

**Month close** (إقفال الشهر):

- Each account held in SYP or LYD is revalued at the owner's current rate. The difference goes to
  unrealized exchange differences (5502), per country.
- Then the month is locked for good.
- Months close in order, and only after they have ended.

**Chart of accounts.** It has five classes with prefix codes (1 → 11 → 1101 → 110101), as in Arab
accounting software. Code installs it at start-up, adding only what is missing. The owner may add
accounts under the headings; accounts the system uses cannot be deactivated.

**Permissions:**

| Permission | Allows |
| --- | --- |
| `accounting.view` | reading the books and reports |
| `accounting.post` | vouchers and reversals |
| `accounting.close` | closing a month and editing the chart |

The accountant role has view and post.

## Not yet

- Suppliers and customers as parties, with their own statements (7b).
- The POS posting each shift's sales (7c).
- Payroll and advances (7d).
- Year-end closing into retained earnings. Until then the balance sheet shows profit to date
  separately.
- Per-box access for cashiers.
- A scheduled nightly check. The books check runs whenever the finance pages are opened.
- Revaluing balances in accounts without a fixed currency, such as suppliers owed in SYP.
- **A local accountant must confirm** before the books are used for tax: which rate to post at
  (market or official), the currency of the statutory books, court registration of the printed
  books, and the shop's tax status. See the research report's list of 14 items.
