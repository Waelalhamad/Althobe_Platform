import { z } from 'zod';
import { CURRENCIES, minorAmountSchema } from '../../shared/money.js';

const positive = minorAmountSchema.refine((v) => v > 0n, 'Amount must be greater than zero');
const text = (max: number) => z.string().trim().max(max);

export const FREQUENCIES = ['MONTHLY', 'WEEKLY'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const createEmployeeSchema = z.object({
  nameAr: text(120).min(1),
  phone: text(40).optional(),
  jobTitle: text(80).optional(),
  branch: z.enum(['SY', 'LY']).default('SY'),
  currency: z.enum(CURRENCIES),
  salary: minorAmountSchema,
  frequency: z.enum(FREQUENCIES).default('MONTHLY'),
  notes: text(500).optional(),
});

export const updateEmployeeSchema = createEmployeeSchema
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const employeesQuerySchema = z.object({
  includeInactive: z.enum(['true', 'false']).optional(),
});

/** Handed out of a box, or paid back into one. */
export const advanceSchema = z.object({
  boxId: z.uuid(),
  amount: positive,
  note: text(300).optional(),
});

export const createRunSchema = z.discriminatedUnion('frequency', [
  z.object({
    frequency: z.literal('MONTHLY'),
    period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  }),
  /** The week's first day; it runs seven days. */
  z.object({ frequency: z.literal('WEEKLY'), weekStart: z.iso.date() }),
]);

export const updateLineSchema = z
  .object({
    salary: minorAmountSchema,
    bonus: minorAmountSchema,
    deduction: minorAmountSchema,
    deductionNote: text(200),
    advanceDeduct: minorAmountSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const payRunSchema = z.object({
  boxId: z.uuid(),
  /** Only these lines; default: everyone on the sheet still owed pay in the box's currency. */
  lineIds: z.array(z.uuid()).min(1).max(500).optional(),
});
