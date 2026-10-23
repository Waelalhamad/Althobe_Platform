import { z } from 'zod';
import { unitCostSchema } from '../../shared/money.js';
import { ADJUSTMENT_REASONS } from './inventory.types.js';

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

/**
 * A manual adjustment (developer report F-03): a reason from the fixed list, a note (required
 * for a gift: who got it). Only a count difference may add stock; the rest take it away.
 */
export const adjustStockSchema = z
  .object({
    variantId: z.uuid(),
    locationId: z.uuid(),
    delta: z
      .number()
      .int()
      .min(-1_000_000)
      .max(1_000_000)
      .refine((d) => d !== 0, 'Delta cannot be zero'),
    reasonCode: z.enum(ADJUSTMENT_REASONS),
    note,
    // Optional cost for a positive adjustment; without it the stock enters at the current average.
    unitCost: unitCostSchema.optional(),
  })
  .superRefine((a, ctx) => {
    if (a.delta > 0 && a.reasonCode !== 'COUNT_DIFFERENCE') {
      ctx.addIssue({
        code: 'custom',
        path: ['reasonCode'],
        message: 'Only a count difference adds stock',
      });
    }
    if (a.reasonCode === 'GIFT' && !a.note?.trim()) {
      ctx.addIssue({ code: 'custom', path: ['note'], message: 'A gift says who received it' });
    }
  });

export const decideAdjustmentSchema = z.object({ note: note });

/** «تراجع»: why the movement is undone, always. */
export const undoMovementSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/** Correcting a confirmed receipt (developer report F-02), line by line. */
export const correctReceiptSchema = z.object({
  changes: z
    .array(
      z.object({
        variantId: z.uuid(),
        /** The line's quantity as it should have been: 0 takes it all back. */
        quantity: z.number().int().min(0).max(1_000_000),
        /** Instead: move this much of it to another variant (a wrong size or design), same cost. */
        toVariantId: z.uuid().optional(),
      }),
    )
    .min(1)
    .max(200),
  reason: z.string().trim().min(3).max(500),
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
export type CorrectReceiptInput = z.input<typeof correctReceiptSchema>;
export type DamageStockInput = z.input<typeof damageStockSchema>;
export type ReserveStockInput = z.input<typeof reserveStockSchema>;
export type ReleaseStockInput = z.input<typeof releaseStockSchema>;
export type BalanceQuery = z.input<typeof balanceQuerySchema>;
export type ListBalancesInput = z.input<typeof listBalancesSchema>;
export type MovementsQuery = z.input<typeof movementsQuerySchema>;
