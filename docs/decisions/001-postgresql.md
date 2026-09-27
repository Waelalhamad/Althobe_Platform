# ADR-001: PostgreSQL as the primary database

- Status: **Accepted**
- Date: 2026-09-21

## Decision

Use PostgreSQL as the single primary database for all business data. Redis is used for cache,
queues, and locks only — never as a source of truth.

## Context

The platform holds inventory, purchasing, sales, wholesale, retail, invoicing, accounting, and
payroll data. These are not independent documents; they are one connected ledger seen from
different angles. The hard requirements are:

- **Transactions.** A stock transfer writes two movements and two balances. A sale writes a
  movement, an order line, and an invoice line. Any of these landing half-written is a
  corrupted business, not a corrupted record.
- **Referential integrity.** An invoice line must point at a variant that exists. The database
  should refuse the alternative, not rely on every developer remembering.
- **Constraints as rules.** `quantity >= 0`, `unique(variant_id, location_id)`, unique barcode.
  These are business rules that must hold even when a bug, a script, or an AI agent tries to
  break them.
- **Reporting.** Stock valuation, margin by product, supplier performance, ageing receivables —
  all relational aggregation over multiple entities.
- **One writer, many readers.** Four apps write to the same stock numbers concurrently.

## Alternatives considered

**MongoDB.** Document storage suits documents that are read and written whole. Our data is
highly relational and needs multi-document transactions on nearly every write, which is the
case where a document store is at its weakest. Constraints would move into application code,
exactly where they get bypassed.

**MySQL.** Workable, but Postgres gives us stronger types (native `uuid`, `jsonb`, arrays,
enums), better partial and expression indexes, `SELECT ... FOR UPDATE` semantics we rely on for
stock locking, and window functions that make ledger reporting straightforward.

**SQLite.** Fine for a single-user tool. Concurrent writes from four apps rule it out.

## Consequences

Benefits:

- transactional correctness for stock and money
- constraints enforce business rules independently of application code
- rich, fast reporting queries without a second system
- mature tooling, Prisma support, well understood operationally

Trade-offs:

- schema changes require migrations and planning
- a badly written migration can lock a large table, so migrations must be reviewed
- the schema must be designed, not discovered — which is the intent

## Revisit if

Read load on reporting overwhelms the primary, in which case add a read replica before adding
a different database. A second database technology needs its own ADR and a stated reason that
Postgres cannot serve.
