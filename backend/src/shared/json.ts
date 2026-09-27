import type { Prisma } from '@prisma/client';

// JSON has no bigint, and money is bigint everywhere. Values stored in jsonb columns (audit
// before/after, idempotent responses) tag bigints so they round-trip exactly.
const BIGINT_TAG = '$bigint';
const DATE_TAG = '$date';

export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, function (this: Record<string, unknown>, key, v: unknown) {
      const raw = this[key];
      if (typeof raw === 'bigint') return { [BIGINT_TAG]: raw.toString() };
      if (raw instanceof Date) return { [DATE_TAG]: raw.toISOString() };
      // Prisma.Decimal and similar serialise through toJSON as strings, which is what we want.
      return v;
    }),
  ) as Prisma.InputJsonValue;
}

export function fromJson<T>(value: Prisma.JsonValue): T {
  return JSON.parse(JSON.stringify(value), (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj);
      if (keys.length === 1 && typeof obj[BIGINT_TAG] === 'string') return BigInt(obj[BIGINT_TAG]);
      if (keys.length === 1 && typeof obj[DATE_TAG] === 'string') return new Date(obj[DATE_TAG]);
    }
    return v;
  }) as T;
}
