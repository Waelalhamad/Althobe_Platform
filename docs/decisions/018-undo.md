# ADR-018: «تراجع» — the owner undoes a manual stock movement

- Status: **Accepted**
- Date: 2026-10-23
- Builds on: ADR-013 (the ledger), ADR-017 (adjustment reasons)

## Context

Mistakes made with a manual adjustment were put right with another adjustment, at a different
cost. That showed as profit or loss that never happened (live, 13–14 October: «صافي الربح
15.85 $» with no sales). The owner asked for a way to undo a mistaken operation, or to delete it.

## Decision

**Nothing is deleted.** A movement is undone by a new one, and both stay in the history.

- **What can be undone:** a manual adjustment (`ADJUSTMENT`) or a damage write-off (`DAMAGE`), with
  reference `MANUAL`. Receipts are put right with «تصحيح الاستلام» (ADR-017), sales with a
  refund, and manual vouchers with «قيد عكسي».
- **How:** `POST /inventory/movements/:id/undo` with `{ reason }`. It creates a movement of the same
  type, with the opposite quantity and **exactly the opposite value**, not today's average.
  `reverses_id` links it to the original.
- **The books:** it posts like any movement of its type, to the same account and the other way,
  so the original's effect is gone exactly. It is dated today, so no closed month is touched.
- **Refused:**
  - when the pieces it would take back are no longer there at a sound value (sold or moved):
    `MOVEMENT_UNDO_NOT_POSSIBLE`; that case goes through a stocktake;
  - an undo of an undo, a second undo, or any other kind: `MOVEMENT_NOT_UNDOABLE`. The database
    holds `reverses_id` unique.
- **Who:** the new permission `admin.undo`, so the owner only (managers do not hold `admin.*`). A
  reason is always required.

## Consequences

- `inventory_movements.reverses_id`; a positive `DAMAGE` is allowed only as an undo.
- The history shows «تراجع» on the owner's screen and marks undone movements «متراجَع عنها».
