# Inventory Module

## Responsibility

Owns stock: the append-only movement ledger, current balances, reservations, scan sessions, and
stocktakes. The single source of truth for "how many, where, worth what". Does not own products
(catalogue) or locations (locations).

## Depends On

- catalogue — variant lookup, barcode resolution
- locations — location kind and status

## Used By

Purchasing, sales, POS, wholesale, accounting — later. Always through `InventoryService`,
`ScanSessionService`, or `StocktakeService`. Never through the tables.

## Important Rules

- `applyMovements` in `inventory.ledger.ts` is the **only** code that writes
  `inventory_movements` or `inventory_balances`. Every operation goes through it.
- A count is a stocktake, never an adjustment.
- Every write carries an idempotency key (stock ops) or a scanId / session status (scan sessions).

## Main Services

```
InventoryService      receiveStock  issueStock  transferStock  adjustStock  damageStock
                      reserveStock  releaseStock
                      getBalance  listBalances  getMovements  resolveBarcode  verifyLedger
ScanSessionService    openSession  scan  setLineQuantity  setLineCost  removeLine
                      getSession  commitSession  cancelSession
StocktakeService      createStocktake  startCounting  scanCount  setCount  submitForReview
                      getStocktake  applyStocktake  cancelStocktake
```

Full rules: [`docs/inventory.md`](../../../../docs/inventory.md).
