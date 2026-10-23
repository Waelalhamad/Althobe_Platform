import { z } from 'zod';

export const RECIPIENT_KINDS = [
  'SHIPPING',
  'CUSTOMER',
  'WHOLESALE',
  'INFLUENCER',
  'OFFICIAL',
  'EMPLOYEE',
  'OTHER',
] as const;
export type RecipientKind = (typeof RECIPIENT_KINDS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);

/** Who received it — chosen from the list, or a new name kept for next time — and why. */
export const confirmGiftSchema = z
  .object({
    recipientId: z.uuid().optional(),
    recipient: z
      .object({
        name: text(120),
        kind: z.enum(RECIPIENT_KINDS),
        phone: z.string().trim().max(40).optional(),
      })
      .optional(),
    occasion: text(300),
    reference: z.string().trim().max(120).optional(),
  })
  .refine((g) => (g.recipientId ? 1 : 0) + (g.recipient ? 1 : 0) === 1, {
    path: ['recipient'],
    message: 'Choose who received it, or name them',
  });

export const giftsQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  recipientId: z.uuid().optional(),
  kind: z.enum(RECIPIENT_KINDS).optional(),
  locationId: z.uuid().optional(),
});

/** The delivery receipt, shrunk by the browser like a product photo. */
export const giftPhotoSchema = z.object({
  image: z
    .string()
    .max(Math.ceil((3 * 1024 * 1024 * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Expected base64'),
});
