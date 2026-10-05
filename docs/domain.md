# Domain

Status: specification. No code exists yet.

The shared language of the project. Use exactly these words in code, database, API, and
conversation. If a word is not here, it does not exist yet — add it here first.

## Ubiquitous language

| English (code) | Arabic | Meaning |
| --- | --- | --- |
| Product | منتج | A thobe model or other item, e.g. "Classic Saudi Thobe". Not sellable by itself. |
| ProductVariant | صنف | The actual sellable, stockable unit: model + fabric + colour + size. Carries SKU and barcode. |
| Fabric | قماش | Material of a variant, e.g. cotton blend, wool blend. A variant attribute. |
| Size | مقاس | Size label of a variant, e.g. length 58 / chest 44. |
| Location | موقع | A physical place that holds stock. Has a `kind`: WAREHOUSE (مخزن) or STORE (متجر). Two warehouses and one store today. |
| Bin | رف | A shelf or slot **inside** a warehouse location. Not modelled yet; the word is reserved so it never collides with Location. |
| UnitOfMeasure | وحدة القياس | How a product is counted: PIECE today; BOX, METER, KG reserved. No conversions yet. |
| ScanSession | جلسة مسح | A draft batch built by scanning barcodes: each scan adds to a per-variant line; committing posts the movements. |
| InventoryBalance | رصيد المخزون | Current quantity of one variant at one location. Derived, fast to read. |
| InventoryMovement | حركة مخزون | One immutable record of stock changing. The ledger. |
| Reservation | حجز | Quantity committed to an order but not yet issued. |
| Stocktake | جرد | A counting session that compares counted quantity to system quantity. |
| Supplier | مورد | Who the business buys from. |
| PurchaseOrder | أمر شراء | An order placed on a supplier. |
| GoodsReceipt | إذن استلام | Physical arrival of purchased goods; creates stock. |
| Customer | زبون | Retail or wholesale buyer. |
| SalesOrder | طلب بيع | A customer order, wholesale or retail. |
| Delivery | تسليم | Goods leaving for a customer; removes stock. |
| Return | مرتجع | Goods coming back from a customer; restores stock if saleable. |
| Invoice | فاتورة | The financial document for a sale. |
| Payment | دفعة | Money received or paid. |
| CreditNote | إشعار دائن | Reversal of an invoice, in whole or in part. |
| PriceTier | فئة سعرية | A named wholesale price level assigned to customers. |
| Employee | موظف | Staff record, linked to a user account. |

Words to avoid because they are ambiguous: *item*, *stock item*, *piece*, *order* (unqualified),
*transfer* (unqualified — say stock transfer or money transfer).

## Product and variant

This is the modelling decision everything else rests on.

- A **Product** is the design: "Classic Saudi Thobe", "Emirati Kandura Cut".
- A **ProductVariant** is what actually exists on a shelf: that design, with one value of each
  of its option types — cut, buttons, zipper, sleeve, fabric, colour, size (ADR-008).
- Stock, barcodes, SKUs, prices, and costs attach to the **variant**, never to the product.

```
Product: ثوب
└── Variants
    ├── سعودية · ملكي · مدفون · سنارة · جوخ هندي · أبيض · 56
    ├── سعودية · ملكي · مدفون · سنارة · جوخ هندي · أبيض · 58
    └── خليجية · معدن · مدفون · فلت/كويتي · تويوبو صيني · بيج · 58
```

Option types are **data** (ADR-008): the owner adds values and whole types (e.g. a collar) on the
Options page, and chooses per product which types it is made with. No migration is needed.

## Core aggregates

| Aggregate | Root | Invariant it protects |
| --- | --- | --- |
| Catalogue | Product | A variant belongs to exactly one product; SKU and barcode are unique |
| Stock | InventoryBalance per (variant, location) | Balance equals the sum of its movements; quantity never negative; reserved never exceeds quantity |
| Purchase | PurchaseOrder | Received quantity never exceeds ordered quantity plus tolerance |
| Sale | SalesOrder | Delivered quantity never exceeds ordered; a delivered order cannot be silently edited |
| Billing | Invoice | An issued invoice is immutable; corrections are credit notes |

## Lifecycles

Entity states are explicit enums, never booleans stacked on booleans.

```
PurchaseOrder:  DRAFT -> SUBMITTED -> PARTIALLY_RECEIVED -> RECEIVED -> CLOSED
                                   \-> CANCELLED

SalesOrder:     DRAFT -> CONFIRMED -> RESERVED -> PARTIALLY_DELIVERED -> DELIVERED -> CLOSED
                                   \-> CANCELLED

Invoice:        DRAFT -> ISSUED -> PARTIALLY_PAID -> PAID
                               \-> CANCELLED (only via credit note)

Stocktake:      DRAFT -> COUNTING -> REVIEW -> APPLIED
                                  \-> CANCELLED
```

Rules:

- A state machine lives in the owning service. No other module writes a status field.
- Backwards transitions are not allowed except where written above.
- `CANCELLED` never deletes rows and never rewrites history.

## Retail vs wholesale

Both create a `SalesOrder`. They differ in:

| | Retail | Wholesale |
| --- | --- | --- |
| Price source | Retail price list | Customer price tier, then contract override |
| Payment | Immediate, at POS | Terms, credit limit, statement |
| Stock source | The STORE location | A WAREHOUSE location |
| Document | Receipt, invoice on request | Invoice always |
| Reservation | Not used — stock leaves immediately | Used from order confirmation |

They are separate modules over one shared `sales` core. Do not fork the stock logic for them.

## What is deliberately not modelled yet

- Manufacturing and tailoring work orders (custom-made thobes)
- Alterations and made-to-measure attributes
- Consignment stock
- Multi-company or multi-branch legal entities
- Loyalty programmes

If a task requires one of these, stop and ask. Do not invent a model for it.
