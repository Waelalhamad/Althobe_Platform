import { z } from 'zod';
import { minorAmountSchema } from '../../shared/money.js';
import { CODE_PATTERN } from './sku.js';

/** Trimmed, inner whitespace collapsed: "جوخ  هندي " and "جوخ هندي" are one value. */
const label = z
  .string()
  .transform((s) => s.trim().replace(/\s+/g, ' '))
  .pipe(z.string().min(1).max(60));

const move = z.enum(['up', 'down']);

/** A value's short code for SKUs: 1–6 of A–Z and 0–9 (سعودية → SA). */
const valueCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(CODE_PATTERN, 'Code: 1–6 characters, A–Z and 0–9');

/** A category's code, the start of its SKUs (THB). */
const categoryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{0,19}$/, 'Code: 1–20 characters, A–Z, 0–9 and dashes');

const ids = (max: number) =>
  z
    .array(z.uuid())
    .min(1)
    .max(max)
    .transform((list) => [...new Set(list)]);

// ─── Categories (ADR-011) ────────────────────────────────────────────────────────────────────

export const createCategorySchema = z.object({
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120).optional(),
  /** Omitted: suggested from the name and made unique. */
  code: categoryCode.optional(),
  /** Inside this category (up to three levels). */
  parentId: z.uuid().optional(),
  /** The option types its products use. Default: the parent's, or every active type. */
  groupIds: z.array(z.uuid()).min(1).max(30).optional(),
  // Every product counts in whole pieces until an ADR defines other units.
  unitOfMeasure: z.literal('PIECE').default('PIECE'),
});

export const updateCategorySchema = z
  .object({
    nameAr: z.string().trim().min(1).max(120).optional(),
    nameEn: z.string().trim().min(1).max(120).nullable().optional(),
    /** Changes the SKUs of products created from now on, not existing ones. */
    code: categoryCode.optional(),
    /** null moves it to the top level. */
    parentId: z.uuid().nullable().optional(),
    groupIds: z.array(z.uuid()).min(1).max(30).optional(),
    isActive: z.boolean().optional(),
    move: move.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

// ─── Products and their sizes ────────────────────────────────────────────────────────────────

/**
 * Every combination of the chosen values: one product per design (the non-size values) and one
 * variant per size. One list of values per option type of the category.
 */
export const generateProductsSchema = z.object({
  categoryId: z.uuid(),
  /** Prices for the products this call creates (needs prices.write). */
  prices: z
    .object({ retail: minorAmountSchema.optional(), wholesale: minorAmountSchema.optional() })
    .optional(),
  selections: z
    .array(z.object({ groupId: z.uuid(), valueIds: ids(100) }))
    .min(1)
    .max(30),
});

export const listProductsSchema = z.object({ categoryId: z.uuid().optional() });

export const setActiveSchema = z.object({ isActive: z.boolean() });

/** A price in minor units (string of digits); null removes it. Prices are in USD (ADR-009). */
const priceSchema = minorAmountSchema.nullable();

/** The same retail and/or wholesale price for one product or many (all their sizes). */
export const setProductPricesSchema = z
  .object({
    productIds: ids(2000),
    retail: priceSchema.optional(),
    wholesale: priceSchema.optional(),
  })
  .refine((v) => v.retail !== undefined || v.wholesale !== undefined, 'Nothing to change');

/** A size's own price, overriding its product's; null goes back to the product's price. */
export const setPricesSchema = z
  .object({
    variantIds: ids(2000),
    retail: priceSchema.optional(),
    wholesale: priceSchema.optional(),
  })
  .refine((v) => v.retail !== undefined || v.wholesale !== undefined, 'Nothing to change');

// ─── Option types and values (ADR-008) ───────────────────────────────────────────────────────

export const createOptionGroupSchema = z.object({ nameAr: label });

export const updateOptionGroupSchema = z
  .object({ nameAr: label.optional(), isActive: z.boolean().optional(), move: move.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/** Without a code, one is suggested from the Arabic name (كحلي → KHL). */
export const addOptionValueSchema = z.object({
  groupId: z.uuid(),
  /** Add it as a detail of this value (جوخ هندي → مشخط). */
  parentId: z.uuid().optional(),
  valueAr: label,
  code: valueCode.optional(),
});

export const updateOptionValueSchema = z
  .object({
    valueAr: label.optional(),
    code: valueCode.optional(),
    isActive: z.boolean().optional(),
    move: move.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

// ─── Barcodes and search ─────────────────────────────────────────────────────────────────────

export const registerExternalBarcodeSchema = z.object({
  variantId: z.uuid(),
  barcode: z.string().trim().min(4).max(64),
  kind: z.enum(['GTIN', 'SUPPLIER']),
});

export const searchVariantsSchema = z.object({
  q: z.string().trim().max(100).optional(),
  productId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  limit: z.number().int().min(1).max(2000).default(50),
});

export type CreateCategoryInput = z.input<typeof createCategorySchema>;
export type UpdateCategoryInput = z.input<typeof updateCategorySchema>;
export type GenerateProductsInput = z.input<typeof generateProductsSchema>;
export type ListProductsInput = z.input<typeof listProductsSchema>;
export type SetActiveInput = z.input<typeof setActiveSchema>;
export type SetProductPricesInput = z.input<typeof setProductPricesSchema>;
export type SetPricesInput = z.input<typeof setPricesSchema>;
export type CreateOptionGroupInput = z.input<typeof createOptionGroupSchema>;
export type UpdateOptionGroupInput = z.input<typeof updateOptionGroupSchema>;
export type AddOptionValueInput = z.input<typeof addOptionValueSchema>;
export type UpdateOptionValueInput = z.input<typeof updateOptionValueSchema>;
export type RegisterExternalBarcodeInput = z.input<typeof registerExternalBarcodeSchema>;
export type SearchVariantsInput = z.input<typeof searchVariantsSchema>;
