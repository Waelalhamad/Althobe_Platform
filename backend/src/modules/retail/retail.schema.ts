import { z } from 'zod';
import { minorAmountSchema } from '../../shared/money.js';
import { DRAWER_CURRENCIES } from './pos-money.js';

const id = z.uuid();
const drawer = z.enum(DRAWER_CURRENCIES);
/** One amount per drawer currency; a missing one is zero. */
const cashCount = z
  .object({
    SYP: minorAmountSchema.optional(),
    USD: minorAmountSchema.optional(),
    TRY: minorAmountSchema.optional(),
  })
  .default({});

export const openShiftSchema = z.object({ locationId: id, opening: cashCount });
export const closeShiftSchema = z.object({ counted: cashCount });

export const saleSchema = z.object({
  shiftId: id,
  lines: z
    .array(z.object({ variantId: id, quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(200),
  /** SYP minor units off the whole invoice; a manager only (retail.manage). */
  discount: minorAmountSchema.optional(),
  payments: z
    .array(
      z.object({
        currency: drawer,
        amount: minorAmountSchema.refine((v) => v > 0n, 'Amount must be greater than zero'),
      }),
    )
    .min(1)
    .max(3),
  note: z.string().trim().max(300).optional(),
});
export type SaleInput = z.input<typeof saleSchema>;

export const refundSchema = z.object({
  shiftId: id,
  lines: z
    .array(z.object({ lineNo: z.number().int().min(1), quantity: z.number().int().min(1) }))
    .min(1),
  reason: z.string().trim().min(1).max(300),
});
export type RefundInput = z.input<typeof refundSchema>;

export const salesQuerySchema = z.object({
  shiftId: id.optional(),
  /** "2026/7" or "7" (this year). */
  receipt: z
    .string()
    .regex(/^(\d{4}\/)?\d{1,7}$/)
    .optional(),
});

export const shiftsQuerySchema = z.object({ locationId: id });
