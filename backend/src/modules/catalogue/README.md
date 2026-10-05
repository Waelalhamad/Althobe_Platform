# Catalogue Module

## Responsibility

Products, the option types and values they are made from (القصة، الزر، … القياس — ADR-008), their
variants (one value per type), SKUs, and barcodes — internal EAN-13 codes allocated from
`variant_barcode_seq`, and external GTIN/supplier codes. Knows nothing about stock.

## Depends On

- nothing

## Used By

- inventory — `variantsByIds`, `lookupBarcode` (trusted, inside inventory's transaction)

## Important Rules

- A barcode is allocated once from the database sequence and never changed or reused.
- Barcode resolution order: internal → external → SKU. A misread is reported, never guessed.
- Only `PIECE` is accepted as a unit until an ADR defines fractional units.
- A variant has exactly one active value per option type of its product; `option_key` (sorted value
  ids) makes each combination unique per product, for life — retired variants are restored, not
  recreated.
- Option types and values are deactivated, never deleted. A type leaves a product only while no
  variant of it uses the type.

## Main Services

```
createProduct  updateProduct  generateVariants  setVariantActive  registerExternalBarcode
getVariant  searchVariants  listOptionGroups  createOptionGroup  updateOptionGroup
addOptionValue  updateOptionValue
```
