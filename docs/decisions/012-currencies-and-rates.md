# ADR-012: Retail prices per country, USD reporting, owner-set exchange rates

- Status: **Accepted** · the books built on it: ADR-013
- Date: 2026-10-13
- Changes: ADR-004 (the base currency becomes USD; LYD joins the list), ADR-009 (retail is no
  longer in USD)

## Decision

The owner decided this on 2026-10-13:

| Price list | Currency | For |
| --- | --- | --- |
| `RETAIL_SYP` | Syrian pound (SYP, 2 decimals) | retail in Syria |
| `RETAIL_LYD` | Libyan dinar (LYD, **3** decimals) | retail in Libya |
| `WHOLESALE` | US dollar (USD, 2 decimals) | wholesale, unchanged |

- Each retail price is typed by hand: it is not calculated from the dollar.
- A database check pairs each list with its currency. The API names them `retailSyp`,
  `retailLyd` and `wholesale` (`PRICE_LISTS` in `catalogue.types.ts`).
- The USD retail prices that existed were **cleared** (the owner's choice); wholesale prices stay.

**Reporting currency: USD.** `BASE_CURRENCY` is `USD`. Stock value, the moving average cost and
the reports are in US cents.

- `rate_to_base` now means **units of the cost's currency per 1 USD**, for example 14000 for SYP;
  it is always 1 for USD.
- `base = round_half_up(amount × 10^(2 − exponent) ÷ rate)`, computed once when the row is
  written and never recomputed (ADR-004's rule is unchanged).

**Exchange rates** live in `exchange_rates`: one row per currency (SYP, LYD), holding the units
per 1 USD.

- Only the owner changes them (`admin.rates.write`), and every change is audited.
- A cost typed in SYP or LYD starts at the owner's rate; the person may change it for that
  delivery. The rate is stamped on the cost, so changing it later never changes the past.

## Migration

`20261013000000_currencies_and_rates`:

1. Adds LYD to the currency checks.
2. Replaces the `price_list` enum and deletes the old RETAIL rows.
3. Creates `exchange_rates`. It starts empty: the owner types the rates.
4. Converts the ledger to USD by **replaying every movement in order** with the same rules as
   `inventory.ledger.ts`.
   - Costs in USD keep their exact amount.
   - Costs in SYP use the rate of the latest USD cost. If there are SYP costs and no USD cost, the
     migration stops.
   - It checks that the replayed quantities equal the balances.
   - The append-only trigger is disabled only for these updates, inside the migration's transaction.

## Not yet

- Which store sells in which currency: this comes with the POS.
- Showing a converted price where no price was typed.
