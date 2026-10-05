# ADR-011: Category → product → size

- Status: **Accepted**
- Date: 2026-10-11
- Changes: ADR-008 (what a "product" is), ADR-009 (where the price lives), ADR-010 (photo tags)

## Decision

Three levels, each editable:

| Level | Example | Holds |
| --- | --- | --- |
| **Category** | ثوب، طقم; sub-categories up to three levels (ثوب → صيفي) | name, code (THB), the option types its products use |
| **Product** | ثوب · سعودية · ملكي · مدفون · سنارة · جوخ هندي مشخط · أبيض | one value of each type **except the size**; code = SKU base `THB-SA-RY-MD-SN-JHST-WH`; photos; retail + wholesale price |
| **Variant** | that product in size 56 | barcode, SKU `…-WH-56`, stock, optional own price |

| Table | Holds |
| --- | --- |
| `categories` | the old `products` table, plus `parent_id` and `sort_order` |
| `category_option_groups` | the types a category's products use (was `product_option_groups`) |
| `products` | `category_id`, `code`, `style_key` (sorted non-size value ids; unique per category) |
| `product_style_values` | one value per non-size type per product (composite FK keeps value and type consistent) |
| `product_variants` | unchanged ids, barcodes and SKUs; `option_key` is now the size value id (`''` without sizes) |
| `variant_option_values` | the size only |
| `product_prices` | retail / wholesale per product; `variant_prices` stays as a per-size override |
| `product_photos` | per product (design); the tag table is dropped — a design's photos show that design |

## Rules

- **Generating** in a category takes one list of values per type: every design × every size is
  created once; existing ones are skipped and deleted ones are restored with their barcode.
- A variant's effective price is its own, else its product's.
- **Deleting** (category, product, size) is a soft delete and only for what never moved stock; a
  category with sub-categories cannot be deleted. Anything that had stock is stopped instead.
- A stopped category or product stops all its sizes (`VARIANT_INACTIVE` on receive and sale).
- Category codes are suggested from the name and editable; a renamed code changes new SKUs only.
- Option types leave a category only while none of its products or sizes uses them.

## Why

The owner: «الثوب تصنيف وليس منتج» — each design is its own product, with its sizes inside it,
as clothing shops and websites show them. Sizes share the design's photos and price.

## Migration

`20261011000000_categories_and_products` renames `products` to `categories`, groups existing
variants into products by their non-size values, moves those values to `product_style_values`,
and repoints photos (none were in use). No stock existed on the real database at the time.
