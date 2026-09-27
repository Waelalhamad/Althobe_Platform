# Al Thob Al Arabi

The law of this project. Read this file first, every session. Keep it under ~200 lines.

## Project

Al Thob Al Arabi is a business platform for a traditional-menswear (thobe) business.
It covers:

- Inventory management (two warehouses + one retail store)
- Purchasing
- Wholesale commerce
- Retail commerce (POS)
- Sales and invoicing
- Accounting
- Employees and payroll basics

The system is a **scalable modular monolith**, not microservices.
Arabic (RTL) is the primary UI language; English is the code language.

## Status

**Phases 1–2 are implemented**: the inventory ledger in `backend/` (catalogue, locations, inventory,
scan sessions, stocktake), the `/api/v1` HTTP API, and the warehouse app in `apps/warehouse`.
Other apps and Phase 3+ endpoints in `docs/` are still a **specification**. Never assume a file, table, or service
exists — check first.
`PROJECT_STATUS.md` is the source of truth for what is actually built.

## Stack

- TypeScript (strict)
- Node.js
- PostgreSQL 18 on **Neon** + Prisma via Neon's WebSocket driver (port 443) — no local database (ADR-006)
- React 19 + Vite + TanStack Router (static SPAs, served same-origin by the API) — see ADR-005
- Fastify 5 (HTTP API, from Phase 2)
- Zod for all boundary validation
- Redis — not used yet; added only when something needs it (queues, cache)
- Vitest (unit + integration on a Neon `test` branch), Playwright (E2E)

## Repository map

```
apps/        admin | retail | wholesale | warehouse   (Vite + React SPAs)
packages/    ui | types | validation | api-client      (shared workspace packages)
backend/     modular monolith (modules/<domain>/)
docs/        architecture and domain rules
```

## Context routing — read only what the task needs

Do not read every document for every task. Load by area:

| Working on | Read |
| --- | --- |
| Anything | `CLAUDE.md`, `AGENTS.md`, `PROJECT_STATUS.md` |
| Inventory / stock | `docs/inventory.md`, `docs/database.md` |
| Barcodes / scanning | `docs/barcode.md`, `docs/inventory.md` |
| Schema or migration | `docs/database.md` + the relevant domain doc |
| API endpoint | `docs/api.md` + the relevant domain doc |
| Auth / roles / permissions | `docs/security.md` |
| New module or boundary change | `docs/architecture.md`, `docs/domain.md` |
| Writing tests | `docs/testing.md` |
| UI, colours, fonts, logo | `docs/brand.md` |
| "Why was X chosen?" | `docs/decisions/` |

A module's own `README.md` beats any general document for that module.

## Architecture rules

- Modular architecture; a module owns its tables and exposes a service API.
- Business logic lives in domain/application services.
- Controllers/route handlers stay thin: parse, authorize, call a service, serialize.
- Never access the database directly from a controller or a React component.
- Never read or write another module's tables directly — call its public service.
- Validate every external input with Zod at the boundary.
- Use a database transaction for every multi-step inventory or financial operation.
- Never mutate inventory quantity directly. All stock changes go through `InventoryService`.
- Every stock change writes an immutable `inventory_movement` row.
- Money is stored as integer minor units plus a currency code. Never `float`.
- Authorization is RBAC with explicit permission checks, never role-name string comparisons.
- Never add a dependency without justification in the PR description.

## Code quality

- Prefer simple code over clever abstractions.
- Avoid premature abstraction; duplicate twice before extracting.
- Never duplicate a business rule — it lives in exactly one service.
- Do not create files that are not needed for the task.
- Reuse existing utilities, components, and patterns before inventing new ones.
- Comments explain **why**, not what. Do not narrate obvious code.

## Testing

Every business-critical feature ships with tests. Critical inventory operations:

`receiveStock` · `issueStock` · `transferStock` · `adjustStock` · `reserveStock` · `releaseStock`

Each must cover: happy path · validation failure · insufficient stock · concurrency/rollback ·
permission failure. See `docs/testing.md` for the exact expected numbers.

## Before coding

1. Inspect the existing implementation.
2. Identify the affected modules.
3. Read the documentation for those areas (routing table above).
4. Make the smallest safe change.
5. Run the relevant tests.
6. Run typecheck and lint.
7. Report what changed and what was tested.

## Forbidden

- Do not rewrite working modules without a stated reason.
- Do not change the database schema casually; schema changes need a migration and a note.
- Do not bypass services to touch tables.
- Do not use `any` unless justified in a comment.
- Do not change an API contract silently.
- Do not delete, skip, or weaken tests to make a suite pass.
- Do not commit secrets, real customer data, or `.env` files.
- Do not claim work is done when typecheck, lint, or tests are failing.
