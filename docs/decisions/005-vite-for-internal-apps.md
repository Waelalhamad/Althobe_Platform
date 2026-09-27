# ADR-005: Vite + React for internal apps, not Next.js

- Status: **Accepted**
- Date: 2026-09-24

## Decision

The internal apps — `warehouse`, `admin`, `retail` (POS) — are **Vite + React 19 single-page
apps** with TanStack Router and TanStack Query. Each is built to static files and served by the
Fastify API from the **same origin**.

Next.js is reserved for a future **public** surface (an online catalogue or storefront), if one is
ever built.

## Context

The original stack named Next.js for every app. Looked at against what these apps actually are:

| Question | These apps | Consequence |
| --- | --- | --- |
| Public? SEO? | No — everything is behind a login | Server-side rendering buys nothing |
| Where is the logic? | In the Fastify backend (`InventoryService` and friends) | Next.js server components and server actions would be a second backend, and an easy way to reach the database from a page — which `CLAUDE.md` forbids |
| What kind of UI? | Scanner-driven, highly interactive, client state | Exactly what a single-page app is for |
| How is it hosted? | Docker Compose on one server | Static files need no extra Node process |
| Offline? | The store/POS will want an offline shell | `vite-plugin-pwa` makes that straightforward |

## Consequences

Benefits:

- one backend, one place for business rules; the front-end can only reach data through the API
- same-origin serving: `sameSite=strict` session cookies, no CORS configuration
- no front-end server to run, monitor, or patch
- fast dev loop; a smaller surface for contributors and AI agents to learn
- installable PWA on tablets and phones

Trade-offs:

- no server-side rendering — irrelevant behind a login
- routing, data fetching, and code splitting are assembled from libraries rather than given by
  one framework; TanStack Router + Query cover it

## Revisit if

A public-facing, search-indexed surface is needed. That becomes a separate Next.js app calling
the same API — not a reason to move the internal apps.
