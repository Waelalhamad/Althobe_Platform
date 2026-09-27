# Al Thob Al Arabi — الثوب العربي

Business platform for a traditional-menswear (thobe) operation: inventory, purchasing,
wholesale, retail, invoicing, accounting, and employees — built as a modular monolith.

> **Current state: Phase 1** — the inventory ledger is built in `backend/`; unit tests pass, and
> the integration tests are waiting on a Neon `test` branch. No API or UI yet. See [`PROJECT_STATUS.md`](PROJECT_STATUS.md) for exactly what exists.

## Why this exists

One business, several faces: a warehouse that must always know real stock, a wholesale
channel with per-customer pricing and credit, a retail counter that has to be fast, and
accounting that has to reconcile with both. The platform keeps a single source of truth for
stock and money so those four views never disagree.

## Stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript (strict) |
| Backend | Node.js, modular monolith |
| Database | PostgreSQL 18 on Neon (Frankfurt) + Prisma, over port 443 |
| Frontend | React 19 + Vite + TanStack Router, Tailwind v4, Arabic RTL first |
| HTTP API | Fastify 5 (from Phase 2) |
| Validation | Zod |
| Cache / queues | Redis, only when needed (not yet) |
| Tests | Vitest (on a Neon test branch), Playwright |

## Repository layout

```
apps/
  admin/        back-office: catalogue, pricing, reports, settings
  retail/       point of sale
  wholesale/    B2B ordering portal
  warehouse/    receiving, transfers, stocktake, scanning
packages/
  ui/           shared React components (RTL-aware)
  types/        shared TypeScript types
  validation/   shared Zod schemas
  api-client/   typed client for the backend API
backend/        modular monolith, modules/<domain>/
docs/           architecture, domain rules, and decisions
```

## Documentation index

Start here, not in the code:

| File | What it answers |
| --- | --- |
| [`CLAUDE.md`](CLAUDE.md) | The rules of the project. What is allowed and forbidden. |
| [`AGENTS.md`](AGENTS.md) | How to work: workflow, scope, Definition of Done. |
| [`PROJECT_STATUS.md`](PROJECT_STATUS.md) | What is built, in progress, and next. |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Branches, commits, pull requests. |
| [`docs/architecture.md`](docs/architecture.md) | Layers, modules, dependency direction. |
| [`docs/domain.md`](docs/domain.md) | Ubiquitous language and core entities. |
| [`docs/database.md`](docs/database.md) | Naming, keys, money, constraints, migrations. |
| [`docs/api.md`](docs/api.md) | REST conventions, errors, pagination, idempotency. |
| [`docs/inventory.md`](docs/inventory.md) | The stock ledger. The most important document. |
| [`docs/barcode.md`](docs/barcode.md) | Barcode format, allocation, scanning. |
| [`docs/testing.md`](docs/testing.md) | Test strategy and required coverage. |
| [`docs/security.md`](docs/security.md) | Auth, RBAC, audit, secrets. |
| [`docs/brand.md`](docs/brand.md) | Colours, typography, logo rules. |
| [`docs/decisions/`](docs/decisions/) | Architecture Decision Records. |

## Getting started

Requirements: Node 22+, pnpm 9 (`npm i -g pnpm@9`), a Neon project. No local database. The app
reaches Neon over port 443, so networks that block Postgres's port 5432 are fine (ADR-006).

```bash
pnpm install
cp .env.example backend/.env                  # fill in the Neon URLs
pnpm --filter @althobe/backend db:generate
pnpm db:migrate                               # applies migrations (never resets anything)
pnpm db:seed                                  # locations + a sample product; no stock
pnpm --filter @althobe/backend user:create --email you@example.com --name "الاسم" --roles owner

pnpm dev                                      # API on :3000 + warehouse app on http://localhost:5180
```

Tests:

```bash
pnpm --filter @althobe/backend test:unit          # no database
pnpm test                                         # unit + integration (wipes the TEST database)
pnpm --filter @althobe/warehouse e2e              # browser end-to-end, see apps/warehouse/playwright.config.ts
pnpm typecheck && pnpm lint
```

Never scan test data into the real database: the stock ledger is append-only and an opening count
cannot be repeated. Point the API at `TEST_DATABASE_URL` for manual testing.

Never run the project from a path containing `#` — Vite and Vitest cannot resolve modules there.

## Conventions at a glance

- Code, identifiers, and commits in English. UI copy in Arabic, RTL by default.
- Money as integer minor units + ISO currency code. Never floating point.
- Timestamps stored as timestamptz in UTC; formatted per user locale in the UI.
- Stock changes only through InventoryService, always inside a transaction.
- Documentation states the rule; the schema, types, and tests enforce it.
