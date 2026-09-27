# Inventory module — rules for agents

Read `docs/inventory.md` before changing anything here.

- **Never write `inventory_movements` or `inventory_balances` outside `inventory.ledger.ts`.**
  New stock behaviour = a new `MovementEntry` shape passed to `applyMovements`, not new SQL.
- Lock order is `(location_id, variant_id)` ascending. Never lock balance rows any other way.
- No `Promise.all` on a transaction client — one interactive transaction is one connection.
- Money is `bigint` minor units. Never `Number()` a money value, never a float.
- The location policy lives only in `inventory.policy.ts`.
- Every behaviour change ships with an integration test against the Neon test branch
  (`*.int.test.ts`). Do not mock Prisma. Do not weaken an assertion to make a test pass.
- Error codes are a public contract (`inventory.errors.ts`). Adding is fine; renaming is breaking.
