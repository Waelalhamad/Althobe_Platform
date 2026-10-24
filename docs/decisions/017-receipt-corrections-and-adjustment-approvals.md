# ADR-017: Receipt corrections, and adjustments with reasons and approval

- Status: **Accepted**
- Date: 2026-10-23
- Builds on: ADR-013 (the ledger), ADR-016 (receipt sources)
- From: the developer report «أخطاء النظام المالية» of 2026-10-21, items F-02 and F-03

## Context

Live receipt mistakes were put right with manual adjustments, the only tool there was. Every
adjustment posts to 5103 (stock differences), so the corrections showed as +78.85 $ of profit.
They also left the suppliers' account wrong: 176.50 $ for goods that never came, and 273 $
missing for goods that did. The reason was free text («خطأ إدخال», «إكرامية شحن»…), and an
increase created value at the average cost with nobody approving it.

## Decision

**A receipt is corrected on the receipt** (`POST /parties/receipts/:id/correct`). Each line can
become what it should have been:

- **less of it:** 0 takes the line back;
- **more of it;**
- **part of it moved to another variant:** a wrong size or design.

It is a new movement type, `RECEIPT_CORRECTION`: signed, on the same `SCAN_SESSION` reference,
and always at the line's own cost (for a variant that came in by a move, the cost it moved at).

- **Valued at the line's cost,** not the average, so the books undo exactly what the receipt
  posted.
- **Refused** (`RECEIPT_CORRECTION_NOT_POSSIBLE`) once that much is no longer there: when the
  stock left would have a negative value, or a value with no pieces. That is, the goods were sold
  or moved at a mixed cost. Such a case goes through a stocktake.
- **Posting:** to 2101, like the purchase (stock ↔ suppliers).
- **What else moves with it:** what the receipt was confirmed as, now kept per receipt
  (`receipt_terms`).

  | Receipt source | Also moves |
  | --- | --- |
  | Named supplier | Their bill moves: a `BILL_CORRECTION` row. |
  | `OPENING` / `OWNER` | The same reclass to 3901 / 3201, so nothing is owed to anyone. |
  | Older receipts (no terms) | Nothing: they stay owed with no name, as they were. |

- **Nothing reaches 5103 or 5102.**

**A manual adjustment has a reason from a fixed list,** each with its account:

| Reason | Account |
| --- | --- |
| `COUNT_DIFFERENCE` فرق جرد | 5103 فروقات المخزون |
| `DAMAGE` تالف | 5102 التالف |
| `SAMPLE` عينة تسويق | 5210 الدعاية والتسويق |
| `INTERNAL_USE` استهلاك داخلي | 5299 مصاريف متنوعة |
| `GIFT` هدية / إكرامية (who received it is required) | 5212 هدايا وإكراميات |

- **Rules on the reason:** only a count difference may add stock. «خطأ إدخال» is not a reason
  any more: the form sends that to the receipt correction.
- **Older adjustments** keep no reason code and stay in 5103.

**Past a limit, an adjustment waits for a second person** (`adjustment_requests`):

- **Waits:** any increase, and any take-away of more than 3 pieces or 50 $ at the average cost.
- **Applies at once:** smaller take-aways.
- **Before the decision:** a waiting request changes neither stock nor the books.
- **Who decides:** someone with the new permission `inventory.adjust.approve`, never the asker.
  The database checks it too: `decided_by <> requested_by`.
- **Approving** applies the adjustment against the stock of that moment. Refusing leaves
  everything as it was.

## Consequences

- `POST /inventory/adjustments` now answers `{ status: APPLIED | PENDING, requestId }`, and
  takes `{ reasonCode, note }` instead of `reason`.
- `inventory.adjust.approve` is held by the owner, the manager and the inventory manager (all of
  `inventory.*`).
- Gifts get their own movement, recipients and report with F-06. Until then, the `GIFT` reason
  at least puts them in 5212 with a name, not in damage.
- The report's data corrections (ب)–(د) can now be done with these tools, once the owner
  confirms the facts.

## Addendum (2026-10-24): a wrong cost (report F-07)

- **The change:** a correction line may carry `unitCost` instead of a new quantity: the right cost
  per piece, in the line's currency and at the receipt's rate.
- **How it posts:**
  - every piece of the line goes back as a `RECEIPT_CORRECTION` at the cost it carries, and in again
    at the right one;
  - the value difference moves the supplier's bill (`BILL_CORRECTION`) or the opening balances;
  - nothing reaches 5103, and the size's average becomes the right cost.
- **Refused:** once any piece of the line has been sold or moved, and for anyone without
  `inventory.adjust.approve`.
- **The line's cost from then on** is the last one that came in on it, so a later correction of the
  quantity uses the corrected cost.

