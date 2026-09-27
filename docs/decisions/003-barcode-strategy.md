# ADR-003: Internal barcode strategy

- Status: **Accepted**
- Date: 2026-09-21

## Decision

Every `ProductVariant` gets one internal barcode: a valid **EAN-13** starting with prefix `2`,
allocated from a database sequence, carrying a standard EAN-13 check digit, and encoding
**nothing but an identifier**.

```
2 00 000000001 5
| |  |         +-- EAN-13 check digit
| |  +------------ 9-digit sequence from a Postgres sequence
| +--------------- entity type: 00 variant, 01 carton, 02 stocktake tag
+----------------- GS1 restricted-distribution prefix
```

Manufacturer barcodes on purchased goods are kept alongside, in a separate `variant_barcodes`
table. Code 128 is used for carton, pallet, and shelf labels.

## Context

The business prints its own labels for goods it stocks, and also buys goods that already carry
a manufacturer barcode. The scheme has to survive: a variant whose price changes, a colour
renamed, a supplier swapped, and a label printed two years ago still sitting on a garment in
the back of the store.

Three questions had to be settled.

**1. Should the barcode encode business data?**

No. A barcode that encodes price, size, or warehouse freezes those facts onto every printed
label. When the price changes — and in this market it changes often — every label becomes a
lie, and the physical world does not accept a migration. The barcode identifies a row; the row
holds the truth, read at the moment it is needed.

**2. Which symbology?**

EAN-13 for the variant label. It is fixed-length, self-checking, universally readable by cheap
retail scanners, and it is what a shop scanner expects to see. Code 128 is kept for logistics
labels, where a longer, variable-length identifier is genuinely needed.

**3. Plain numeric, or a real GTIN structure?**

The original proposal was a plain 12-digit numeric value such as `200000000001`. It works, but
it has two avoidable weaknesses: no check digit, so a single misread digit can resolve to a
different, valid-looking variant and post a stock movement against the wrong item; and it can
collide with a real UPC-A when scanned by third-party equipment.

Adding the EAN-13 check digit fixes both while **keeping the original number as the data
portion**: `200000000001` becomes `2000000000015`. Prefix `2` is the GS1 range reserved for
in-store and restricted circulation, so an internal code can never collide with a manufacturer
GTIN.

## Consequences

Benefits:

- a misread or mistyped digit is rejected instead of silently hitting the wrong variant
- standard retail scanners and label printers work with no configuration
- no collision with real manufacturer barcodes, ever
- room for other label kinds (cartons, stocktake tags) in the same scheme
- price and attribute changes never invalidate printed labels

Trade-offs:

- the check digit must be computed and verified in code, in one shared utility, with tests
- 13 digits is slightly longer than 12 on a small label
- GS1 prefix `2` is for internal use only; these codes are not valid for selling through a
  third-party retailer or an international marketplace. If that ever becomes a requirement,
  real GTINs must be purchased from GS1, and they would live in `variant_barcodes` as `GTIN`
  alongside the internal code, not replace it.

## Rules that follow

- Barcodes are allocated from a Postgres sequence, never in application code.
- A barcode is never reused, never reassigned, and never changed.
- The check digit is validated on every scan and every import.
- Price is never encoded in a barcode. If it appears on a label, it is printed as text, read
  from the price list at print time.

## Revisit if

The business starts selling through a channel that requires genuine GTINs, or adopts
weight-embedded or serialized (GS1-128 / serial number) labelling for individual garments.
