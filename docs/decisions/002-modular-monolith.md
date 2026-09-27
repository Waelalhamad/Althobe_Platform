# ADR-002: Modular monolith, not microservices

- Status: **Accepted**
- Date: 2026-09-21

## Decision

Build the backend as a single deployable application, internally divided into modules with
enforced boundaries. Each module owns its tables and exposes a public service interface. No
module reads another module's tables.

## Context

The system spans inventory, purchasing, sales, wholesale, retail, invoicing, accounting, and
employees. That breadth makes microservices look like the obvious answer. It is not, for this
business:

- The team is small. Microservices trade a code-complexity problem for an operations problem,
  and an operations problem needs people to operate it.
- The core operations are transactional across domains. Selling a thobe touches sales,
  inventory, and invoicing in one atomic step. Across services that becomes a distributed
  transaction, a saga, compensating actions, and a new class of bug where stock left but the
  invoice did not.
- Load is a shop and a warehouse, not a global marketplace. One well-built Postgres instance
  and one Node process handle this comfortably for years.
- Nobody knows the right service boundaries yet. Drawing them now means drawing them wrong, and
  a wrong boundary between two deployed services is far more expensive to move than a wrong
  boundary between two folders.

The real value people want from microservices is **isolation**, not separate deployment.
Isolation is achievable inside one process, with discipline and a linter.

## Decision detail

- One backend deployable, `backend/`.
- `backend/modules/<domain>/` with `controller`, `service`, `repository`, `schema`.
- A module may call another module's exported service. It may not import its repository or
  query its tables.
- The module dependency graph stays acyclic.
- `shared/` holds infrastructure only: database client, logger, errors, money, ids, dates.
  No business rules.
- Boundaries are enforced mechanically by ESLint import rules, not by good intentions.

## Consequences

Benefits:

- real database transactions across domains, with no saga machinery
- one repository, one build, one deployment, one log stream, one debugger
- refactoring across boundaries is a normal code change
- local development is `docker compose up` and `pnpm dev`

Trade-offs:

- boundaries erode unless enforced; the lint rule is not optional
- the whole application scales as one unit
- one bad deployment affects everything, so CI and rollback must be solid from the start

## Extraction path

If a module later genuinely needs its own deployment — independent scaling, a separate release
cadence, or a separate team — extracting it is mechanical, because it already owns its tables
and is already called through an interface. Replace the in-process call with an HTTP client and
deploy the folder.

Do not pre-split. Extraction is the reward for having discovered a real boundary, not a design
starting point.

## Revisit if

A single module's resource profile or release cadence is demonstrably in conflict with the
rest, and the conflict is measured, not predicted.
