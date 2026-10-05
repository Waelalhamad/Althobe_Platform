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
| `GET` / `POST` | `/categories` — `{ nameAr, code?, parentId?, groupIds? }` (ADR-011) | `products.read` / `products.write` |
| `PATCH` / `DELETE` | `/categories/:id` — name, code, `parentId`, `groupIds`, `isActive`, `move`; delete only without stock | `products.write` |
| `POST` | `/categories/:id/products/generate` — `{ selections: [{ groupId, valueIds }], prices? }` | `products.write` (+ `prices.write` with prices) |
| `GET` | `/products?categoryId=` · `/products/:id` (with its sizes) | `products.read` |
| `PATCH` / `DELETE` | `/products/:id` — `{ isActive }`; delete only without stock | `products.write` |
| `POST` | `/products/prices` — `{ productIds, retail?, wholesale? }` (minor units as strings; `null` clears) | `prices.write` |
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
« · »), `size`, `prices: { retail, wholesale }` (its own price, else the product's; each
`{ amount, currency }` in USD minor units or null — ADR-009), `ownPrices`, `photoId` (the product's
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
