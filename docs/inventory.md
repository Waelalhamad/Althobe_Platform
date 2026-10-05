# Inventory Domain

Status: specification — being implemented in Phase 1. Check `PROJECT_STATUS.md` for what exists.

The most important document in this repository. Stock is the one number the whole business
argues about — purchasing, sales, the store, and accounting all read it. It has exactly one owner:
`InventoryService`. Nothing else writes stock. Not purchasing, not POS, not a script.

```
           Purchasing        Sales / POS        Stocktake        Transfers
                \                 |                 |                /
                 \                |                 |               /
                  +---------> InventoryService <-------------------+
                                     |
                         inventory_movements  (ledger, append-only)
                                     |
                         inventory_balances   (derived, fast reads)
```

## Core concepts

| Concept | Meaning |
| --- | --- |
| **Product** | The design, e.g. "ثوب عربي كلاسيك". Not stockable. Has a unit of measure. |
| **ProductVariant** | The stockable, sellable unit: one value per option type (cut, buttons, … fabric, colour, size — ADR-008). Carries SKU and barcode. |
| **Location** | A physical place that holds stock, with a `kind`: `WAREHOUSE` or `STORE`. |
| **InventoryMovement** | An immutable record of stock changing. The ledger, and the truth. |
| **InventoryBalance** | Current quantity of one variant at one location. Derived, fast to read. |
| **Reservation** | Quantity promised to an order but still physically present. |
| **ScanSession** | A draft batch built by scanning. Changes nothing until committed. |
| **Stocktake** | A counting session: expected vs counted, then the difference is posted. |

## Locations

Today: two warehouses and one store.

| Code | Name | Kind |
| --- | --- | --- |
| `WH1` | المخزن الرئيسي | `WAREHOUSE` |
| `WH2` | المخزن الثاني | `WAREHOUSE` |
| `STORE` | المتجر | `STORE` |

Names are placeholders until the business confirms the real ones.

The store is **not** a warehouse with a different label. It will grow POS, cashier sessions,
returns at the counter, and daily closing; a warehouse grows receiving, put-away, bins, and
damage handling. `kind` is what lets each grow without the other.

Shelves or slots inside a warehouse will be called **Bin**, never Location. The word is reserved.

### Movement policy by location kind

Which movement types each kind accepts. Enforced in `InventoryService`, defined once in
`inventory.policy.ts`. Anything not listed is rejected with `MovementNotAllowedAtLocationError`.

| Movement | WAREHOUSE | STORE | Why |
| --- | --- | --- | --- |
| `OPENING` | yes | yes | Both need an initial count |
| `PURCHASE` | yes | **no** | Supplier goods arrive at a warehouse; the store is stocked by transfer |
| `SALE` | yes | yes | Wholesale ships from a warehouse; retail sells from the store |
| `RETURN` | yes | yes | |
| `TRANSFER_OUT` / `TRANSFER_IN` | yes | yes | |
| `ADJUSTMENT` | yes | yes | |
| `DAMAGE` | yes | yes | |
| `STOCKTAKE` | yes | yes | |
| Reservation | yes | **no** | Retail does not reserve; stock leaves at the moment of sale |

Assumption to confirm: the store never receives directly from a supplier. If it does, it is a
one-line change to the policy table, not a redesign.

## Units of measure

`products.unit_of_measure`: `PIECE` (default), with `BOX`, `METER`, `KG` reserved.

- Phase 1 uses `PIECE` only. Every thobe is counted in whole pieces.
- Quantities are integers. A fractional unit (METER, KG) will be stored as an integer count of
  its minor unit (centimetres, grams) through a per-unit scale — decided in an ADR when the
  first such product appears.
- No conversions between units (a box of 10 pieces) until a real product needs one.

The column exists now so that adding a unit later is data, not a migration of every stock row.

## Source of truth

Inventory movements are **immutable** — never updated, never deleted. A database trigger rejects
any `UPDATE` or `DELETE` on `inventory_movements`, whichever role attempts it.

`inventory_balances` is a **derived, cached current balance**, written in the same transaction
as the movement that changes it, so this holds at all times:

```
balance.quantity == sum(movements.quantity) for that (variant, location)
```

`InventoryService.verifyLedger()` checks this (and every `balance_after`) — the tests run it, and a
nightly job will call it and alert on drift (scheduling arrives with the API). Drift is a bug, never a number to
be corrected by hand.

## Every mutation follows this sequence

1. Validate the request (Zod at the boundary, business rules in the service).
2. Check the actor holds the permission, and the location policy allows the movement.
3. Check the idempotency key; if already applied, return the original result.
4. Open a database transaction.
5. Lock the affected balance rows with `SELECT ... FOR UPDATE`, in deterministic order.
6. Check the business rule (sufficient stock, reservation available, and so on).
7. Insert the inventory movement rows.
8. Update the inventory balance rows.
9. Write the audit log entry.
10. Commit.

Steps 5 to 9 happen in one transaction, inside one internal primitive, `applyMovements`. Every
public operation calls it. No operation writes movements or balances any other way, so the
invariants are implemented exactly once.

## Locking order

Lock balance rows sorted by `(location_id, variant_id)` ascending, always. A transfer locks both
sides, and two simultaneous transfers in opposite directions would deadlock if each locked its
own side first. Sorting removes the cycle.

## Movement types

| Type | Sign | Created by |
| --- | --- | --- |
| `OPENING` | + | The first physical count at a location |
| `PURCHASE` | + | Goods received from a supplier |
| `SALE` | − | Delivery to a customer, or a retail sale |
| `RETURN` | + | Customer return accepted back into saleable stock |
| `TRANSFER_OUT` | − | Transfer, source side |
| `TRANSFER_IN` | + | Transfer, destination side |
| `ADJUSTMENT` | ± | A manual correction that is **not** a count; requires a reason |
| `DAMAGE` | − | Written off as damaged or unsaleable |
| `STOCKTAKE` | ± | The posted difference of an applied stocktake |

`ADJUSTMENT` and `STOCKTAKE` are deliberately different. A stocktake carries its evidence —
expected, counted, who counted, who approved. An adjustment is a correction with a reason. A
count must never be entered as an adjustment, because the audit trail would lose the evidence.

## Reference types

Every movement points at what caused it:

| Reference type | Meaning | From |
| --- | --- | --- |
| `OPENING` | Initial count | Phase 1 |
| `SCAN_SESSION` | A committed scan session (receive, transfer, damage) | Phase 1 |
| `STOCKTAKE` | An applied stocktake | Phase 1 |
| `MANUAL` | A direct adjustment with a reason | Phase 1 |
| `TRANSFER` | A transfer made outside a scan session | Phase 1 |
| `GOODS_RECEIPT` | Receipt against a purchase order | Purchasing phase |
| `PURCHASE_ORDER` | Purchase order | Purchasing phase |
| `SALES_ORDER` | Sales order, wholesale or retail | Sales / POS phase |
| `RETURN` | Customer return | Sales / POS phase |

Until purchasing exists, a scan session **is** the receiving document. When purchase orders
arrive, receiving moves to `GOODS_RECEIPT` and the scan session becomes the input to it.

## Stock rules

```
availableQuantity = quantity - reservedQuantity
```

- `quantity` never becomes negative. No configuration permits it. A database check enforces it.
- `reservedQuantity` never exceeds `quantity` and never goes below zero. Also a database check.
- A sale or an issue checks `availableQuantity`, not `quantity`.
- A transfer checks `availableQuantity` at the source.

Rejections raise typed domain errors with stable codes, never a generic `Error`:

| Error | Code |
| --- | --- |
| `InsufficientStockError` | `INSUFFICIENT_STOCK` |
| `InsufficientAvailableStockError` | `INSUFFICIENT_AVAILABLE_STOCK` |
| `MovementNotAllowedAtLocationError` | `MOVEMENT_NOT_ALLOWED_AT_LOCATION` |
| `LocationInactiveError` | `LOCATION_INACTIVE` |
| `VariantInactiveError` | `VARIANT_INACTIVE` |
| `ReservationNotFoundError` | `RESERVATION_NOT_FOUND` |
| `BarcodeNotFoundError` | `BARCODE_NOT_FOUND` |
| `InvalidBarcodeError` | `INVALID_BARCODE` |
| `ScanSessionNotOpenError` | `SCAN_SESSION_NOT_OPEN` |
| `StocktakeStateError` | `STOCKTAKE_INVALID_STATE` |
| `PermissionDeniedError` | `PERMISSION_DENIED` |

## Permissions

Code checks permissions, never role names. Inventory permissions:

| Permission | Allows |
| --- | --- |
| `inventory.view` | Read balances and movements |
| `inventory.receive` | Receive stock, including the opening count |
| `inventory.issue` | Issue stock out |
| `inventory.transfer` | Move stock between locations |
| `inventory.damage` | Write off damaged stock |
| `inventory.adjust` | Manual adjustment with a reason |
| `inventory.reserve` | Reserve stock for an order |
| `inventory.release` | Release a reservation |
| `inventory.return` | Take back goods from a customer (`RETURN`) |
| `inventory.stocktake.count` | Create a stocktake and record counts |
| `inventory.stocktake.apply` | Approve and post a stocktake |
| `inventory.cost.view` | See unit costs and valuations |

Counting and applying are separate on purpose: whoever counts should not be able to approve their
own count. Cost is separate so store staff can see stock without seeing margin.

Until authentication exists, every service call still receives an actor context
(`{ userId, permissions }`) and checks it. Real auth replaces where that context comes from, not
how it is checked.

## Service API

Writes — the only way to change stock:

```ts
receiveStock({ variantId, locationId, quantity, unitCost, reference }, ctx)
issueStock({ variantId, locationId, quantity, reference }, ctx)
transferStock({ variantId, fromLocationId, toLocationId, quantity, reference }, ctx)
adjustStock({ variantId, locationId, delta, reason }, ctx)
damageStock({ variantId, locationId, quantity, reason }, ctx)
reserveStock({ variantId, locationId, quantity, orderId }, ctx)
releaseStock({ reservationId }, ctx)
```

Reads:

```ts
getBalance({ variantId, locationId }, ctx)
listBalances({ locationId, filter, page }, ctx)
getMovements({ variantId, locationId, from, to, page }, ctx)
resolveBarcode(code, ctx)   // -> variant with product, options + title, size, SKU, UoM
```

`ctx` is `{ userId, permissions, idempotencyKey? }`. Every write requires an `idempotencyKey`:
a scanner on weak signal will retry, and a retry must never create a second movement.

## Barcode workflow — scan sessions

Staff should almost never touch the keyboard. The scanner is the input device; the system does
the lookup and the counting.

```
USB / Bluetooth scanner (HID keyboard wedge)
      -> browser input
      -> scan input component
      -> resolveBarcode()
      -> ProductVariant (product, options, SKU)
      -> ScanSession line  (+1 per scan)
      -> review
      -> commit  -> InventoryService -> movements
```

A **ScanSession** is a draft. Scanning changes nothing in the ledger.

```
OPEN -> COMMITTED
     \-> CANCELLED
```

| Session kind | Location | Commits as | Permission |
| --- | --- | --- | --- |
| `OPENING` | any | `OPENING` movements | `inventory.receive` |
| `RECEIVE` | WAREHOUSE | `PURCHASE` movements | `inventory.receive` |
| `TRANSFER` | from → to | `TRANSFER_OUT` + `TRANSFER_IN` pairs | `inventory.transfer` |
| `DAMAGE` | any | `DAMAGE` movements | `inventory.damage` |
| `SALE` | any | `SALE` movements (goods leaving to a customer); optional customer/invoice note | `inventory.issue` |
| `RETURN` | any | `RETURN` movements (goods coming back); **reason required** | `inventory.return` |

`SALE` and `RETURN` sessions bridge the gap until the POS (Phase 4) and sales (Phase 6) record
sales and returns as documents. Sales leave at the moving-average cost and returns re-enter at the
current average. A damaged return is recorded as a return, then as damage, so both facts stay in
the ledger. The app suggests one sale session per customer or invoice, so balances stay current
during the day.

Behaviour:

- **Scan** — resolves the barcode, then adds +1 to that variant's line. Scanning the same
  thobe 37 times gives one line: `ثوب X · قطني · أبيض · 54 — quantity 37`.
- **Set quantity** — for a sealed carton of 20, scan once and type 20. The line quantity is set,
  not added to.
- **Set cost** (RECEIVE and OPENING) — unit cost, currency (SYP or USD), and the exchange rate in
  force. **Required on every RECEIVE line** before commit; optional for OPENING (costs may be
  unknown at the first count, and that stock then enters at zero value until corrected).
- **Every scan carries a client-generated `scanId`.** A double trigger pull sends the same
  `scanId` twice and is counted once. Every scan is recorded as an event, so a session shows who
  scanned what, and when.
- **Unknown barcode** — rejected with `BARCODE_NOT_FOUND`, never guessed. The UI asks.
- **Commit** — one transaction: every line goes through `applyMovements`, all or nothing, then
  the session becomes `COMMITTED` and immutable. Committing twice returns the first result.
- **Opening is once** — an `OPENING` commit is refused for any variant that already has movements at
  that location (`OPENING_ALREADY_RECORDED`). Later corrections are stocktakes.
- **Cancel** — the session is kept, marked `CANCELLED`, and never touched the ledger.

The first real use of the system is an `OPENING` scan session at each location: counting what is
physically on the shelves into the ledger.

## Transfers

A transfer atomically creates exactly two movements, sharing a `transfer_id`:

```
TRANSFER_OUT   source        -quantity
TRANSFER_IN    destination   +quantity
```

Both succeed or both roll back. There is no state where the stock exists in neither location, or
in both. Goods in transit for days, if that ever matters, become a transit location — two
transfers, not a new mechanism.

## Reservations

A reservation does not move stock. It marks part of it as spoken for.

```
reserve 20 of 100:   quantity 100, reserved 20, available 80
```

- Warehouse locations only (see the policy table).
- Wholesale orders reserve at confirmation, and release on delivery or cancellation.
- Delivery releases the reservation and issues the stock in one transaction.
- Reservations carry an optional expiry; a scheduled job to release stale ones arrives with the
  API (Phase 2+). Until then they are released explicitly.

## Stocktake

A stocktake is not an adjustment. It records the evidence of a count and posts the difference.

```
DRAFT -> COUNTING -> REVIEW -> APPLIED
                  \-> CANCELLED
```

| Step | What happens |
| --- | --- |
| `DRAFT` | Location and scope chosen: `FULL` (everything at the location) or `PARTIAL` (chosen variants). |
| `COUNTING` | The expected quantity of every in-scope variant is **snapshotted**. Staff scan; each scan adds to `counted`. Nothing in the ledger changes. |
| `REVIEW` | Each line shows expected, counted, difference. In a `FULL` count, variants expected but never scanned appear as counted 0 and must be confirmed, not silently skipped. |
| `APPLIED` | One `STOCKTAKE` movement per line with a non-zero difference, all in one transaction, reason recorded. |

```
Expected  100
Counted    97
Difference -3   ->  STOCKTAKE movement -3
```

Rules:

- The difference is applied as a **delta** to the current balance, not by overwriting the
  balance with the counted figure. Movements that happen while counting are preserved.
- If movements hit the location after the snapshot, review warns about it, because the count may
  have straddled them.
- **Counting is blind** in the warehouse app: expected quantities and differences are shown only
  at review, so a count cannot be nudged toward what the system says.
- A stocktake is applied once. Enforced by status and a unique constraint.
- Applying needs `inventory.stocktake.apply` **and** a different user from whoever created it.

## Costing

**Moving weighted average**, per (variant, location), in the **base currency (SYP)**.

Each balance stores its **total value** (`value_base_amount`), not an average. The average is
derived as `value / quantity` whenever it is needed, so repeated averaging can never accumulate
rounding error:

```
receive:  value += unitCostBase × quantity
issue:    value -= round(value × issued / quantity)      — the last unit takes all remaining value
average = round(value / quantity)
```

- Receipts may be costed in SYP or USD. Each movement stores the original unit cost and currency,
  the exchange rate in force, the unit cost converted to base, and the signed value it moved.
- Inbound movements without an explicit cost (`RETURN`, positive `ADJUSTMENT`/`STOCKTAKE`) enter at
  the current average.
- A transfer moves its value unchanged: `TRANSFER_IN` carries exactly the value `TRANSFER_OUT` took.
- All arithmetic is integer minor units, rounded half-up.
- The rate stamped on a movement is never recalculated. History values at the rate of its day.
- `balance.value == sum(movements.value)` is checked with the quantity invariant.

See [ADR-004](decisions/004-money-and-currency.md).

## Forbidden

- Never modify `inventory_balances` outside `InventoryService`.
- Never update or delete an `inventory_movement`.
- Never create stock without a movement row.
- Never put stock logic in a controller, a job, a seed script, or a React component.
- Never write one side of a transfer without the other.
- Never record a count as an `ADJUSTMENT` — counts go through a stocktake.
- Never bypass the ledger to "just fix a number" — use `adjustStock` with a reason.
- Never trust a quantity from the client without re-reading the locked balance.

## Required tests

Non-negotiable, with exact expected numbers, in [`testing.md`](testing.md).
