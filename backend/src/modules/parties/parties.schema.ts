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

/**
 * Where received goods came from (developer report F-01), and so what the books owe for them:
 * a supplier (2101, named), cash (a box), goods already owned before the system (3901), or
 * the owner's own goods or production (3201).
 */
export const RECEIPT_SOURCES = ['SUPPLIER', 'CASH', 'OPENING', 'OWNER'] as const;
export type ReceiptSource = (typeof RECEIPT_SOURCES)[number];

/** Confirming a receipt: its source, from whom, and what was paid for it on the spot. */
export const receiptTermsSchema = z
  .object({
    source: z.enum(RECEIPT_SOURCES),
    partyId: z.uuid().optional(),
    /** The supplier's invoice number, kept on their statement. */
    invoiceNo: text(60).optional(),
    paid: z.object({ boxId: z.uuid(), amount: positive }).optional(),
  })
  .superRefine((t, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (t.source === 'SUPPLIER' && !t.partyId)
      issue('partyId', 'A purchase on credit names its supplier');
    if (t.source === 'CASH' && !t.paid) issue('paid', 'A cash purchase says which box paid');
    if ((t.source === 'OPENING' || t.source === 'OWNER') && (t.partyId || t.paid)) {
      issue('source', 'Opening stock and the owner’s goods have no supplier and no payment');
    }
  });

/** Confirming goods out to a wholesale customer: the agreed total, in their currency. */
export const goodsOutTermsSchema = z.object({
  partyId: z.uuid(),
  amount: positive,
  note: text(300).optional(),
});

/**
 * Closing what is owed with no name on it: paid from a box; or, with no box, the owner already
 * paid it (3201), or — for goods — it was stock owned before the system (3901).
 */
export const settleSchema = z.object({
  side: z.enum(['PAYABLE', 'RECEIVABLE']),
  boxId: z.uuid().optional(),
  as: z.enum(['OWNER', 'OPENING']).default('OWNER'),
  /** Box currency with a box; USD cents without. */
  amount: positive,
  note: text(300).optional(),
});
