# ADR-006: Neon as the PostgreSQL host

- Status: **Accepted**
- Date: 2026-09-24

## Decision

The PostgreSQL database (ADR-001) is hosted on **Neon**: Postgres 18, region **AWS eu-central-1
(Frankfurt)**, the nearest Neon region to Syria. There is no local database and no Docker in the
development workflow.

| Use | Connection |
| --- | --- |
| Application runtime | **Pooled** URL (`-pooler` host, `pgbouncer=true`) → `DATABASE_URL` |
| Migrations | **Direct** URL → `DIRECT_URL` (schema changes cannot run through the pooler) |
| Tests | A separate database (`althobe_test`) or a separate **`test` branch** → `TEST_DATABASE_URL` |
| CI | A throwaway branch created per run and deleted afterwards |

## Context

The business owner chose Neon to avoid running and maintaining a database locally. Neon is plain
PostgreSQL, so nothing in ADR-001 changes: transactions, `SELECT … FOR UPDATE`, check
constraints, sequences, and PL/pgSQL triggers all work as specified.

## Consequences

Benefits:

- no local infrastructure: nothing to install, start, or back up by hand
- managed backups with point-in-time restore
- **branches**: tests and CI run on isolated copies, never on real data
- the same database from any machine a developer works on

Trade-offs, and what we do about them:

- **Latency.** Every query crosses the network. The API must run **in the same region**
  (Frankfurt) as the database. An API on a local server in Syria talking to Frankfurt would pay
  the round trip on every query, several times per scan. This rules out the "local server at the
  business" hosting option.
- **Internet dependency.** With the database in the cloud, the warehouse and store need internet
  to write stock. The Phase 4 POS will need an offline plan: queue sales locally and sync them.
- **Scale to zero.** On plans where the compute suspends when idle, the first query after a quiet
  period is slower. Disable auto-suspend on the production branch before go-live.
- **Destructive commands.** `prisma migrate reset` would wipe the real database, so the project
  has no reset script. Migrations are applied with `prisma migrate deploy`, which never resets.
- **Test safety.** The test suite wipes its database between tests, so it refuses to start unless
  `TEST_DATABASE_URL` is set and differs from both `DATABASE_URL` and `DIRECT_URL`.

## Amendment — 2026-09-24: port 443, not 5432

The development network (VPN / ISP) **blocks TCP port 5432** to Neon while port 443 is open. Two
things follow:

- **The application connects through Neon's WebSocket driver** (`@neondatabase/serverless`) via
  Prisma's driver adapter (`@prisma/adapter-neon`). It carries the normal Postgres protocol over a
  WebSocket on port 443, so it works anywhere HTTPS works. Transactions, `SELECT … FOR UPDATE`,
  and raw SQL behave exactly as over TCP. Measured: ~2 s to wake a cold compute, then ~110 ms per
  round trip from the development machine to Frankfurt.
- **Migrations run through `scripts/migrations.ts`** over the same driver, because Prisma's
  migration engine needs port 5432. It writes Prisma's own `_prisma_migrations` table with
  Prisma's checksums, so `prisma migrate deploy` stays fully compatible wherever 5432 is open.

Known limitation of the adapter: Postgres's internal `name` type (e.g. `current_database()`,
`pg_tables.tablename`) cannot be decoded — cast it to `::text` in raw queries.

The test database is `althobe_test` on the same Neon project: a separate database, so the suite's
wipe cannot reach real data. The test setup refuses to run if `TEST_DATABASE_URL` names the same
endpoint **and** database as `DATABASE_URL` or `DIRECT_URL`. CI still uses a throwaway branch.
