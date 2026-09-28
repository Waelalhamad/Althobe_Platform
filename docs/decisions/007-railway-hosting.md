# ADR-007: Railway as the application host

- Status: **Accepted**
- Date: 2026-09-28

## Decision

The application runs on **Railway**, region **europe-west4 (Netherlands)**, as **one Docker
service**: Fastify serves the API under `/api/v1` and the built warehouse app from the same origin
(ADR-005). The database stays on Neon, Frankfurt (ADR-006). Product photos go to a private **AWS S3**
bucket in `eu-central-1`, accessed by a dedicated least-privilege IAM user.

| Piece | Where |
| --- | --- |
| Image | `Dockerfile` (repo root): `node:22-bookworm-slim` + OpenSSL, pnpm workspace build |
| Deploy config | `railway.json`: Dockerfile builder, pre-deploy migrations, health check |
| Migrations | `pnpm --filter @althobe/backend db:migrate` as the **pre-deploy** command; never resets |
| Health check | `GET /api/v1/health`: 200 when the database answers within 5 s, else 503 |
| Secrets | Railway service variables only — never in git, files, or chat |

## Context

The warehouse and the store need the app on phones, tablets and PCs; until now it ran only on the
owner's PC. ADR-006 requires the API to run near Frankfurt, because every query crosses the network.

## Why Railway

- Deploys on every push to `main` from GitHub; HTTPS and a domain included.
- europe-west4 is ~10 ms from Neon Frankfurt.
- Runs a plain Dockerfile, so nothing is Railway-specific: the same image runs on AWS (ECS/App
  Runner) or any container host if the business outgrows it.
- Low cost at this size (a few dollars a month for one small service).

## Consequences

- One region, one instance: a Railway outage stops the app. Acceptable for an internal tool;
  stock data is safe in Neon regardless.
- A request that loses its database socket fails within ~30 s (pool timeouts in `shared/db.ts`)
  instead of hanging; the app's scan queue retries it.
- Migrations run before a release goes live; a failed migration keeps the previous release running.
- `NODE_ENV=production` turns on `Secure` cookies and listening on `0.0.0.0`.
