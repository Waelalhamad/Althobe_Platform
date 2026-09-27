# Security

Status: specification. No code exists yet.

This is an internal business system holding stock, prices, costs, customer records, and money.
The realistic threats are not anonymous attackers on the internet: they are a shared password,
a cashier who can edit stock, an ex-employee whose account still works, and a backup nobody
ever restored.

## Authentication

- Sessions, not long-lived JWTs. Session id in an `httpOnly`, `secure`, `sameSite=strict`
  cookie; session state server-side in a Postgres `sessions` table so revocation is instant.
  (Redis is not needed for this; one less service to run and back up.)
- Passwords hashed with **argon2id**. Never bcrypt-with-low-cost, never SHA anything, never a
  home-made scheme.
- Minimum password length 12. Check against a breached-password list on set and on change.
- Login is rate-limited per account and per IP, with exponential backoff and a lockout that an
  administrator can clear.
- Sessions expire after inactivity: 12 hours for office apps, 8 hours for POS and warehouse.
- Logout revokes server-side. "Delete the cookie" is not logout.
- Every user is one real person. Shared accounts are forbidden — they destroy the audit trail,
  which is the whole point of having one.
- Two-factor authentication (TOTP) is required for any account holding `admin.*` permissions.

## Authorization

RBAC with explicit, granular permissions. Roles are bundles of permissions; code checks
**permissions**, never role names.

```ts
// correct
requirePermission('inventory.adjust');

// forbidden
if (user.role === 'manager') { ... }
```

Permission naming: `<module>.<resource>.<action>`

```
inventory.view
inventory.receive
inventory.issue
inventory.transfer
inventory.damage
inventory.adjust
inventory.reserve
inventory.release
inventory.stocktake.count
inventory.stocktake.apply
inventory.cost.view
products.read
products.write
pricing.wholesale.write
sales.order.create
sales.order.discount
invoicing.issue
invoicing.void
accounting.read
employees.read
employees.salary.read
admin.users.write
admin.roles.write
```

Starting roles:

| Role | Arabic | Shape |
| --- | --- | --- |
| `owner` | مدير عام | everything |
| `manager` | مدير | everything except `admin.*` and `employees.salary.*` |
| `inventory_manager` | مدير مخزون | all `inventory.*`, including adjust, stocktake apply, and cost |
| `warehouse_keeper` | أمين مستودع | view, receive, issue, transfer, damage, stocktake count; no adjust, no apply, no cost |
| `store_staff` | موظف متجر | view stock at the store, POS sale (later); no cost, no discount beyond a configured limit |
| `accountant` | محاسب | accounting, invoicing, `inventory.view`, `inventory.cost.view` |
| `wholesale_customer` | زبون جملة | own orders, own invoices, own prices, nothing else |

The full inventory permission table, with what each allows, is in `docs/inventory.md`.

Roles are defined in code (`backend/src/modules/auth/roles.ts`); `manager` is every permission
**except** `admin.*`, so only the owner manages accounts.

### Account management (implemented)

- There is no self-registration. The owner creates accounts in the app (المستخدمون) or with
  `pnpm user:create`; the server generates a one-time password that is shown once and handed over
  in person. The person changes it under حسابي.
- Nobody can deactivate themselves or remove their own owner rights, and the last active owner
  can never be removed — the system cannot be locked out of its own administration.
- Deactivating a user, changing their roles, or resetting their password ends all their sessions
  immediately. Changing your own password ends your other sessions and keeps the current one.
- Login responses and `/auth/me` never contain anything password-related (tested).

Rules:

- Deny by default. An endpoint with no declared permission does not run.
- Authorize on the server, every time. Hiding a button is user experience, not security.
- **Cost prices are a permission** (`inventory.cost.view`). Store staff must not see margin.
- Location-scoped roles are checked against the location in the request, not just the action.
- Approving your own request is not allowed: adjustments above a threshold, and any stocktake
  application, need a second user.

## Audit

Every state-changing action writes an `audit_logs` row, in the same transaction as the change:

```
id, actor_user_id, action, entity_type, entity_id,
before (jsonb), after (jsonb), ip, user_agent, created_at
```

- Audit rows are append-only. No update, no delete, no soft delete.
- Reading cost, salary, or customer data is logged too, not only writing.
- Audit entries are immutable even for `owner`. If the owner can rewrite the log, there is no log.

## Data protection

- All traffic over HTTPS. HSTS enabled.
- Database not reachable from the public internet. Application connects over a private network.
- Encryption at rest for database volumes and backups.
- Backups encrypted, off-site, and **restored in a rehearsal before go-live**.
- Personal data stored: name, phone, address, and for employees national id and salary. Salary
  and national id are readable only with explicit permission and every read is audited.
- No real customer data in development or staging. Seed data is synthetic.
- No customer data, tokens, or passwords in logs. The logger redacts a defined key list
  (`password`, `token`, `authorization`, `cookie`, `nationalId`, `salary`).

## Input and output

- Every external input validated with Zod before it reaches a service.
- All database access through Prisma, parameterized. Raw SQL only with `$queryRaw` tagged
  templates — never string concatenation.
- React escapes by default; `dangerouslySetInnerHTML` is forbidden without a written reason.
- File uploads: allowlist of extensions and MIME types, size cap, stored outside the web root,
  served through an authorized endpoint, never executed.
- CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- CSRF protection on all cookie-authenticated state changes.

## Secrets

- Never committed. `.env` is git-ignored; `.env.example` lists keys with empty values.
- Production secrets live in the deployment platform, not in the repository and not in chat.
- Rotate on any staff departure, and at least annually.
- If a secret is ever committed, it is burned: rotate it, do not just delete the commit.

## Dependencies

- Lockfile committed; installs use the lockfile.
- Automated vulnerability scan in CI; a critical advisory blocks the pipeline.
- Adding a dependency needs a justification in the PR. Prefer the standard library, then a
  small well-maintained package, then writing twenty lines yourself.

## Offboarding

When someone leaves: disable the account (do not delete it, the audit trail references it),
revoke sessions, rotate shared credentials, and remove device access. Run this the same day.

## Forbidden

- Never log or display a password, token, or session id.
- Never disable a permission check "temporarily" for development.
- Never add an endpoint that trusts a user id or a role sent by the client.
- Never grant `owner` to a service account or a test.
- Never copy production data to a laptop.
