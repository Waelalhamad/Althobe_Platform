# Development Rules

How to work in this repository. Applies to every contributor, human or AI agent.
Project facts, stack, and architecture rules live in `CLAUDE.md` — not here. Keep the two
files non-overlapping so they cannot contradict each other.

## Workflow

Before modifying code:

1. Inspect the relevant files.
2. Understand the existing behaviour.
3. Read the documentation for the affected area (routing table in `CLAUDE.md`).
4. Read the related tests — they are the real specification.
5. Implement the smallest change that solves the task.

After modifying code:

1. Format (`pnpm format`).
2. Typecheck (`pnpm typecheck`).
3. Run the relevant tests (`pnpm test <scope>`).
4. Lint (`pnpm lint`).
5. Review your own diff line by line.
6. Update documentation if a rule, contract, or schema changed.
7. Update `PROJECT_STATUS.md` if the task moved a phase item.

## Change scope

Keep changes focused on the task.

Do not:

- refactor unrelated code
- rename unrelated files or symbols
- reformat files you did not otherwise change
- modify unrelated APIs
- introduce libraries without approval
- "fix" things you noticed in passing — report them instead

If you find a real problem outside the task, finish the task and list the problem in your
summary under **Noticed, not fixed**.

## Uncertainty

If a requirement is ambiguous:

- Do the parts that are unambiguous.
- State the assumption you made, explicitly, in the summary.
- Ask only when proceeding either way would produce materially different work, or would be
  destructive or irreversible.

Never invent a business rule to fill a gap. An invented rule that reaches the ledger is worse
than a question.

## Database

- Never manually modify production data.
- Schema changes must go through a Prisma migration, committed with the code that needs it.
- Destructive migrations (drop column, drop table, type narrowing, data backfill) require
  explicit human approval before being written.
- Never write a migration that deletes rows from `inventory_movements` or any financial ledger.
- Seed data is for development only and lives in `backend/prisma/seed.ts`.

## API

API contracts are public interfaces.

A breaking change requires:

- a documentation update in `docs/api.md`
- a migration strategy (new version or additive field, deprecate, then remove)
- tests covering the old and new shapes during the transition

Additive and optional is always preferred over breaking.

## Tests

- New business logic ships with tests in the same commit.
- A failing test is a finding, not an obstacle. Do not delete, `skip`, or loosen assertions to
  get green. If a test is genuinely wrong, say so and explain why before changing it.
- Inventory and money code requires integration tests against a real PostgreSQL instance,
  not mocks.

## Git

Small, focused commits. Conventional Commits format:

```
feat(inventory): add stock receiving
fix(inventory): prevent negative stock on issue
test(inventory): add transfer transaction rollback tests
docs(barcode): document check digit calculation
refactor(api): extract pagination helper
chore(deps): bump prisma to 6.2
```

Branches: `feature/*` · `fix/*` · `refactor/*` · `docs/*`

Never force-push a shared branch. Never commit directly to `main`.

## Reporting

End every task with:

- **Changed** — files and what each change does
- **Tested** — commands run and their result (paste failures, do not summarise them away)
- **Assumptions** — anything you decided that was not specified
- **Noticed, not fixed** — real problems outside scope

Report honestly. "Tests pass" is only true if you ran them.

## Definition of Done

A task is complete only when:

- implementation is complete (no TODOs left behind silently)
- types pass
- lint passes
- unit tests pass
- relevant integration tests pass
- no unrelated files changed
- API and schema changes are documented
- migrations are included when required
- permissions/authorization for new endpoints are verified
- `PROJECT_STATUS.md` reflects reality

If CI is red, the task is not done.
