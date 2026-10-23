# API Conventions

Status: specification. No endpoints exist yet.

The API is the contract between `backend/` and the four apps. It is a public interface: once
an app ships against it, changing it breaks something someone is using.

## Shape

REST over HTTP, JSON only, versioned in the path.

```
/api/v1/<resource>
```

Resources are plural nouns. Actions that are not CRUD are sub-resources, not verbs in a path:

```
GET    /api/v1/inventory/balances?locationId=...
GET    /api/v1/inventory/movements?variantId=...
POST   /api/v1/inventory/transfers
POST   /api/v1/inventory/adjustments
POST   /api/v1/sales-orders/:id/confirm
POST   /api/v1/stocktakes/:id/apply
```

Not `/api/v1/doTransfer`, not `/api/v1/inventory?action=transfer`.

## Endpoints — Phase 2 (thin slice to the scanner) — implemented

All under `/api/v1`, in `backend/src/http/routes.ts`. Every route except login requires a session;
the service behind it checks the permission. Scan-session writes are idempotent by construction
(`scanId` per scan, session status for commit), so they do not take an `Idempotency-Key`; the direct
stock endpoints arriving in Phase 3 will require it.

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/auth/login` · `/auth/logout` | — |
| `GET` | `/auth/me` | authenticated |
| `GET` | `/locations` | `inventory.view` |
| `PATCH` | `/locations/:id` (`nameAr`, `nameEn`; code and kind never change) | `admin.locations.write` |
| `GET` | `/rates` — `[{ currency: SYP \| LYD, rate (units per 1 USD) \| null, updatedAt }]` (ADR-012) | signed in |
| `PUT` | `/rates` — `{ currency, rate }` | `admin.rates.write` |
| `GET` / `POST` | `/categories` — `{ nameAr, code?, parentId?, groupIds? }` (ADR-011) | `products.read` / `products.write` |
| `PATCH` / `DELETE` | `/categories/:id` — name, code, `parentId`, `groupIds`, `isActive`, `move`; delete only without stock | `products.write` |
| `POST` | `/categories/:id/products/generate` — `{ selections: [{ groupId, valueIds }], prices? }` (a type left out = «بدون»; sizes required) | `products.write` (+ `prices.write` with prices) |
| `GET` | `/products?categoryId=` · `/products/:id` (with its sizes) | `products.read` |
| `PATCH` / `DELETE` | `/products/:id` — `{ isActive }`; delete only without stock | `products.write` |
| `POST` | `/products/prices` — `{ productIds, retailSyp?, retailLyd?, wholesale? }` (minor units of SYP, LYD (3 decimals), USD as strings; `null` clears — ADR-012) | `prices.write` |
| `GET` | `/variants?q=&productId=&categoryId=` | `products.read` |
| `PATCH` / `DELETE` | `/variants/:id` — `{ isActive }`; delete only without stock | `products.write` |
| `POST` | `/variants/prices` — a size's own price, overriding the product's; `null` goes back | `prices.write` |
| `GET` | `/products/:id/photos` | `products.read` |
| `POST` | `/products/:id/photos` — `{ image, thumb, width, height }` (base64; body ≤ 5 MB) | `products.write` |
| `PATCH` | `/photos/:id` — `{ move: up/down/first }` | `products.write` |
| `DELETE` | `/photos/:id` | `products.write` |
| `GET` | `/photos/:id?size=thumb\|full` → 302 to a signed S3 link (ADR-010) | `products.read` |
| `GET` | `/option-groups` (types with their values) | `products.read` |
| `POST` | `/option-groups` · `/option-groups/:id/values` | `products.write` |
| `PATCH` | `/option-groups/:id` · `/option-values/:id` — rename, `isActive`, `move: up/down` | `products.write` |
| `DELETE` | `/option-groups/:id` · `/option-values/:id` — only while unused (`OPTION_IN_USE` names the categories); SIZE is `OPTION_BUILT_IN` | `products.write` |
| `GET` | `/barcodes/:code` | `inventory.view` |
| `GET` | `/inventory/balances?locationId=&q=` | `inventory.view` |
| `GET` | `/inventory/movements?variantId=&locationId=` | `inventory.view` |
| `GET` | `/scan-sessions` (open sessions, to resume) | `inventory.view` |
| `POST` | `/scan-sessions` | by kind: `OPENING`/`RECEIVE` → `inventory.receive`, `TRANSFER` → `.transfer`, `DAMAGE` → `.damage`, `SALE` → `.issue`, `RETURN` → `.return` |
| `GET` | `/scan-sessions/:id` | `inventory.view` |
| `POST` | `/scan-sessions/:id/scans` | same as the session kind |
| `PATCH` / `DELETE` | `/scan-sessions/:id/lines/:variantId` | same as the session kind |
| `POST` | `/scan-sessions/:id/commit` · `/cancel` | same as the session kind |

A variant (one size of a product) is returned with `options: [{ groupId, groupKey, group, valueId,
value }]` (the product's design, then the size, in type order), `title` (the values joined with
« · »), `size`, `prices: { retailSyp, retailLyd, wholesale }` (its own price, else the product's; each
`{ amount, currency }` in minor units of SYP, LYD and USD, or null — ADR-012), `ownPrices`, `photoId` (the product's
main photo) and `product: { id, code, nameAr (the category), title (the design), categoryId }`
(ADR-011). Until 2026-10-05 it had `fabric`, `colour`, `size` instead (ADR-008).

Labels are rendered in the browser (bwip-js), not by the API. Transfers and damage use the
scan-session endpoints above (`kind: TRANSFER` with `toLocationId`, `kind: DAMAGE` with `reason`).

## Endpoints — Phase 3 — implemented

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/inventory/movements?variantId=&locationId=&beforeSeq=` (with item + who) | `inventory.view` |
| `GET` | `/inventory/summary` (per location and product; value hidden without cost view) | `inventory.view` |
| `POST` | `/inventory/adjustments` — **requires `Idempotency-Key`** | `inventory.adjust` |
| `GET` / `POST` | `/stocktakes` | `inventory.view` / `inventory.stocktake.count` |
| `GET` | `/stocktakes/:id` | `inventory.view` |
| `POST` | `/stocktakes/:id/start` · `/scans` · `/review` · `/cancel` | `inventory.stocktake.count` |
| `PATCH` | `/stocktakes/:id/lines/:variantId` (`countedQuantity`) | `inventory.stocktake.count` |
| `POST` | `/stocktakes/:id/apply` (a different user from the creator) | `inventory.stocktake.apply` |
| `POST` | `/auth/change-password` | authenticated |
| `GET` / `POST` | `/users` | `admin.users.write` |
| `PATCH` | `/users/:id` (`roles`, `isActive`, `nameAr`) | `admin.users.write` |
| `POST` | `/users/:id/reset-password` | `admin.users.write` |

## Endpoints — Accounting (ADR-013) — implemented

Amounts are strings: `amountBase` in USD cents (debit positive), `amountCurrency` in minor units of
`currency`. Every read posts pending stock movements first.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/accounting/accounts` | `accounting.view` |
| `POST` | `/accounting/accounts` — `{ parentId, nameAr, kind?: GENERAL \| CASH, currency?, branch? }` | `accounting.close` |
| `PATCH` | `/accounting/accounts/:id` — `{ nameAr?, isActive?, branch? }` | `accounting.close` |
| `GET` | `/accounting/accounts/:id/statement?from=&to=&branch=` | `accounting.view` |
| `GET` | `/accounting/boxes` (each cash box: balance in its currency, book value in USD) | `accounting.view` |
| `GET` | `/accounting/entries?from=&to=&branch=&voucherType=` | `accounting.view` |
| `POST` | `/accounting/entries` — a voucher (`kind`: RECEIPT, PAYMENT, TRANSFER, EXCHANGE, JOURNAL) — **requires `Idempotency-Key`** | `accounting.post` |
| `GET` | `/accounting/entries/:id` | `accounting.view` |
| `POST` | `/accounting/entries/:id/reverse` — **requires `Idempotency-Key`** | `accounting.post` |
| `GET` | `/accounting/reports/trial-balance` · `/income` (`from`, `to`, `branch`) · `/balance-sheet` (`asOf`, `branch`) | `accounting.view` |
| `GET` | `/accounting/check` (stock accounts = stock value per location) | `accounting.view` |
| `GET` | `/accounting/periods` (next closable month, revaluation preview, closed months) | `accounting.view` |
| `POST` | `/accounting/periods/close` — `{ period: "2026-10" }` | `accounting.close` |

Errors: `PERIOD_CLOSED` (409), `PERIOD_NOT_CLOSABLE` (409), `ENTRY_NOT_REVERSIBLE` (409),
`ENTRY_NOT_BALANCED`, `ACCOUNT_NOT_USABLE`, `CURRENCY_MISMATCH`, `RATE_NOT_SET`, `DATE_IN_FUTURE`,
`AMOUNT_TOO_SMALL`, `ACCOUNT_IS_SYSTEM` (422). `PUT /rates` also takes `officialRate` (reference
only, nullable).

## Endpoints — Point of sale (ADR-014) — implemented

Amounts in SYP minor units, except payments (their own currency). Sales and refunds **require
`Idempotency-Key`**.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/retail/shifts/current?locationId=` (the open shift, or null) | `retail.sell` |
| `GET` | `/retail/shifts/last-count?locationId=` (what the drawer held when the last shift closed, or null) | `retail.sell` |
| `GET` / `POST` | `/retail/shifts?locationId=` / `{ locationId, opening: { SYP?, USD?, TRY? } }` | `retail.sell` |
| `GET` | `/retail/shifts/:id` (drawer per currency: opening, takings, change, refunds, expected, counted) | `retail.sell` |
| `POST` | `/retail/shifts/:id/close` — `{ counted: { SYP?, USD?, TRY? } }` (another person's: `retail.manage`) | `retail.sell` |
| `GET` | `/retail/lookup?barcode=&locationId=` (the piece, its SYP price or null, available) | `retail.sell` |
| `POST` | `/retail/sales` — `{ shiftId, lines: [{ variantId, quantity }], discount?, payments: [{ currency, amount }] }` | `retail.sell` (discount: `retail.manage`) |
| `GET` | `/retail/sales?shiftId=` or `?receipt=2026/15` · `/retail/sales/:id` | `retail.sell` |
| `POST` | `/retail/sales/:id/refund` — `{ shiftId, lines: [{ lineNo, quantity }], reason }` | `retail.manage` |

Errors: `SHIFT_ALREADY_OPEN`, `SHIFT_NOT_OPEN` (409), `LOCATION_NOT_A_STORE`, `NO_RETAIL_PRICE`,
`PAYMENT_TOO_LOW`, `REFUND_EXCEEDS_SALE`, `NOT_REFUNDABLE`, `RATE_NOT_SET` (422).

## Endpoints — Payroll (ADR-015) — implemented

Amounts in minor units of the employee's currency. Advances, approving, paying and cancelling
**require `Idempotency-Key`**.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/payroll/employees?includeInactive=` (salary and advance balance only with `payroll.manage`) | `employees.read` or `payroll.manage` |
| `POST` / `PATCH` | `/payroll/employees` · `/payroll/employees/:id` — `{ nameAr, jobTitle?, phone?, branch, currency, salary, frequency, notes?, isActive? }` | `payroll.manage` |
| `GET` | `/payroll/employees/:id` (advances and pay history; audited) | `payroll.manage` |
| `POST` | `/payroll/employees/:id/advances` · `/repayments` — `{ boxId, amount, note? }` | `payroll.manage` |
| `GET` | `/payroll/summary` (advances and unpaid pay per currency, missing month, books check) | `payroll.manage` |
| `GET` / `POST` | `/payroll/runs` / `{ frequency: 'MONTHLY', period: '2026-09' }` or `{ frequency: 'WEEKLY', weekStart }` | `payroll.manage` |
| `GET` | `/payroll/runs/:id` | `payroll.manage` |
| `PATCH` / `DELETE` | `/payroll/runs/:id/lines/:lineId` — `{ salary?, bonus?, deduction?, deductionNote?, advanceDeduct? }` (drafts only) | `payroll.manage` |
| `POST` | `/payroll/runs/:id/approve` · `/cancel` · `/pay` — pay: `{ boxId, lineIds? }` | `payroll.manage` |

Errors: `PAYROLL_PERIOD_TAKEN`, `PAYROLL_NOT_DRAFT`, `PAYROLL_NOT_APPROVED`,
`PAYROLL_HAS_PAYMENTS`, `EMPLOYEE_CURRENCY_LOCKED` (409), `NO_EMPLOYEES`, `NOTHING_TO_PAY`,
`ADVANCE_EXCEEDS_BALANCE`, `PAY_BELOW_ZERO`, `CURRENCY_MISMATCH`, `RATE_NOT_SET` (422).

## Endpoints — Suppliers and customers (ADR-016) — implemented

Amounts in minor units of the party's currency. Settling and closing the unnamed balance
**require `Idempotency-Key`**.

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/parties?kind=&includeInactive=` (balance only with `parties.read`) | `parties.read`, or picking: `inventory.receive` · `inventory.issue` · `retail.sell` |
| `POST` / `PATCH` | `/parties` · `/parties/:id` — `{ kind, nameAr, phone?, currency, branch, notes?, isActive? }` | `parties.manage` |
| `GET` | `/parties/:id` (statement with running balance) · `/parties/summary` (totals, unnamed balance) | `parties.read` |
| `POST` | `/parties/:id/settle` — `{ boxId, amount, note? }` (box currency) | `parties.manage` |
| `POST` | `/parties/receipts/:sessionId` — `{ source: SUPPLIER\|CASH\|OPENING\|OWNER, partyId?, invoiceNo?, paid?: { boxId, amount } }`. The only way to confirm a receipt: `/scan-sessions/:id/commit` refuses one (`RECEIPT_NEEDS_SOURCE`). | `inventory.receive` (paid: `parties.manage`) |
| `POST` | `/parties/goods-out/:sessionId` — `{ partyId, amount, note? }` | `inventory.issue` + `parties.manage` |
| `POST` | `/parties/unassigned` — `{ side, boxId?, as?: OWNER\|OPENING, amount, note? }` (no box: USD cents; the owner paid it, or it was stock owned before the system) | `parties.manage` |

`POST /retail/sales` also takes `account: { partyId, amount }` (SYP), with or without cash
payments. Sales and refunds return `onAccount` and `party`.

Errors: `PARTY_CURRENCY_LOCKED` (409), `PARTY_NOT_USABLE`, `PARTY_CURRENCY_MISMATCH`,
`WRONG_SESSION_KIND`, `CASH_MUST_COVER_GOODS`, `UNASSIGNED_EXCEEDED` (422). Vouchers on 1103 or
2101 are refused with `ACCOUNT_NOT_USABLE` (`PARTY`).

## Endpoints — Receipt corrections and adjustment approvals (ADR-017) — implemented

All **require `Idempotency-Key`**.

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/parties/receipts/:sessionId/correct` — `{ changes: [{ variantId, quantity, toVariantId? }], reason }` (each line as it should have been; `toVariantId`: the difference moves there) | `inventory.receive` |
| `POST` | `/inventory/adjustments` — `{ variantId, locationId, delta, reasonCode: COUNT_DIFFERENCE\|DAMAGE\|SAMPLE\|INTERNAL_USE\|GIFT, note? }` → `{ status: APPLIED\|PENDING, requestId }` | `inventory.adjust` |
| `GET` | `/inventory/adjustment-requests?status=` | `inventory.view` |
| `POST` | `/inventory/adjustment-requests/:id/approve` · `/reject` — `{ note? }` (not by the asker) | `inventory.adjust.approve` |
| `GET` | `/gift-recipients` · `/gifts?from=&to=&recipientId=&kind=&locationId=` · `/gifts/:sessionId` (ADR-019) | `admin.gifts` or `accounting.view` |
| `POST` | `/gifts/:sessionId` — `{ recipientId \| recipient: { name, kind, phone? }, occasion, reference? }` confirms a `GIFT` scan session | `admin.gifts` |
| `POST` | `/gifts/:sessionId/photo` — `{ image }` (base64) · `GET` the same path redirects to the photo | `admin.gifts` |
| `POST` | `/inventory/movements/:id/undo` — `{ reason }` (ADR-018: a `MANUAL` adjustment or damage, exactly the other way) | `admin.undo` |

Errors: `ADJUSTMENT_NOT_PENDING` (409), `RECEIPT_CORRECTION_NOT_POSSIBLE`, `SELF_APPROVAL`,
`MOVEMENT_UNDO_NOT_POSSIBLE`, `MOVEMENT_NOT_UNDOABLE`, `GIFT_NEEDS_RECIPIENT`, `NOT_A_GIFT`
(422).

Still to come: reservation endpoints (with wholesale), the OpenAPI document, and a generated
client (the app uses a hand-typed client in `apps/warehouse/src/api.ts`).

## Methods and status codes

| Method | Use | Success |
| --- | --- | --- |
| `GET` | Read. Never changes state. | 200 |
| `POST` | Create, or execute a command | 201 created, 200 command |
| `PATCH` | Partial update | 200 |
| `PUT` | Full replace (rare) | 200 |
| `DELETE` | Remove or soft-delete | 204 |

| Failure | Code |
| --- | --- |
| Input failed validation | 400 |
| Not authenticated | 401 |
| Authenticated, not permitted | 403 |
| Resource does not exist | 404 |
| Conflict: version, state, duplicate | 409 |
| Business rule rejected the request | 422 |
| Rate limited | 429 |
| Unhandled server fault | 500 |

Insufficient stock is **422**, not 400. The request was well-formed; the business said no.

## Request validation

Every request body, query string, and path parameter is parsed with a Zod schema at the
boundary. The handler receives typed, validated data or it never runs. No manual `if (!body.x)`
checks, and no `as` casts on request data.

Schemas live in the module's `*.schema.ts` and are re-exported through `packages/validation` so
the front-end validates with exactly the same rules.

## Response envelope

Success:

```json
{ "data": { ... } }
```

List:

```json
{
  "data": [ ... ],
  "meta": { "cursor": "...", "hasMore": true }
}
```

Error:

```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "Not enough stock available",
    "details": { "variantId": "...", "requested": 101, "available": 100 }
  }
}
```

- `code` is a stable `SCREAMING_SNAKE_CASE` string. Clients switch on `code`, never on `message`.
- `message` is English, for developers and logs. The apps show their own Arabic copy keyed by
  `code`.
- `details` is structured and safe to display. It never leaks internals, SQL, or stack traces.

## Pagination

Cursor-based, because offset pagination drifts while stock is moving.

```
GET /api/v1/inventory/movements?variantId=...&limit=50&cursor=eyJ...
```

`limit` defaults to 50 and is capped at 200.

## Idempotency

Every state-changing `POST` accepts:

```
Idempotency-Key: <uuid>
```

For inventory and payment endpoints it is **required**. The key plus the endpoint is stored
with the result; a repeat returns the original response instead of acting twice. Keys expire
after 24 hours.

## Concurrency

Updates to editable entities send the version they read:

```
If-Match: "<version>"
```

A mismatch returns 409 with the current version. Last-write-wins is not acceptable for orders,
prices, or stock.

## Authentication

- Session cookie (httpOnly, secure, sameSite strict) for the first-party apps. The apps are
  static Vite builds served from the **same origin** as the API, so no CORS and no cross-site
  cookie configuration is needed.
- Bearer token for any future integration, scoped and revocable.
- Every endpoint declares its required permission explicitly. There is no default-allow, and no
  endpoint that is permitted merely because the user is logged in.

See [`security.md`](security.md).

## Filtering and sorting

```
?locationId=...&status=DRAFT&sort=-createdAt&q=thobe
```

- Filters are explicit named parameters. No generic query language reaches the database.
- `sort` accepts a whitelist of fields only, `-` for descending.
- `q` is full-text search on defined columns, parameterized, never interpolated.

## Dates, money, quantities

- Dates are ISO 8601 UTC strings: `2026-09-21T10:30:00.000Z`.
- Money is an object, never a bare number:

```json
{ "amount": "125000", "currency": "SYP" }
```

`amount` is a **string** of minor units, so no client turns it into a lossy float.

- Quantities are integers.

## Versioning

- `/api/v1` is stable. Additive changes (new optional field, new endpoint) go into v1.
- Breaking changes require `/api/v2`, a documented migration path, and a deprecation window
  during which both run.
- Removing a field, renaming a field, changing a type, or narrowing an enum is breaking, even
  when it "should not matter".

## Rate limiting

Per user and per IP, applied at the edge. Login and any endpoint that sends a message are
limited tightly. Limits return 429 with `Retry-After`.

## Documentation

Schemas generate an OpenAPI document from the Zod definitions, served at `/api/v1/openapi.json`.
`packages/api-client` is generated from it, so an endpoint that is not documented is not usable
by the apps. That is intentional.
