import type { Tx } from './db.js';
import { toJson } from './json.js';

export interface AuditEntry {
  actorId: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Always called with the caller's transaction: the audit row commits or rolls back with the change. */
export async function writeAudit(tx: Tx, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorId: entry.actorId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      ...(entry.before === undefined ? {} : { before: toJson(entry.before) }),
      ...(entry.after === undefined ? {} : { after: toJson(entry.after) }),
    },
  });
}
