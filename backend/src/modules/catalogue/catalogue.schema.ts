import { z } from 'zod';

const attribute = z.string().trim().min(1).max(60);
const attributeList = z
  .array(attribute)
  .min(1)
  .max(50)
  .transform((values) => [...new Set(values)]);

export const createProductSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{1,19}$/, 'Code: 2–20 characters, A–Z, 0–9 and dashes'),
  nameAr: z.string().trim().min(1).max(120),
  nameEn: z.string().trim().min(1).max(120).optional(),
  // Phase 1 counts every product in whole pieces. BOX / METER / KG exist in the schema so adding
  // them later is data, not a migration — but they are not accepted until an ADR defines them.
  unitOfMeasure: z.literal('PIECE').default('PIECE'),
});

export const generateVariantsSchema = z.object({
  productId: z.uuid(),
  fabrics: attributeList,
  colours: attributeList,
  sizes: attributeList,
});

export const registerExternalBarcodeSchema = z.object({
  variantId: z.uuid(),
  barcode: z.string().trim().min(4).max(64),
  kind: z.enum(['GTIN', 'SUPPLIER']),
});

export const searchVariantsSchema = z.object({
  q: z.string().trim().max(100).optional(),
  productId: z.uuid().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type CreateProductInput = z.input<typeof createProductSchema>;
export type GenerateVariantsInput = z.input<typeof generateVariantsSchema>;
export type RegisterExternalBarcodeInput = z.input<typeof registerExternalBarcodeSchema>;
export type SearchVariantsInput = z.input<typeof searchVariantsSchema>;
