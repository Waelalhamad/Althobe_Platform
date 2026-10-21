import { z } from 'zod';
import { CURRENCIES, minorAmountSchema } from '../../shared/money.js';

const positive = minorAmountSchema.refine((v) => v > 0n, 'Amount must be greater than zero');
const text = (max: number) => z.string().trim().max(max);

export const PARTY_KINDS = ['SUPPLIER', 'CUSTOMER'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

export const createPartySchema = z.object({
  kind: z.enum(PARTY_KINDS),
  nameAr: text(120).min(1),
  phone: text(40).optional(),
  currency: z.enum(CURRENCIES),
  branch: z.enum(['SY', 'LY']).default('SY'),
  notes: text(500).optional(),
});

export const updatePartySchema = createPartySchema
  .omit({ kind: true })
  .extend({ isActive: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export const partiesQuerySchema = z.object({
  kind: z.enum(PARTY_KINDS).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

/** Money out of a box to a supplier, or into a box from a customer; any box currency. */
export const partyCashSchema = z.object({
  boxId: z.uuid(),
  amount: positive,
  note: text(300).optional(),
});

/** Confirming a receipt: from whom, and what was paid for it on the spot. */
export const receiptTermsSchema = z.object({
  partyId: z.uuid().optional(),
  paid: z.object({ boxId: z.uuid(), amount: positive }).optional(),
});

/** Confirming goods out to a wholesale customer: the agreed total, in their currency. */
export const goodsOutTermsSchema = z.object({
  partyId: z.uuid(),
  amount: positive,
  note: text(300).optional(),
});

/** Closing what is owed with no name on it: from a box, or the owner already paid it. */
export const settleSchema = z.object({
  side: z.enum(['PAYABLE', 'RECEIVABLE']),
  boxId: z.uuid().optional(),
  /** Box currency with a box; USD cents without. */
  amount: positive,
  note: text(300).optional(),
});
