# ADR-009: Selling prices per variant, held in USD

- Status: **Accepted**
- Date: 2026-10-06

## Decision

Every variant carries its own **retail** and **wholesale** selling price, stored in **USD** minor
units (ADR-004: integer amount + currency, never a float).

| Table | Holds |
| --- | --- |
| `variant_prices` | `variant_id`, `list` (`RETAIL` / `WHOLESALE`), `amount` (bigint, minor units), `currency` |

- One row per variant per list; no row means "not priced yet" (shown as «بدون سعر»).
- `amount >= 0` and `currency IN ('SYP', 'USD')` are database checks; the application writes USD
  only (`PRICE_CURRENCY` in the catalogue service).
- Changing prices needs **`prices.write`** (owner, manager). Everyone with `products.read` sees
  both prices — the owner decided store staff see the wholesale price too.
- Prices are set for one variant, for the variants a filter shows (bulk, one statement), or when
  variants are created. Every change writes one audit row with the prices it replaced.
- Prices are never printed on labels (docs/barcode.md), so a price change never means reprinting.

## Context

The owner treats each combination as its own product with its own price ("each detail is a new
product"), so prices attach to the variant, as `docs/domain.md` already requires. The business
prices in dollars because the local currencies move.

## Later (not built)

- **Display currency by place:** the owner sets exchange rates in a settings page — USD → Syrian
  pound and USD → **Libyan dinar (LYD)** — and each place (store, website) shows prices in its
  currency, converted at the current rate. Stored prices stay in USD.
- LYD has **3** decimal places (ISO 4217), unlike SYP and USD (2): minor-unit handling becomes
  per currency then, and `LYD` joins the currency list and the database checks.
- Customer price tiers (domain.md → PriceTier) become more `price_list` values.
- A sale records the price it was sold at; changing a price never rewrites a past sale.
