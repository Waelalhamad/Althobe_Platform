# Project Status

Last updated: 2026-10-05

Read this first in every session. It is the only file that describes what actually exists.
If it disagrees with the code, the code wins — and this file gets fixed in the same PR.

## Current phase

**Phase 3 — Warehouse app, complete: ✅ inventory side built and verified (2026-09-27).**
**Next: try it in practice mode with the real scanner and printer, then hosting.**

Verification: **67 / 67 backend tests** (58 ledger + 9 API), **2 / 2 browser end-to-end tests**
(opening count; transfer · damage · stocktake · adjustment · history · report · users),
typecheck, lint, formatting, build.

**Product options (2026-10-05, ADR-008):** products ثوب / كلابية are built by tapping values of
editable option types — القصة، الزر، السحاب، الكم، القماش، اللون، القياس — on the new «الخيارات»
page; products and variants can be edited, retired and restored.

**Prices (2026-10-06, ADR-009):** each variant has a retail and a wholesale price in USD — set when
creating variants, per variant in the table, or in bulk for a filtered list; shown on the product
page, the scan screen and balances. The suit (الطقم) types موديل الطقم and عدد القطع are in place.


**Photos (2026-10-07, ADR-010):** product photos in the private S3 bucket — uploaded from phone or
PC (shrunk in the browser), tagged with the option values they show; every variant, the product list
and the scan screen show the best-matching photo. **Next for products:** categories, then display
currency (SYP / LYD) by exchange rate.

**Practice mode:** `pnpm dev:practice` runs the app on a separate `althobe_practice` database with a
yellow «وضع التدريب» banner — for learning the scanner and printer without touching real stock.

## Roadmap

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Documentation foundation | ✅ Done |
| 1 | Inventory foundation — the ledger | ✅ Done |
| 2 | Thin slice to the scanner — login, products, labels, opening count, receive | ✅ Done |
| 3 | Warehouse app, complete — transfer, damage, stocktake, adjustment, history, reports, user management | ✅ Done (OpenAPI client deferred) |
| 4 | Store / POS | |
| 5 | Purchasing | |
| 6 | Sales + customers | |
| 7 | Accounting | |

MVP path: Products/Variants → Barcode → Locations → Receive → Transfer → Count → Balance → Audit →
Scanner UI, then connect the store.

## Phase 1 checklist

- [x] Docs aligned with the decisions below
- [x] Workspace tooling: pnpm, TypeScript strict, ESLint (type-aware, module boundaries, promise-function-async), Prettier
- [x] Neon: project `plain-rain-33747865`, Postgres 18, Frankfurt; test database `althobe_test`
- [x] Prisma schema + first migration — applied (17 tables, 14 check constraints, 2 append-only triggers, barcode sequence)
- [x] Shared kernel: money, barcode, errors, audit, idempotency, permissions, ids
- [x] Catalogue: products, variant matrix, barcode allocation and resolution
- [x] Locations; movement policy in `inventory.policy.ts`
- [x] Inventory: `applyMovements`, seven stock operations, reads, `verifyLedger`
- [x] Scan sessions (OPENING / RECEIVE / TRANSFER / DAMAGE)
- [x] Stocktake (snapshot → count → review → apply by a second user)
- [x] Tests — 58 / 58 passing against Neon
- [x] Seed — run
- [ ] CI pipeline — written, **not yet run** (needs the repo on GitHub + `NEON_API_KEY`, `NEON_PROJECT_ID`)

## Phase 3 checklist

- [x] Transfer and damage screens (scan sessions): destination / required reason, **available** column, over-scan blocks confirm
- [x] Stocktake API + screens: blind counting, review with differences, approval by a second person, cancel
- [x] Adjustment API (`Idempotency-Key` required) + form on the balances page with a required reason
- [x] Movement history: per item / location, with who did it and why
- [x] Stock report per location and product; value only with `inventory.cost.view`
- [x] User management (owner only): create with one-time password, roles, deactivate, reset password; change own password; lockout protection
- [x] `manager` role no longer includes `admin.*` (docs/security.md)
- [x] Confirm / finish buttons wait for typed quantities and counts to finish saving (bug found by the E2E test)
- [x] Scanner input accepts Arabic-Indic / Persian digits (Arabic keyboard layout)
- [x] Practice mode (`pnpm dev:practice`, separate database, banner)
- [x] **Goods leaving and coming back** (2026-09-28): `SALE` (إخراج / بيع, optional customer/invoice note) and `RETURN` (مرتجع, reason required) scan sessions at any location; new permission `inventory.return`; store staff can record sales and returns; home actions grouped into وارد / صادر
- [ ] OpenAPI document + generated client — deferred (developer convenience, no business impact)
- [ ] Reservation endpoints — with wholesale (Phase 6)
- [ ] Nightly ledger check and reservation expiry jobs — with hosting

## Phase 2 checklist

- [x] Auth: argon2id passwords, Postgres sessions (cookie holds a random token; only its hash is stored), 12 h sliding expiry, login rate limit, logout revokes server-side
- [x] Roles → permissions in code (`modules/auth/roles.ts`): owner, manager, inventory_manager, warehouse_keeper, store_staff, accountant
- [x] `pnpm user:create` — no self-registration
- [x] Fastify API (`/api/v1`): thin routes, domain errors → HTTP status, JSON-only writes (CSRF), security headers, bigint as strings
- [x] Warehouse app (Vite + React + TanStack Router/Query + Tailwind v4), Arabic RTL, brand tokens, Somar
- [x] Screens: login, locations home, products + variant generation, label printing, scan session, balances
- [x] Scanner: always-focused scan field, queued scans (never blocks), found / duplicate / not-found sounds, big running count
- [x] Labels: EAN-13 via bwip-js in the browser; A4 24-up (70×37 mm) and thermal 50×30 mm; lazy-loaded
- [x] Playwright end-to-end test using the installed Chrome
- [ ] OpenAPI + generated client — moved to Phase 3 (Phase 2 uses a hand-typed client)

## Go-live steps (for the business)

1. Create the owner login on the real database (run in your own terminal so the password is not in chat):
   `pnpm --filter @althobe/backend user:create --email <you> --name "<الاسم>" --roles owner`
2. Buy a scanner (USB or Bluetooth, **HID keyboard mode**). Labels can start on A4 sticker sheets.
3. Deploy on **Railway** (ADR-007): reset the Neon password first (it was once shared in chat);
   Railway → New Project → GitHub repo, branch `main` → region europe-west4 → variables
   `DATABASE_URL`, `DIRECT_URL`, `NODE_ENV=production`, `BASE_CURRENCY=SYP` → generate a domain.
   Remove the sample product `THB-CLASSIC` from the real database before the opening count.
   Later, for photos: `AWS_REGION`, `S3_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
   a bucket CORS rule for the Railway domain.
4. Create the real products, print labels, stick them on, then run the opening count per location.

## Settled decisions

| Area | Decision | Where |
| --- | --- | --- |
| Architecture | Modular monolith | ADR-002 |
| Database | PostgreSQL | ADR-001 |
| Barcode | EAN-13, prefix 2, check digit; supplier barcodes also accepted | ADR-003 |
| Money | Integer minor units; SYP + USD; rate on every costed movement; base SYP | ADR-004 |
| Front-end | Vite + React SPAs, not Next.js | ADR-005 |
| Database host | Neon, Postgres 18, Frankfurt; WebSocket driver on port 443; tests in `althobe_test`; no local DB | ADR-006 |
| Stock places | `Location` with kind WAREHOUSE / STORE: two warehouses, one store | inventory.md |
| Variant | One value per option type; types and values edited in the app (القصة، الزر، السحاب، الكم، القماش، اللون، القياس) | ADR-008 |
| Opening stock | Start from zero; scanned `OPENING` count | inventory.md |
| Costing | Moving weighted average, per variant per location, in SYP | inventory.md |
| Stocktake | First-class, never an adjustment; second user approves | inventory.md |
| Units | PIECE now; BOX / METER / KG reserved; no conversions | inventory.md |
| Negative stock | Never allowed | inventory.md, database checks |
| Sessions | Postgres, not Redis | security.md |
| Brand | #8A1913 · #EBD8D2 · #DAD3CB · #AA999A, Somar | brand.md |

## Open items

Resolved 2026-09-25: labels are printed for everything (no existing barcodes); no label printer yet (A4 sheets + thermal both supported); Somar licence allows web use; SVG logo to follow.

| # | Question | Needed by |
| --- | --- | --- |
| 2 | **Label printer model + label size** (printer bought 2026-09-27) — to add its exact label format | Now |
| 3 | ~~Vector logo~~ — received 2026-09-27, in use | Done |
| 5 | Real location names and codes (placeholders: WH1 / WH2 / STORE) | Phase 2 go-live |
| 6 | Does the store ever receive directly from suppliers? (policy says no) | Phase 2 |
| 7 | API hosting: a VPS or platform **in Frankfurt**, next to Neon (a local server is ruled out by latency — ADR-006) | Phase 2 go-live |
| 8 | At least two people with access (stocktake needs a second approver) | Phase 3 |

## Known issues

- **A silently dropped WebSocket to Neon can hang a request** (seen twice on the VPN during tests:
  once for hours, once 120 s). Add connection and query timeouts to the database pool so a request
  fails fast and the scan queue can retry. Scheduled with the weak-network work (improvement #4).

- **Reset the Neon password**: it was pasted in chat on 2026-09-24, and a debugging command printed a
  connection string again on 2026-09-27.
- Somar's bold digit 8 has an open top and can look like "a" at small sizes; watch legibility on
  warehouse screens.

- **Development-network latency.** Through the VPN a query takes 100–300 ms and a scan ~1–6 s
  from this machine; the full backend suite takes 9–20 min. Production is unaffected once the API
  runs in Frankfurt (one ~0.3 s round trip per scan from Syria, and scans queue).
- Port 5173 is used by something else on the development machine; the app's dev server uses 5180.

- **Rotate the Neon password** — it was shared in a chat. Neon console → Roles → `neondb_owner` →
  Reset password, then update `backend/.env`.
- **Port 5432 is blocked on the development network.** The app and migrations use Neon's
  WebSocket driver on port 443 (ADR-006 amendment). Do not run `prisma migrate deploy` locally;
  use `pnpm db:migrate`.
- **The integration suite takes ~9 minutes from the development machine** (~105 ms per query,
  ~400 ms overhead per transaction to Frankfurt). Production is unaffected: the API will run in
  Frankfurt next to the database.
- The project moved from `F:\#Dev_Projects\Althobe` to `F:\Dev_Projects\Althobe` (Vite cannot run
  from a path containing `#`). The old folder is a stale copy; delete it once nothing has it open.
- The Neon CI actions (`create-branch-action@v5`, `delete-branch-action@v3`) are unverified until
  the first CI run.
