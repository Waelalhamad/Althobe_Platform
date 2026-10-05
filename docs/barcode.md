# Barcode

Status: specification. No code exists yet. Decision recorded in
[ADR-003](decisions/003-barcode-strategy.md).

## Principle

A barcode is an **identifier and nothing else**. It points at a row. It never encodes price,
size, colour, location, supplier, or date. Encode business data in a barcode and every one of
those facts is frozen onto thousands of printed labels the moment it changes.

## Internal barcode format

Every `ProductVariant` has exactly one internal barcode: a valid **EAN-13** beginning with `2`.

```
2 00 000000001 5
| |  |         |
| |  |         +-- check digit (position 13, EAN-13 modulo 10)
| |  +------------ 9-digit sequence, zero padded
| +--------------- entity type: 00 variant, 01 carton, 02 stocktake tag
+----------------- prefix 2: restricted distribution / in-store use
```

The first twelve digits are the data; the thirteenth is the check digit.

```
data:     200000000001
check:    5
barcode:  2000000000015
```

Prefix `2` is the GS1 range reserved for in-store and restricted circulation, so an internal
barcode can never collide with a real manufacturer GTIN.

### Check digit

Standard EAN-13, over the twelve data digits, weights alternating 1 and 3 from the left:

```
sum   = d1*1 + d2*3 + d3*1 + ... + d11*1 + d12*3
check = (10 - (sum mod 10)) mod 10
```

Worked example for `200000000001`: `2*1 + 1*3 = 5`, so `check = 5`, giving `2000000000015`.

The check digit is validated on every scan **and** on every import. It catches a mistyped or
misread digit before it becomes a stock movement against the wrong variant.

## Allocation

- Sequence numbers come from a PostgreSQL sequence, never from `max(id) + 1` and never from
  application code.
- A barcode is assigned once, at variant creation, and is never changed or reused. Not even if
  the variant is deleted — a deleted variant keeps its number so that old labels in circulation
  can still be resolved to something.
- `product_variants.barcode` is `unique not null`.
- The full 13-digit string is stored, not the 12-digit data portion. Scanners emit 13 digits.

## External barcodes

Goods bought already carrying a manufacturer barcode keep it. Those live in a separate table so
one variant can have several:

```
variant_barcodes(id, variant_id, barcode, kind, is_primary, created_at)
kind: INTERNAL | GTIN | SUPPLIER
```

Lookup order on scan:

1. `product_variants.barcode` (internal, exact)
2. `variant_barcodes.barcode` (external, exact)
3. SKU, if the input matches the SKU pattern rather than a barcode pattern
4. Not found — the UI asks, and never guesses

## Symbologies

| Use | Symbology | Why |
| --- | --- | --- |
| Variant label on a garment | EAN-13 | Retail standard, every scanner reads it, fixed length, self-checking |
| Carton and pallet labels | Code 128 | Variable length, denser, carries a longer logistics id |
| Stocktake and shelf tags | Code 128 | Printed on demand, not retail-facing |

Where a 2D code is wanted later (a phone camera instead of a scanner gun), add QR alongside —
never in place of the EAN-13 label.

## Label specification

- Minimum print width 25 mm, magnification not below 80% of nominal EAN-13 size.
- Quiet zone preserved on both sides. This is the single most common cause of labels that will
  not scan.
- Human-readable digits printed under the bars, always. If the scan fails, someone types them.
- Label content: Arabic product name, the size large, the other options (cut, buttons, fabric,
  colour, …) on up to two small lines, SKU, barcode. Price is
  **not** part of the barcode; if it is printed on the label it is printed as text, from the
  current price list, at print time.
- **Printed from the browser** (`apps/warehouse` → طباعة الملصقات), so any printer driver works.
  Two formats today:
  - **Thermal label printer:** 50 × 30 mm, one label per page.
  - **A4 sticker sheets:** 3 × 8 = 24 labels of 70 × 37 mm, on an ordinary office printer — usable
    before a label printer is bought.
- ZPL templates for a specific thermal printer come later, once the printer is chosen.

## Scanner workflow

Warehouse scanners act as keyboard wedges: they type the digits and send `Enter`. Any USB or
Bluetooth scanner in **HID keyboard** mode works; no model-specific integration is built.

Scans feed a **scan session** — a draft that accumulates one line per variant and only touches the
ledger when committed. The full workflow (kinds, dedupe by `scanId`, commit, cancel) is in
[`inventory.md` → Barcode workflow](inventory.md#barcode-workflow--scan-sessions).

Rules for any scanning screen:

- Keep a single always-focused input; never make the user click into a field.
- Treat rapid keystrokes ending in `Enter` as a scan; debounce a few tens of milliseconds.
- Resolve the barcode, then show the variant with a distinct sound and colour for found,
  not-found, and wrong-item.
- Never block the next scan on a network round-trip finishing. Queue, then confirm.
- Every scan that results in a stock change carries an idempotency key, because a double
  trigger pull is a real and frequent event.
- Show the resulting quantity after every scan. Warehouse staff trust a number they can see.

## Forbidden

- Never encode price, size, colour, location, or date inside a barcode.
- Never reuse or reassign a barcode.
- Never generate barcodes in application code or in a spreadsheet.
- Never accept a barcode whose check digit fails.
- Never print a label whose data was not read from the database at print time.
