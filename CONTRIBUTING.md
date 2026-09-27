# Contributing

## Branches

```
feature/<scope>-<short-description>
fix/<scope>-<short-description>
refactor/<scope>-<short-description>
docs/<scope>-<short-description>
```

Branch from main. Never commit directly to main.

## Commit format

Conventional Commits:

```
feat(scope): description
fix(scope): description
test(scope): description
docs(scope): description
refactor(scope): description
chore(scope): description
```

Scopes follow module names: inventory, products, purchasing, sales, wholesale, retail,
accounting, auth, api, ui, db.

Keep commits small and self-contained. A commit that mixes a refactor with a behaviour change
is two commits.

## Pull requests

Every PR description must include:

- **Summary** — what changed and why
- **Tests** — what was added or updated, and the result of running them
- **Database changes** — migrations included, and whether any are destructive
- **API changes** — new, changed, or deprecated endpoints
- **Screenshots** — for any UI change, including the RTL layout
- **Dependencies** — any package added, with justification

## Review checklist

A reviewer should be able to answer yes to all of these:

- [ ] The change is limited to its stated scope
- [ ] Business logic is in a service, not a controller or a component
- [ ] No module reads another module tables directly
- [ ] All external input is validated with Zod
- [ ] Multi-step stock or money operations run inside a transaction
- [ ] Money uses integer minor units
- [ ] New endpoints have an explicit permission check
- [ ] Tests cover the failure paths, not only the happy path
- [ ] Documentation and PROJECT_STATUS.md are updated where needed

## Local setup

See README.md. Once the backend exists:

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm test
```

## Getting help

If a rule in docs/ is wrong or blocks you, change the rule in a PR — do not quietly work
around it. Undocumented exceptions are how a codebase stops matching its documentation.
