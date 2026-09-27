# Architecture

Status: specification. No code exists yet.

## Shape

A **modular monolith**: one deployable backend, internally split into modules with hard
boundaries. See [ADR-002](decisions/002-modular-monolith.md) for why.

```
                  apps/admin   apps/retail   apps/wholesale   apps/warehouse
                        |            |              |               |
                        +------------+--------------+---------------+
                                     |
                              packages/api-client
                                     |
                              HTTP  /api/v1
                                     |
                        +------------------------------+
                        |          backend             |
                        |  http layer (thin)           |
                        |  modules/<domain>/           |
                        |  shared/ (kernel)            |
                        +------------------------------+
                                     |
                        PostgreSQL        (Redis later, if needed)
```

## Layers

Inside every module, four layers, and dependencies point in one direction only:

```
controller  ->  service  ->  repository  ->  database
     \             |
      \            v
       ->       schema (Zod)
```

| Layer | Responsibility | Never does |
| --- | --- | --- |
| `*.controller.ts` | Parse request, check permission, call one service, serialize response | Business logic, SQL, Prisma calls |
| `*.service.ts` | Business rules, transactions, orchestration, domain errors | HTTP concerns, `req`/`res`, direct SQL string building |
| `*.repository.ts` | Prisma queries for this module's tables only | Business rules, cross-module queries |
| `*.schema.ts` | Zod schemas for input and output | Anything else |

A controller that contains an `if` about business rules is a bug.

## Module layout

```
backend/modules/inventory/
├── README.md                 what this module is, in 30 lines
├── inventory.controller.ts
├── inventory.service.ts
├── inventory.repository.ts
├── inventory.schema.ts
├── inventory.types.ts
├── inventory.errors.ts
└── inventory.test.ts
```

Large modules may use folders (`services/`, `repositories/`) but keep the same suffixes.

## Planned modules

| Module | Owns | Depends on |
| --- | --- | --- |
| `auth` | users, sessions, roles, permissions | — |
| `products` | products, variants, categories, barcodes | — |
| `locations` | locations (warehouses and the store), later bins | — |
| `inventory` | balances, movements, reservations, scan sessions, stocktake | products, locations |
| `purchasing` | suppliers, purchase orders, goods receipt | products, inventory |
| `sales` | orders, deliveries, returns | products, inventory, customers |
| `wholesale` | B2B customers, price tiers, credit limits | sales, inventory |
| `retail` | POS sessions, cash drawer, receipts | sales, inventory |
| `invoicing` | invoices, payments, credit notes | sales |
| `accounting` | ledger, journals, reports | invoicing, purchasing |
| `employees` | staff records, roles, basic payroll | auth |

## Dependency rules

1. A module may call another module's **public service**. It may never import that module's
   repository, or query its tables.
2. The dependency graph stays acyclic. If A needs B and B needs A, one of them is modelled
   wrong, or the shared part belongs in `shared/`.
3. `shared/` holds infrastructure only: database client, logger, errors, result types, money,
   ids, dates, transaction helper. No business rules ever live in `shared/`.
4. Front-end apps talk to the backend only through `packages/api-client`. No app builds its
   own fetch calls to `/api`.
5. `packages/types` and `packages/validation` are shared between backend and apps, so they
   must stay free of Node-only or browser-only imports.

## Cross-module communication

Synchronous, in-process service calls by default — direct, typed, easy to debug.

Domain events (a queue, added when first needed) are used only where the side effect is genuinely
asynchronous and the caller must not wait or fail because of it: printing, notifications,
report rebuilds, external sync. An event handler that must not be lost writes to an outbox
table in the same transaction as the business change.

Never use an event to keep two tables in sync that should have been one transaction.

## Transactions

Any operation touching more than one row that must agree — stock, money, orders — runs in a
single database transaction, opened at the **service** layer:

```ts
return db.$transaction(async (tx) => {
  // read with locks, write movements, update balances, write audit
});
```

Controllers never open transactions. Repositories accept an optional `tx` and use it when given.

## Front-end apps

Four Vite + React single-page apps, each built to static files and served by the API from the same
origin, sharing `packages/ui` (see ADR-005):

| App | Users | Character |
| --- | --- | --- |
| `admin` | owner, managers | dense tables, reports, settings |
| `retail` | cashiers | keyboard and scanner first, few clicks, large targets |
| `wholesale` | B2B customers | catalogue, per-customer price, order history, credit |
| `warehouse` | warehouse staff | mobile, scanner-driven, works one-handed |

RTL is the default direction, not a toggle bolted on later. Use logical CSS properties
(`margin-inline-start`, not `margin-left`) everywhere in `packages/ui`.

## Module README template

Every module gets a short `README.md`. Keep it to roughly this:

```md
# <Module> Module

## Responsibility
One paragraph. What this module is responsible for, and what it is not.

## Depends On
- <module>

## Used By
- <module>

## Important Rules
- The two or three rules someone will break if they do not read this.

## Main Services
serviceMethodOne()
serviceMethodTwo()
```

## Scaling path

This design stays a monolith until a specific module proves it needs its own deployment
(independent scaling, separate release cadence, or a separate team). Because modules already
communicate through service interfaces and own their tables, extracting one later is a
mechanical change, not a rewrite. Do not pre-split.
