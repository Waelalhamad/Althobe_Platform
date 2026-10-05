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

const productCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Code: 2–20 characters, A–Z, 0–9 and dashes');

export const createProductSchema = z.object({
  /** Omitted: the next free P-0001, P-0002, … is generated. */
  code: productCode.optional(),
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120).optional(),
  // Phase 1 counts every product in whole pieces. BOX / METER / KG exist in the schema so adding
  // them later is data, not a migration — but they are not accepted until an ADR defines them.
  unitOfMeasure: z.literal('PIECE').default('PIECE'),
  /** The option types the product is made with. Default: every active type. */
  groupIds: z.array(z.uuid()).min(1).max(30).optional(),
});

export const updateProductSchema = z
  .object({
    /** Renaming the code changes the SKUs of variants created from now on, not existing ones. */
    code: productCode.optional(),
    nameAr: z.string().trim().min(1).max(120).optional(),
    nameEn: z.string().trim().min(1).max(120).nullable().optional(),
    isActive: z.boolean().optional(),
    groupIds: z.array(z.uuid()).min(1).max(30).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/** A price in minor units (string of digits); null removes it. Prices are in USD (ADR-009). */
const priceSchema = minorAmountSchema.nullable();

/** Every combination of the chosen values: one value per option type of the product. */
export const generateVariantsSchema = z.object({
  productId: z.uuid(),
  /** Prices for the variants this call creates (needs prices.write). */
  prices: z
    .object({ retail: minorAmountSchema.optional(), wholesale: minorAmountSchema.optional() })
    .optional(),
  selections: z
    .array(
      z.object({
        groupId: z.uuid(),
        valueIds: z
          .array(z.uuid())
          .min(1)
          .max(100)
          .transform((ids) => [...new Set(ids)]),
      }),
    )
    .min(1)
    .max(30),
});

export const createOptionGroupSchema = z.object({ nameAr: label });

export const updateOptionGroupSchema = z
  .object({ nameAr: label.optional(), isActive: z.boolean().optional(), move: move.optional() })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

/** Without a code, one is suggested from the Arabic name (كحلي → KHL). */
export const addOptionValueSchema = z.object({
  groupId: z.uuid(),
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

export const setVariantActiveSchema = z.object({ isActive: z.boolean() });

/** One variant or many (a filtered list): the same retail and/or wholesale price for all. */
export const setPricesSchema = z
  .object({
    variantIds: z
      .array(z.uuid())
      .min(1)
      .max(2000)
      .transform((ids) => [...new Set(ids)]),
    retail: priceSchema.optional(),
    wholesale: priceSchema.optional(),
  })
  .refine((v) => v.retail !== undefined || v.wholesale !== undefined, 'Nothing to change');

export const registerExternalBarcodeSchema = z.object({
  variantId: z.uuid(),
  barcode: z.string().trim().min(4).max(64),
  kind: z.enum(['GTIN', 'SUPPLIER']),
});

export const searchVariantsSchema = z.object({
  q: z.string().trim().max(100).optional(),
  productId: z.uuid().optional(),
  limit: z.number().int().min(1).max(2000).default(50),
});

export type CreateProductInput = z.input<typeof createProductSchema>;
export type UpdateProductInput = z.input<typeof updateProductSchema>;
export type GenerateVariantsInput = z.input<typeof generateVariantsSchema>;
export type CreateOptionGroupInput = z.input<typeof createOptionGroupSchema>;
export type UpdateOptionGroupInput = z.input<typeof updateOptionGroupSchema>;
export type AddOptionValueInput = z.input<typeof addOptionValueSchema>;
export type UpdateOptionValueInput = z.input<typeof updateOptionValueSchema>;
export type SetVariantActiveInput = z.input<typeof setVariantActiveSchema>;
export type SetPricesInput = z.input<typeof setPricesSchema>;
export type RegisterExternalBarcodeInput = z.input<typeof registerExternalBarcodeSchema>;
export type SearchVariantsInput = z.input<typeof searchVariantsSchema>;
