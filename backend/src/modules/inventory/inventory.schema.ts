import { z } from 'zod';
import { unitCostSchema } from '../../shared/money.js';

const quantity = z.number().int().min(1).max(1_000_000);
const reason = z.string().trim().min(3).max(500);
const note = z.string().trim().max(500).optional();

export const receiveStockSchema = z.object({
  variantId: z.uuid(),
  locationId: z.uuid(),
  quantity,
  unitCost: unitCostSchema,
  referenceType: z.enum(['MANUAL', 'GOODS_RECEIPT', 'PURCHASE_ORDER']).default('MANUAL'),
  referenceId: z.uuid().optional(),
  note,
});

export const issueStockSchema = z.object({
  variantId: z.uuid(),
  locationId: z.uuid(),
  quantity,
  referenceType: z.enum(['MANUAL', 'SALES_ORDER']).default('MANUAL'),
  referenceId: z.uuid().optional(),
  note,
});

export const transferStockSchema = z
  .object({
    variantId: z.uuid(),
    fromLocationId: z.uuid(),
    toLocationId: z.uuid(),
    quantity,
    note,
  })
  .refine((t) => t.fromLocationId !== t.toLocationId, {
    message: 'Source and destination must differ',
    path: ['toLocationId'],
  });

export const adjustStockSchema = z.object({
  variantId: z.uuid(),
  locationId: z.uuid(),
  delta: z
    .number()
    .int()
    .min(-1_000_000)
    .max(1_000_000)
    .refine((d) => d !== 0, 'Delta cannot be zero'),
  reason,
  // Optional cost for a positive adjustment; without it the stock enters at the current average.
  unitCost: unitCostSchema.optional(),
});

export const damageStockSchema = z.object({
  variantId: z.uuid(),
  locationId: z.uuid(),
  quantity,
  reason,
});

export const reserveStockSchema = z.object({
  variantId: z.uuid(),
  locationId: z.uuid(),
  quantity,
  orderId: z.uuid(),
  expiresAt: z.date().optional(),
});

export const releaseStockSchema = z.object({
  reservationId: z.uuid(),
});

export const balanceQuerySchema = z.object({
  variantId: z.uuid(),
  locationId: z.uuid(),
});

export const listBalancesSchema = z.object({
  locationId: z.uuid(),
  variantIds: z.array(z.uuid()).max(500).optional(),
  inStockOnly: z.boolean().default(false),
  limit: z.number().int().min(1).max(500).default(100),
});

export const movementsQuerySchema = z.object({
  variantId: z.uuid().optional(),
  locationId: z.uuid().optional(),
  beforeSeq: z.bigint().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type ReceiveStockInput = z.input<typeof receiveStockSchema>;
export type IssueStockInput = z.input<typeof issueStockSchema>;
export type TransferStockInput = z.input<typeof transferStockSchema>;
export type AdjustStockInput = z.input<typeof adjustStockSchema>;
export type DamageStockInput = z.input<typeof damageStockSchema>;
export type ReserveStockInput = z.input<typeof reserveStockSchema>;
export type ReleaseStockInput = z.input<typeof releaseStockSchema>;
export type BalanceQuery = z.input<typeof balanceQuerySchema>;
export type ListBalancesInput = z.input<typeof listBalancesSchema>;
export type MovementsQuery = z.input<typeof movementsQuerySchema>;
