# ADR-020: Libya as a branch, and shipments between branches

- Status: **Accepted**
- Date: 2026-10-23
- Builds on: ADR-012 (currencies), ADR-013 (the ledger)
- From: the developer report «أخطاء النظام المالية», item F-04

## Context

The second warehouse (WH2) was the Libya warehouse in fact, but nothing said so. Its account was
tagged Syria, transfers to it were instant, and nothing kept Libya's numbers apart. Owner's answers
(2026-10-23):

- shipments take days, and Libya confirms what arrived;
- someone in Libya uses the system;
- the Libya warehouse is empty today.

## Decision

**Every location has a branch.**

- `locations.branch` is SY or LY. WH2 becomes «مستودع ليبيا» (LY), and its stock account becomes
  «مخزون مستودع ليبيا» (LY).
- Each location's stock account takes the location's branch, so every stock posting there is that
  branch's. The income statement and balance sheet with «ليبيا» show Libya alone.

**A transfer to the other branch is a shipment**, in two steps through the road between branches.
The road is a location of the new kind `TRANSIT`. There is one, and it belongs to no branch.

1. **Sending:** a `TRANSFER` scan session whose destination is in the other branch. Its pieces go
   from the sender to the road (`TRANSFER_OUT` / `TRANSFER_IN`), and a `shipments` row records what
   was sent, with its lines.
2. **Receiving:** the destination opens a `SHIPMENT_IN` scan (`POST /shipments/:id/receive`) and
   scans what arrived. Its commit moves what arrived from the road to the destination at the
   road's value.
   - **Short:** each piece sent but not arrived is a `SHIPPING_LOSS` from the road, posted to the
     new account 5104 فقد بالشحن.
   - **Refused:** more than was sent, or a variant that was not sent (`SHIPMENT_EXCESS`).

**Guards:**

- An instant transfer across branches is refused by the stock ledger (`SHIPMENT_REQUIRED`).
- Nothing moves on the road except through a shipment, and no session opens there.
- Transfers inside a branch stay instant.

**How the books stay apart per branch.** Each half of a transfer posts against 110599, tagged with
its own location's branch, and the road's lines have no branch. So:

- **Sent, Syria:** stock down, 110599 up.
- **Received, Libya:** stock up, 110599 down.

Each branch's trial balance adds up on its own. Per branch, 110599 is what one branch holds for
the other (the inter-branch current account), and across both it is zero. No separate «جاري بين
الفروع» account was needed.

**A user can be kept to a branch** (`users.branch`; null means every branch). Such a user:

- sees only that branch's locations as their own, and the other branch's as destinations;
- moves stock, scans, counts and reads balances, history, adjustments and stocktakes only there
  (`LOCATION_OUT_OF_BRANCH`);
- sees the shipments to and from their branch.

The check sits in the stock ledger for every write, and in each read. A keeper in Libya is the
ordinary warehouse keeper role with branch LY, so no new role was needed.

## Consequences

- **New enum values:** `location_kind.TRANSIT`, `movement_type.SHIPPING_LOSS` and
  `scan_session_kind.SHIPMENT_IN`.
- **New tables and columns:** `shipments`, `shipment_lines`, `locations.branch` and
  `users.branch`.
- **Libya's selling** (online, shippers, collection) is F-12. It builds on this branch.
- **Two shipments of the same size on the road at once** share the road's average cost, the
  system's rule everywhere.
