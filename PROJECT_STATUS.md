# Project Status

Last updated: 2026-10-19

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
and the scan screen show the best-matching photo. **Next for products:** categories.

**Re-audit fixes (2026-10-24):**
- **Approving alone:** with nobody else active who may approve, the asker approves their own
  adjustment or applies their own count. It is marked on it («قرّره لحالو», `self_approved` /
  `applied_alone`). Otherwise four eyes stay.
- **The two «بالطريق» accounts are named for what they hold:**
  - the road location's account: «بضاعة بالطريق — شحنات بين الفروع»;
  - 110599: «تحويلات بين المواقع والفروع».
- **A manual journal line always has a country:** the one chosen, else the account's, else Syria.

**Cost correction (2026-10-24, report F-07; ADR-017 addendum):**
- **Correcting a cost:** «تصحيح الاستلام» also takes the right cost per piece of a line. The pieces
  go back at their cost and in again at the right one, so the stock value and the supplier's bill
  (or the opening balances) change, and the quantity and the profit do not.
- **Limits:** it is refused once a piece of the line has gone, and only those with
  `inventory.adjust.approve` can do it.
- **Warning at receipt:** a receipt now also warns when a cost is more than 15% from what the same
  size already costs in that warehouse.

**Libya as a branch (2026-10-23, ADR-020; report F-04):** WH2 is «مستودع ليبيا» (branch LY), and
every stock posting there is Libya's.
- **Sending:** a transfer to the other branch is a shipment. It leaves for «بالطريق» at once.
- **Receiving:** the other end scans what arrived on «الشحنات» ← «استلام الشحنة». What arrived
  enters at its value, and what did not is «فقد بالشحن» (5104).
- **People kept to a branch:** a user can be kept to one branch (Users ← الفرع), and then sees and
  moves only its stock.

**Gifts (2026-10-23, ADR-019; report F-06):** «🎁 هدية / إكرامية» at each location (owner only):
scan the pieces, and say who received them (kept in a list, with their kind) and why. A shipment
number and a delivery receipt photo are optional. They leave stock to 5212, never to damage.
«الهدايا» lists every gift, with totals per recipient and month.

**«تراجع» (2026-10-23, ADR-018):** the owner undoes a manual adjustment or damage made by mistake,
from the history, with a reason. Same type, opposite quantity, exactly the original value, so no
profit or loss comes of it. Refused once the pieces were sold or moved. Nothing is ever deleted.

**Receipt corrections and adjustment approvals (2026-10-23, ADR-017; report F-02, F-03):**
- **«تصحيح الاستلام»** on a confirmed receipt: the right quantity (0 takes a line back), or part
  moved to the right size. It goes at the line's own cost, against the supplier's bill or the
  opening balances, and never through the profit. It is refused once the goods were sold or
  moved.
- **Manual adjustments have a fixed reason**, each with its account: فرق جرد 5103، تالف 5102،
  عينة 5210، استهلاك داخلي 5299، هدية 5212 (with who got it). Only a count difference adds
  stock.
- **Approval:** an increase, or more than 3 pieces or 50 $ out, waits on «طلبات التعديل» for
  someone other than the asker (`inventory.adjust.approve`), and changes nothing until then.

**Developer report fixes (2026-10-22, report «أخطاء النظام المالية» of 2026-10-21):**
- **F-01:** every receipt says where the goods came from:
  - **a supplier:** named, required, with the invoice number;
  - **a cash purchase:** from a box;
  - **stock owned before the system:** 3901;
  - **the owner's goods or production:** 3201.
  The plain confirm of a receipt is refused (`RECEIPT_NEEDS_SOURCE`). The unnamed balance can be
  closed as opening stock.
- **F-05:** a warning on «المالية» and «اليوم» whenever a box's currency has no rate. Every rate
  set is kept with its date and who set it; closing a month revalues at the rate of its last day.
- **F-07 (warning part):** a receipt line costing more than 15% away from the other sizes of the
  same product asks for a tick before confirming.
- **F-08:** «تكلفة البضاعة المباعة» is 5101 only. Damage and stock differences show apart, as
  «خسائر وفروقات مخزون», on «المالية» and in the income statement.
- **F-09:** a stocktake counted more than three days ago cannot be applied
  (`STOCKTAKE_STALE`); count again.
- **F-10:** an entry dated more than two days back needs `accounting.close` and a reason. Closed
  months refuse it, as before.
- **F-11:** new accounts:
  - 1106 ذمم شركات الشحن (heading);
  - 1107 عهدة مندوب التحصيل;
  - 1202 مجمع الإهلاك;
  - 5212 هدايا وإكراميات;
  - 5213 أجور شحن الطلبات;
  - 5214 إعلانات ممولة;
  - 5215 مصروف الإهلاك.
- **F-13:**
  - a malformed id answers 404, not 500;
  - `/inventory/movements` honours `limit` (1–200);
  - entry memos count pieces the Arabic way.
- **Still to agree** (bigger designs): F-04 Libya as a branch, F-06 gifts, F-07 cost correction, F-12 online
  orders.

**An easier till (2026-10-21):**
- **Three steps:** scan → pay → done. The scanner box keeps the focus; the last piece shows
  framed, with a sound.
- **Search by name** (F2), for pieces without a readable label.
- **The cart:** finger-sized − / + per line.
- **Paying:** one tap «كاش ليرة — المبلغ كامل» (F4), round amounts in pounds, banknotes in
  dollars and lira, a big keypad for any other amount, and «الباقي على حساب زبون». What is
  missing, or the change, shows in large figures.
- **After the sale:** the receipt prints by itself, a full-screen «✓ الباقي للزبون», and the till
  is empty for the next customer; «آخر فاتورة» reopens it.
- **Opening a shift** starts from the last count: one tap when the drawer is unchanged.

**Suppliers and customers (2026-10-21, ADR-016):**
- **One page, «الموردون والزبائن»:** إلنا عندهم (customers) and إلهم علينا (suppliers), each in
  their own currency. Every party has a statement (كشف حساب).
- **Receipts:** pick the supplier, and «بالدين» or «دفعت كاش» from a box. The cost must be in the
  supplier's currency.
- **Paying and collecting:** from or into any box; another currency counts at today's rates.
  Exchange differences go to their account.
- **The till:** «على الحساب» for a known customer, in part or in full. A refund goes back onto
  the account, and the receipt shows it.
- **Wholesale:** goods out of a warehouse can go on a merchant at an agreed total (4103), until
  the full wholesale phase.
- **Unnamed balance:** what the books hold with no supplier named (live: 13,902.45 $ from 62
  older receipts) shows on the page and on «اليوم». The owner closes it: paid from a box, or
  already paid.
- **The books' accounts 1103 and 2101** move only this way now.

**Payroll and advances (2026-10-20, ADR-015):**
- **Employees** with their salary, its currency (SYP, USD, LYD, TRY) and whether they are paid
  monthly or weekly, under «المالية» → «الرواتب والسلف».
- **Advances:** given out of a box, taken back on a pay sheet (the owner picks how much) or paid
  back in cash; each employee's page shows what they owe and every movement.
- **Pay sheets:** new sheet → edit bonus, deduction, advance → approve (the salary expense goes
  into its own month) → pay from a box per currency, everyone or one by one. An approved sheet
  nobody was paid from can be cancelled.
- **The books stay in step:** 1104 and 2102 move only with payroll and are checked against it;
  «اليوم» shows unpaid salaries and a missing sheet; «إقفال الشهر» warns before closing a month
  without its sheet.
- **Who sees salaries:** the owner and the accountant only.

**Simpler app (2026-10-20, research report «تبسيط واجهة نظام الثوب»):**
- **One home per job:** the owner lands on «اليوم» (sold today, money per box, what needs
  attention, six big actions); a cashier goes straight to the till; warehouse staff get «عمل
  المخزون».
- **The switch** المخزون | المتجر | المالية shows only to people with more than one side.
- **Setup in one place:** «الإعدادات» holds options, rates (once), locations, users and the
  chart of accounts.
- **Selling at the store is the POS only;** the warehouse keeps «إخراج بضاعة».
- **Money in plain words:** مصروف، مصاري دخلت، تحويل، صرافة, with the expense form showing
  expense accounts first. Entries, the chart and closing a month are grouped «للمحاسب».
- **Small fixes:** Arabic-Indic digits are accepted in amounts and barcodes; an offline banner
  shows when the connection drops; bigger buttons at the till.

**Point of sale (2026-10-20, ADR-014):**
- «المتجر» is the third side of the switch.
- **Shifts:** a shift opens with the drawer counted in SYP, USD and TRY, and closes with it
  counted again; the shortage or overage is shown per currency.
- **Selling:** scan, take SYP, dollars and/or Turkish lira at the owner's rates, change in SYP,
  and the receipt prints on 80 mm.
- **Refunds and discounts** are a manager's (`retail.manage`). Refunds come back at the cost the
  pieces left with.
- **The books:** each closed shift posts one entry (cash per currency, sales, returns,
  over/short).
- **The Turkish lira** is a fourth currency: rates, a store box, costs.

**Accounting — ledger core (2026-10-19, ADR-013):**
- **Books:** double entry in USD, with each line's own currency (SYP, LYD), tagged Syria or Libya.
  The database itself refuses unbalanced, edited or deleted entries, and anything dated in a closed
  month.
- **Stock posts by itself:** every stock movement posts at its stored value (a stock account per
  location, goods in transit, cost of goods sold, damage, stock differences, suppliers). The books
  check compares each location's stock account with its stock value.
- **Vouchers** on «المالية»: سند قبض, سند صرف, تحويل, صرافة and قيد يومية, posted once per request
  (idempotent), with gap-free numbers. Corrections are reversing entries.
- **Reports:** box balances, account statements, the daybook (printable), profit and loss, the
  balance sheet, the trial balance, and the دفتر الجرد print.
- **Month close:** SYP and LYD are revalued at the owner's rate, then the month is locked.
- **Chart of accounts:** installed at start-up, with three boxes (store SYP/USD, Libya LYD/USD,
  owner's safe USD). The owner can add accounts.
- **Permissions:** `accounting.view` / `.post` / `.close`. The accountant role has view and post.
- **Opening counts now require a unit cost**, like receipts.
- **Next:** 7b, suppliers and customers with their statements.

**Currencies (2026-10-13, ADR-012):** retail prices typed per country — SYP for Syria, LYD (3
decimals) for Libya; wholesale stays USD. Stock value, average cost and reports are in USD (the
ledger was converted by replaying it). The owner sets the SYP and LYD rates on «أسعار الصرف»
(`admin.rates.write`); a cost in SYP or LYD starts at that rate.

**Category → product → size (2026-10-11, ADR-011):** ثوب and طقم are categories (a tree, up to
three levels); a product is one design (its options except the size) with its own photos and
price; its sizes carry barcode, SKU and stock. Everything is editable; what never had stock can be
deleted.

**Live (2026-10-11):** https://system.arabthob.com — Railway (europe-west4), real Neon database,
S3 photos. Railway's auto-deploy from GitHub is not connected yet: deploy with `railway up`.

**Guided app (2026-10-12):** the home page lists the six setup steps (options → categories →
products → prices and photos → labels → opening count), ticks them from the data and opens the
next one with one button. Every page says what it is for; empty lists explain what goes there; the
menu is grouped (الإعداد · المخزون · التقارير) and filtered by permission, with a phone menu; stop and
delete sit in a «إيقاف وحذف» box at the bottom; a green message confirms each save and names the
next step; «؟» hints and the «المساعدة» page explain the words. Option types and values that
nothing uses can now be deleted. Text is 18 px; label bars are sized in whole printer dots.

**Practice mode:** `pnpm dev:practice` runs the app on a separate `althobe_practice` database with a
yellow «وضع التدريب» banner — for learning the scanner and printer without touching real stock.

## Roadmap

| Phase | Name | Status |
| --- | --- | --- |
| 0 | Documentation foundation | ✅ Done |
| 1 | Inventory foundation — the ledger | ✅ Done |
| 2 | Thin slice to the scanner — login, products, labels, opening count, receive | ✅ Done |
| 3 | Warehouse app, complete — transfer, damage, stocktake, adjustment, history, reports, user management | ✅ Done (OpenAPI client deferred) |
| 4 | Store / POS | ✅ Syrian store (2026-10-20, ADR-014) |
| 5 | Purchasing | |
| 6 | Sales + customers | |
| 7 | Accounting | 7a ✅ ledger core (2026-10-19) · 7c ✅ POS posting (2026-10-20) · 7d ✅ payroll (2026-10-20, ADR-015) · 7b ✅ suppliers and customers (2026-10-21, ADR-016) |

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
