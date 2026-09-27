import { createHash } from 'node:crypto';
import type { Tx } from './db.js';
import { IdempotencyKeyReusedError } from './errors.js';
import { fromJson, toJson } from './json.js';

const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Runs `fn` at most once per (key, operation).
 *
 * The key is claimed *inside the caller's transaction* with INSERT … ON CONFLICT DO NOTHING:
 * - a concurrent duplicate blocks on the unique index until the first commits, then finds the
 *   claim and returns the stored result instead of acting twice;
 * - if the first transaction rolls back (a business rule said no), the claim disappears with it,
 *   so a retry runs again rather than replaying a failure.
 */
export async function withIdempotency<T>(
  tx: Tx,
  args: { key: string; operation: string; request: unknown },
  fn: () => Promise<T>,
): Promise<T> {
  const requestHash = hashRequest(args.request);

  const claimed = await tx.idempotencyRecord.createMany({
    data: [
      {
        key: args.key,
        operation: args.operation,
        requestHash,
        response: {},
        expiresAt: new Date(Date.now() + TTL_MS),
      },
    ],
    skipDuplicates: true,
  });

  if (claimed.count === 0) {
    const existing = await tx.idempotencyRecord.findUniqueOrThrow({
      where: { key_operation: { key: args.key, operation: args.operation } },
    });
    if (existing.requestHash !== requestHash) {
      throw new IdempotencyKeyReusedError(args.key, args.operation);
    }
    return fromJson<T>(existing.response);
  }

  const result = await fn();
  await tx.idempotencyRecord.update({
    where: { key_operation: { key: args.key, operation: args.operation } },
    data: { response: toJson(result) },
  });
  return result;
}

function hashRequest(request: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(toJson(request)))
    .digest('hex');
}
