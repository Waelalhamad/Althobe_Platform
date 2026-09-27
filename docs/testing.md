# Testing Strategy

Status: specification. No tests exist yet.

A test suite exists so that nobody has to say "it works on my machine". If a rule in `docs/`
is not enforced by a test or a database constraint, it is a wish, not a rule.

## Tooling

| Level | Tool | Runs against |
| --- | --- | --- |
| Unit | Vitest | Pure functions, in memory |
| Integration | Vitest | A real PostgreSQL: the Neon `test` branch (`TEST_DATABASE_URL`) |
| E2E | Playwright | The running apps |

## Unit tests

For pure business logic only: price calculation, average cost, barcode check digit, date and
money helpers, state-machine transitions, permission resolution.

Fast, no database, no network, no mocks of things you own.

## Integration tests

Required — not optional — for:

- database operations and constraints
- transactions and rollback
- **everything in the inventory module**
- authentication and sessions
- permission enforcement on endpoints
- money calculations that touch the database

These run against a real PostgreSQL — the Neon `test` branch, never the main branch. The suite
refuses to start if `TEST_DATABASE_URL` is missing or equals `DATABASE_URL` / `DIRECT_URL`.
**Do not mock Prisma.** A mocked transaction
proves nothing about whether a transaction actually rolls back, which is the only thing worth
proving here.

## E2E tests

For critical user journeys only, because they are slow and brittle:

- Receive goods against a purchase order in `apps/warehouse`
- Complete a retail sale in `apps/retail`
- Place a wholesale order and see the reservation appear
- Run a stocktake from counting to applied
- Log in, be denied an action, be granted it, succeed

Every E2E test also runs once in RTL layout with Arabic copy.

## Inventory: minimum required coverage

These exact scenarios must exist, with these exact numbers.

**Receiving**

```
start 100 -> receive 20 -> quantity 120
one PURCHASE movement, quantity +20, balance_after 120
```

**Issuing**

```
start 100 -> issue 20 -> quantity 80
one SALE movement, quantity -20, balance_after 80
```

**Insufficient stock**

```
start 100 -> issue 101 -> rejected with InsufficientStockError
quantity stays 100, no movement row is created
```

**Transfer**

```
A = 100, B = 20
transfer 30 from A to B
A = 70, B = 50
exactly two movements, TRANSFER_OUT -30 and TRANSFER_IN +30, sharing one transfer_id
```

**Transfer rollback**

```
force a failure after the TRANSFER_OUT is written
A = 100, B = 20, unchanged
zero movement rows exist for this transfer
```

**Reservation**

```
start 100 -> reserve 20
quantity 100, reserved 20, available 80
issue 90 -> rejected, only 80 available
issue 80 -> allowed, quantity 20, reserved 20, available 0
```

**Release**

```
quantity 100, reserved 20 -> release 20
quantity 100, reserved 0, available 100
```

**Idempotency**

```
receive 20 with key K, twice
quantity 120, exactly one movement row
the second call returns the same result as the first
```

**Concurrency**

```
quantity 100
two parallel issues of 60 each
one succeeds, one fails with InsufficientStockError
final quantity 40, exactly one movement row
```

That last test is the one that catches missing row locks. It must run with real parallel
connections, not sequential calls pretending to be parallel.

**Ledger integrity**

```
after any sequence of operations
balance.quantity == sum(movements.quantity) for that (variant, location)
```

**Append-only ledger**

```
UPDATE or DELETE on any inventory_movements row
rejected by the database trigger, whatever the calling code
```

**Location policy**

```
receive (PURCHASE) 10 at STORE  -> rejected, MOVEMENT_NOT_ALLOWED_AT_LOCATION
reserve 5 at STORE              -> rejected, MOVEMENT_NOT_ALLOWED_AT_LOCATION
transfer 10 WH1 -> STORE        -> allowed
```

**Permission**

```
actor without inventory.transfer calls transferStock
rejected with PERMISSION_DENIED, balances unchanged, no movement row
```

**Scan session — accumulate and commit**

```
RECEIVE session at WH1, variant X starts at 0
scan X 37 times               -> one line, quantity 37; ledger still 0
scan Y once, set quantity 20  -> line Y quantity 20
commit                        -> X = 37, Y = 20; two PURCHASE movements, reference SCAN_SESSION
commit again                  -> same result, still exactly two movements
```

**Scan session — duplicate scan**

```
scan X with scanId S, then again with scanId S
line quantity 1, one scan event
```

**Scan session — unknown barcode and cancel**

```
scan a valid internal barcode that no variant carries -> BARCODE_NOT_FOUND, line count unchanged
scan a code with a wrong check digit                -> INVALID_BARCODE
cancel an OPEN session                     -> CANCELLED, zero movements
```

**Stocktake**

```
WH1 has X = 100
start counting            -> expected snapshot 100
count X as 97 (scans + typed) -> counted 97, difference -3, ledger still 100
apply by the creator      -> rejected (needs a second user)
apply by another user     -> one STOCKTAKE movement -3, X = 97
apply again               -> rejected, STOCKTAKE_INVALID_STATE
```

**Stocktake — movement during counting**

```
X = 100, snapshot 100, counted 97
meanwhile receive +10 (X = 110)
apply -> delta -3 posted, X = 107
```

**Moving average cost, SYP and USD**

```
receive 10 at 1,000 SYP                    -> avg 1,000 SYP
receive 10 at 1.00 USD, rate 13,000 SYP    -> avg (10*1,000 + 10*13,000) / 20 = 7,000 SYP
the USD movement stores 1.00 USD, rate 13,000, base cost 13,000 SYP
```

**Barcode**

```
data 200000000001 -> check digit 5 -> 2000000000015
2000000000016 (bad check digit) -> INVALID_BARCODE
```

## What every business feature must cover

Not just the happy path. For each operation:

- happy path
- validation failure (bad input shape, negative quantity, zero quantity)
- business rule failure (insufficient stock, credit limit, closed period)
- permission failure (authenticated but not authorized)
- concurrency or transaction failure (rolls back completely)

## Test data

- Factories, not fixtures copied between files. One `makeVariant()`, one `makeLocation()`.
- Every test creates what it needs and cleans up by truncating inside a transaction.
- No test depends on another test having run first.
- No test depends on the current date without freezing time.

## Naming

```ts
describe('InventoryService.transferStock', () => {
  it('moves quantity between locations atomically', ...)
  it('rejects a transfer larger than available stock', ...)
  it('rolls back both sides when the destination update fails', ...)
});
```

The name states the behaviour, not the implementation.

## CI

Every push runs, in order, and all must pass:

```
install -> typecheck -> lint -> unit tests -> integration tests -> build
```

E2E runs on pull requests to `main` and nightly.

Rules:

- Red CI means the task is not done. There is no "will fix in a follow-up" for a red pipeline.
- A flaky test is a bug. Fix it or delete it with a note — never retry it into passing.
- Never delete, `skip`, or weaken a test to make the suite green. If a test is genuinely wrong,
  say why in the PR before changing it.

## Coverage

No global percentage target, because a percentage is easy to game. Instead:

- `backend/modules/inventory` — every service method, every error path
- money and pricing code — every branch
- auth and permissions — every guard
- everything else — tested where it carries a business rule
