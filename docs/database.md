# Database Conventions

Status: specification. No migrations exist yet.

PostgreSQL is the primary database ([ADR-001](decisions/001-postgresql.md)). Prisma is the
access layer. These conventions are not suggestions — a migration that breaks one gets rejected.

## Naming

| Thing | Convention | Example |
| --- | --- | --- |
| Table | plural, snake_case | `product_variants` |
| Column | snake_case | `available_quantity` |
| Primary key | `id`, UUID v7 | `id uuid primary key` |
| Foreign key | `<entity>_id` | `location_id` |
| Enum type | singular, snake_case | `movement_type` |
| Index | `idx_<table>_<columns>` | `idx_inventory_movements_variant_id` |
| Unique constraint | `uq_<table>_<columns>` | `uq_product_variants_barcode` |
| Check constraint | `ck_<table>_<rule>` | `ck_inventory_balances_non_negative` |
| Timestamps | `created_at`, `updated_at` | `timestamptz not null default now()` |

Prisma models are PascalCase and singular, mapped explicitly:

```prisma
model ProductVariant {
  id        String   @id @default(uuid(7))
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt      @map("updated_at")

  @@map("product_variants")
}
```

## Rules for every business entity

- `id` — UUID v7 (time-ordered, so it indexes well and does not leak a row count)
- `created_at`, `updated_at` — `timestamptz`, always UTC
- `created_by`, `updated_by` — user id, on anything a human can change
- No natural primary keys. SKU and barcode are unique columns, not keys.

## Soft delete

Soft delete (`deleted_at`) is allowed only where a row must disappear from the UI but stay
referenced: products, customers, suppliers, users.

Soft delete is **forbidden** on ledger tables: `inventory_movements`, `invoices`, `payments`,
`journal_entries`. Those rows are never deleted or hidden. Corrections are new rows.

Every query on a soft-deletable table filters `deleted_at is null`. Put that in the repository,
never leave it to the caller.

## Money

- Stored as **integer minor units**: `bigint`, plus a `currency` column (`char(3)`, ISO 4217).
- Never `float`, `double`, or `real` for money. Never a bare number without its currency.
- `numeric(18,6)` is used only for exchange rates and unit costs that need fractions.
- Quantities are `integer` (thobes are whole units). If a unit of measure that can be
  fractional is ever added, that is a migration and an ADR, not an inline change.

```prisma
priceAmount   BigInt @map("price_amount")
priceCurrency String @map("price_currency") @db.Char(3)
```

Column pairs always use the `<name>_amount` / `<name>_currency` suffix so they are greppable.

## Planned tables

**Catalogue**

```
categories            (tree up to 3 levels; code; unit_of_measure — ADR-011)
category_option_groups (the option types a category's products use)
products              (one design in a category: code = SKU base, style_key)
product_style_values  (one value per non-size type per product)
product_prices        (RETAIL / WHOLESALE per product, USD minor units)
product_variants      (sku, barcode, option_key)
option_groups         (option types: القصة، الزر، … — ADR-008)
option_values         (their values; deactivated, never deleted)
variant_option_values (the size of a variant)
variant_prices        (a size's own price, overriding its product's — ADR-009)
product_photos        (S3 keys of image + thumbnail, size, order; soft-deleted — ADR-010)
variant_barcodes      (external GTIN / supplier barcodes)
categories            (later)
```

**Locations**

```
locations             (kind: WAREHOUSE | STORE)
bins                  (later — shelves inside a warehouse)
```

**Inventory**

```
inventory_balances
inventory_movements
reservations
scan_sessions
scan_session_lines
scan_session_events   (unique (session_id, scan_id) — dedupes double scans)
stocktakes
stocktake_lines
idempotency_records
```

**Purchasing / sales / billing**

```
suppliers
purchase_orders
purchase_order_lines
goods_receipts
customers
sales_orders
sales_order_lines
deliveries
returns
invoices
invoice_lines
payments
credit_notes
```

**Platform**

```
users
roles
permissions
role_permissions
sessions
audit_logs
```

## Constraints that carry business rules

Documentation states the rule; the database enforces it.

```sql
-- identity
alter table product_variants add constraint uq_product_variants_sku     unique (sku);
alter table product_variants add constraint uq_product_variants_barcode unique (barcode);

-- one balance row per variant per location
alter table inventory_balances
  add constraint uq_inventory_balances_variant_location unique (variant_id, location_id);

-- stock can never go negative, and reservations can never exceed stock
alter table inventory_balances
  add constraint ck_inventory_balances_non_negative check (quantity >= 0),
  add constraint ck_inventory_balances_reserved     check (reserved_quantity >= 0
                                                      and reserved_quantity <= quantity);

-- movements are append-only, whichever role connects
create trigger trg_inventory_movements_append_only
  before update or delete on inventory_movements
  for each row execute function reject_mutation();
```

A trigger, not `REVOKE`: in development the application connects as the table owner, and a
revoke would silently not apply. The same trigger protects `audit_logs`.

If a rule can be expressed as a constraint, it is a constraint. A service check alone is not
enough — services get bypassed, constraints do not.

## Indexes

Index what is actually queried:

- every foreign key
- `inventory_movements (variant_id, location_id, created_at desc)` — ledger reads
- `inventory_movements (reference_type, reference_id)` — tracing a movement to its source
- `product_variants (barcode)` — scanner lookup, already unique
- partial indexes for status filters, e.g. `where status = 'DRAFT'`

Do not add an index speculatively. Add it with the query that needs it, and say so in the PR.

## Migrations

- Every schema change is a Prisma migration, committed with the code that needs it.
- Migration names describe the change: `20260921_add_inventory_movements`.
- Never edit a migration that has run anywhere but your own machine. Write a new one.
- Destructive changes (drop, rename, narrow a type, backfill) need explicit human approval,
  and run in two steps: add and dual-write first, remove in a later release.
- Migrations must be safe to run while the application is live. No long exclusive locks on
  large tables.

## Transactions and locking

- Read-modify-write on a balance uses `SELECT ... FOR UPDATE`, never an optimistic read.
- When locking more than one row, lock in a deterministic order (see `inventory.md`), or
  transfers between two locations will deadlock under load.
- Default isolation is `READ COMMITTED`. Do not raise it to paper over a missing lock.
- Keep transactions short. No HTTP calls, no barcode printing, no email inside a transaction.

## Backups

Daily automated backup with point-in-time recovery, retained 30 days, and a restore rehearsed
before go-live. A backup that has never been restored is not a backup.
