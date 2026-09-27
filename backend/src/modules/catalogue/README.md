# Catalogue Module

## Responsibility

Products, their variants (fabric × colour × size), SKUs, and barcodes — internal EAN-13 codes
allocated from `variant_barcode_seq`, and external GTIN/supplier codes. Knows nothing about stock.

## Depends On

- nothing

## Used By

- inventory — `variantsByIds`, `lookupBarcode` (trusted, inside inventory's transaction)

## Important Rules

- A barcode is allocated once from the database sequence and never changed or reused.
- Barcode resolution order: internal → external → SKU. A misread is reported, never guessed.
- Only `PIECE` is accepted as a unit until an ADR defines fractional units.

## Main Services

```
createProduct  generateVariants  registerExternalBarcode  getVariant  searchVariants
```
