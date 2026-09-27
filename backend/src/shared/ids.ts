import { randomBytes } from 'node:crypto';

/**
 * UUID v7 (RFC 9562): 48-bit millisecond timestamp + random. Matches what Prisma generates for
 * `@default(uuid(7))`, for the few rows written with raw SQL (atomic upserts).
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  let ts = BigInt(Date.now());
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
