# ADR-019: Gifts and tips (الهدايا والإكراميات)

- Status: **Accepted**
- Date: 2026-10-23
- Builds on: ADR-013 (the ledger), ADR-017 (adjustment reasons), ADR-018 (undo)
- From: the developer report «أخطاء النظام المالية», item F-06

## Context

Gifts were written off as damage: two pieces to the Libya shipper went to 5102, with no record of
who got them. The `GIFT` adjustment reason (ADR-017) put them in 5212, but still with no
recipient list and no report.

## Decision

- **A gift is a scan session of its own kind**, `GIFT`, scanned like damage at any location. Its
  pieces leave as `GIFT` movements at the average cost. The ledger posts them to 5212 هدايا
  وإكراميات, never to damage.
- **Confirmed with who and why** (`POST /gifts/:sessionId`):
  - **Required:** the recipient, either from the list or a new name with its kind (شركة شحن، زبون،
    تاجر جملة، مؤثر / إعلان، جهة رسمية، موظف، غير ذلك), and the occasion.
  - **Optional:** a phone, a shipment or order number, and a delivery receipt photo.
  - **No plain commit:** the plain session commit refuses a gift (`GIFT_NEEDS_RECIPIENT`).
- **The recipient list** (`gift_recipients`): a name is kept once. The same name with other spaces
  or case is the same recipient.
- **Only the owner gives gifts** (owner, 2026-10-23), so there is no approval step. The permission
  is `admin.gifts`, and no other role has it. Those with `accounting.view` may read the report.
- **Mistakes** are undone with «تراجع» (ADR-018), at the same value. The report then shows the gift
  as undone.
- **The photo** is stored in the same private S3 bucket as product photos, under `gifts/`. It is
  shrunk by the browser and checked by its bytes.
- **The report** (`/gifts`):
  - **Each row:** one gift, with the recipient, occasion, pieces, value at cost, who recorded it,
    and the photo.
  - **Filters:** by date, recipient, kind and location.
  - **Totals:** per recipient and per month.
  - **Matches the books:** its total equals what the `GIFT` movements posted to 5212.
- **The `GIFT` adjustment reason** is refused for new adjustments. Older ones keep it, and stay in
  5212.

## Consequences

- New enum values: `movement_type.GIFT` and `scan_session_kind.GIFT`.
- New tables: `gift_recipients` and `gifts`, one row per confirmed gift session.
- Gifts entered before this (two pieces, moved to 5212 by a correcting entry on 2026-10-23) have no
  recipient. They are not in the report.
