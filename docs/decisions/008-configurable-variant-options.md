# ADR-008: Configurable variant options

- Status: **Accepted**
- Date: 2026-10-05
- Supersedes: the fixed fabric / colour / size axes in `docs/domain.md` ("adding an axis means a
  migration")

## Decision

A variant is defined by **one value per option type**, and both the types and their values are
**data the owner edits**, not columns:

| Table | Holds |
| --- | --- |
| `option_groups` | an option type: القصة، الزر، السحاب، الكم، القماش، اللون، القياس, or one added later |
| `option_values` | its values: سعودية، خليجية … — renamed, reordered, hidden; never deleted |
| `product_option_groups` | which types a product is made with |
| `variant_option_values` | the chosen value per type for each variant (composite FK keeps value and type consistent) |
| `product_variants.option_key` | the chosen value ids, sorted and joined; `unique(product_id, option_key)` |

Starting lists (owner, 2026-10-05): القصة سعودية، خليجية · الزر ملكي، معدن، بلاستيك · السحاب مدفون ·
الكم سنارة، فلت/كويتي · القماش جوخ هندي، تويوبو صيني · اللون and القياس filled in the app. They are
inserted by the `product_options` migration, so every database gets them.

## Context

The two products, ثوب and كلابية, are made with seven choices, not three, and the owner expects
to add values and whole types (e.g. a collar) without a developer. Pieces are **ready-made stock**:
each combination actually made is its own variant with its own barcode and balance.

## Rules

- A new variant needs exactly one **active** value for every type of its product. Only the
  combinations chosen are created (at most 500 per request), never every possibility.
- A combination keeps its barcode for life: generating it again finds it (even when retired)
  instead of creating a second one.
- Renaming a value changes every screen at once; labels already printed keep the old text.
- Types and values are deactivated, never deleted: hidden from new variants, existing ones intact.
- A type can be removed from a product only while no variant of it uses that type.
- Display order is the type order (then value order), edited on the Options page. The type with
  key `SIZE` is printed large on labels.
- Editing lists is `products.write` (owner, manager, inventory manager).

## Consequences

- The API returns a variant with `options` (type, value) and a `title` ("سعودية · ملكي · … · 56")
  instead of `fabric`, `colour`, `size`; `size` stays as a convenience field.
- The migration converted existing variants in place: their ids, barcodes and stock are unchanged.
- Prices per option (e.g. جوخ هندي costs more) are not modelled here; prices come next and attach
  to the variant (domain.md).
- Made-to-measure (tailoring) is still not modelled: these options describe finished stock.
