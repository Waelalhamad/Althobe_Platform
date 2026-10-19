# Retail Module

## Responsibility

The store's point of sale (ADR-014): shifts and the drawer per currency, sales, refunds,
receipts.

## Depends On

- `inventory`: `postRetailMovements`, so stock leaves (and comes back) in the sale's
  transaction.
- `catalogue`: `lookupBarcode` and `variantsByIds`, for the piece and its `retailSyp` price.
- `locations`: the store.
- `currency`: the owner's rates.
- `accounting`: `postRetailShift`, one journal entry when a shift closes.

## Used By

- the warehouse app, under «المتجر» (`/pos`)

## Important Rules

- Prices, totals and change are SYP minor units. Payments keep their own currency and rate.
- A sale and a refund are idempotent per request key, and append-only (trigger). A correction
  is a refund: a new receipt.
- At most one open shift per store. A sale or a close locks the shift row, so they happen one
  at a time.
- Discounts and refunds need `retail.manage`. Closing another person's shift needs it too.
- Money rules live in `pos-money.ts` (and its mirror `toSypMinor` in the app). No floats.

## Main Services

```
openShift  currentShift  getShift  listShifts  closeShift
lookup  sell  refund  getSale  listSales
```

## Tests

- `pos-money.unit.test.ts`: currency values, discount spread, refund parts.
- `retail.int.test.ts`: mixed-currency sale and change, refusals, discount and idempotency,
  refund at cost, one shift per store, shift close posting and the books check.
