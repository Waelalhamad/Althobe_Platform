import { z } from 'zod';
import { currencySchema, minorAmountSchema, rateSchema } from '../../shared/money.js';
import { BRANCHES, VOUCHER_TYPES } from './accounting.types.js';

const id = z.uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const memo = z.string().trim().max(500);
const positive = minorAmountSchema.refine((v) => v > 0n, 'Amount must be greater than zero');
const branch = z.enum(BRANCHES);

// سند قبض / سند صرف: money into or out of one cash box, against one other account.
const receiptOrPayment = z.object({
  kind: z.enum(['RECEIPT', 'PAYMENT']),
  date: date.optional(),
  boxId: id,
  counterAccountId: id,
  /** Minor units of the box's currency. */
  amount: positive,
  /** For SYP and LYD; defaults to the owner's rate. */
  rate: rateSchema.optional(),
  memo: memo.min(1),
});

// From one box to another in the same currency.
const transfer = z.object({
  kind: z.literal('TRANSFER'),
  date: date.optional(),
  fromBoxId: id,
  toBoxId: id,
  amount: positive,
  rate: rateSchema.optional(),
  memo: memo.optional(),
});

// صرافة: one currency out of a box, another into a box, at the deal's own rate.
const exchange = z.object({
  kind: z.literal('EXCHANGE'),
  date: date.optional(),
  fromBoxId: id,
  fromAmount: positive,
  toBoxId: id,
  toAmount: positive,
  /** Only when neither side is USD: the rate valuing the outgoing currency. */
  rate: rateSchema.optional(),
  memo: memo.optional(),
});

// قيد يومية: free lines, in USD, for the accountant.
const journal = z.object({
  kind: z.literal('JOURNAL'),
  date: date.optional(),
  memo: memo.min(1),
  lines: z
    .array(
      z
        .object({
          accountId: id,
          debit: minorAmountSchema.optional(),
          credit: minorAmountSchema.optional(),
          memo: memo.optional(),
        })
        .refine(
          (l) => (l.debit ?? 0n) > 0n !== (l.credit ?? 0n) > 0n,
          'Each line is either a debit or a credit',
        ),
    )
    .min(2)
    .max(50),
  branch: branch.optional(),
});

export const voucherSchema = z.discriminatedUnion('kind', [
  receiptOrPayment,
  transfer,
  exchange,
  journal,
]);
export type VoucherInput = z.input<typeof voucherSchema>;
export type Voucher = z.output<typeof voucherSchema>;

export const reverseSchema = z.object({
  date: date.optional(),
  memo: memo.optional(),
});

export const createAccountSchema = z.object({
  parentId: id,
  nameAr: z.string().trim().min(1).max(120),
  /** A cash box holds one currency. */
  kind: z.enum(['GENERAL', 'CASH']).default('GENERAL'),
  currency: currencySchema.optional(),
  branch: branch.nullable().optional(),
});

export const updateAccountSchema = z
  .object({
    nameAr: z.string().trim().min(1).max(120).optional(),
    isActive: z.boolean().optional(),
    branch: branch.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const rangeSchema = z.object({
  from: date.optional(),
  to: date.optional(),
  branch: branch.optional(),
});

export const entriesQuerySchema = rangeSchema.extend({
  voucherType: z.enum(VOUCHER_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const asOfSchema = z.object({ asOf: date.optional(), branch: branch.optional() });

export const closeSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM'),
});
