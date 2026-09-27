# ADR-004: Money representation and multi-currency

- Status: **Accepted** — Option B, base currency SYP
- Proposed: 2026-09-21 · Accepted: 2026-09-24

Decided up front because the answer shapes almost every financial table, and changing it later
would mean migrating every price, cost, invoice, and payment row that exists by then.

## The part that is not in question

Money is stored as an **integer amount in minor units, plus an ISO 4217 currency code**.

```prisma
priceAmount   BigInt @map("price_amount")
priceCurrency String @map("price_currency") @db.Char(3)
```

- Never `float`, `double`, or `real`. Binary floating point cannot represent decimal money, and
  the error compounds across an invoice.
- Never an amount without its currency next to it. A bare number is a future bug.
- `bigint`, not `int`: in a high-inflation currency, an ordinary invoice total can exceed a
  32-bit integer.
- In the API, amounts cross the wire as **strings**, so no JavaScript client silently converts
  them to a lossy number.
- Exchange rates and unit costs use `numeric(18,6)`.

## The open question

Does the business operate in one currency, or several?

**Option A — single currency (SYP only).**
Simplest. Every amount is in the same currency, the currency column exists but never varies,
and no conversion logic is needed.

**Option B — multi-currency, single reporting currency.**
Prices and invoices may be issued in SYP, USD, or TRY. Every transaction stores the original
amount and currency **plus** the rate used and the converted amount in the reporting currency,
captured at the moment of the transaction and never recalculated afterwards.

```
amount, currency, rate_to_base, base_amount, rate_captured_at
```

**Option C — a stable unit of account.**
Hold prices in USD internally and display SYP converted at a daily rate. Common in
high-inflation environments, and it keeps the price list from needing daily edits — but it
makes every displayed price a moving target and complicates reconciliation with cash taken.

## Recommendation

**Option B**, with a single configured base currency.

The storage cost is four extra columns on financial tables. The cost of discovering later that
a supplier invoices in USD while the shop takes SYP — with no rate recorded at transaction
time — is a set of historical records that can never be reconciled, because the rate on the day
is gone.

Even if the business is single-currency today, storing the rate and base amount from the start
costs almost nothing and removes an irreversible mistake.

## Consequences if adopted

- Every financial table carries the amount, currency, rate, and base amount.
- Rates are recorded per transaction, never looked up retroactively for a past document.
- Stock valuation is reported in the base currency, using the rate stamped on each movement.
- Price lists are per currency; a wholesale customer has a currency, not just a price tier.
- Reports state which currency they are in, always, and never mix currencies in one total.

## Decision

**Option B, base currency SYP.** Confirmed by the business owner on 2026-09-24.

Concrete rules:

- Supported currencies: `SYP`, `USD`. The list lives in one place in code (`shared/money.ts`) and
  is mirrored by a database check constraint, so adding a currency is that one-line change plus a
  one-line migration — never a change to the shape of any table.
- Minor units follow ISO 4217: exponent 2 for both SYP and USD. `125,000 SYP` is stored as
  `12500000`; `1.50 USD` as `150`.
- `rate_to_base` is **SYP per 1 unit of the foreign currency**, `numeric(18,6)`. For SYP amounts
  it is exactly `1`.
- `base_amount = round_half_up(amount × rate_to_base)`, in SYP minor units, computed once when the
  row is written and never recomputed.
- Inventory average cost is held in the base currency (SYP). See `docs/inventory.md` → Costing.
