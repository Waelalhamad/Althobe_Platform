import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { neonConfig, Pool } from '@neondatabase/serverless';
import { withoutPrismaParams } from '../src/shared/db.js';

// Applies prisma/migrations over Neon's WebSocket driver (port 443), because the development
// network blocks Postgres's port 5432 (ADR-006). It records each migration in Prisma's own
// `_prisma_migrations` table with Prisma's checksum (SHA-256 of migration.sql), so
// `prisma migrate deploy` sees them as applied wherever 5432 is reachable, and vice versa.

neonConfig.webSocketConstructor = WebSocket;

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'prisma', 'migrations');
const LOCK_KEY = 72_707_369; // any constant; serialises concurrent runners

export async function applyMigrations(url: string, log: (line: string) => void = console.log) {
  const pool = new Pool({ connectionString: withoutPrismaParams(url) });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
        "id"                  VARCHAR(36)  PRIMARY KEY NOT NULL,
        "checksum"            VARCHAR(64)  NOT NULL,
        "finished_at"         TIMESTAMPTZ,
        "migration_name"      VARCHAR(255) NOT NULL,
        "logs"                TEXT,
        "rolled_back_at"      TIMESTAMPTZ,
        "started_at"          TIMESTAMPTZ  NOT NULL DEFAULT now(),
        "applied_steps_count" INTEGER      NOT NULL DEFAULT 0
      )`);

    const { rows } = await client.query<{
      migration_name: string;
      checksum: string;
      finished_at: Date | null;
    }>(
      `SELECT migration_name, checksum, finished_at FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`,
    );
    const failed = rows.filter((r) => r.finished_at === null);
    if (failed.length) {
      throw new Error(
        `Failed migrations need attention first: ${failed.map((r) => r.migration_name).join(', ')}`,
      );
    }
    const applied = new Map(rows.map((r) => [r.migration_name, r.checksum]));

    const names = readdirSync(MIGRATIONS_DIR)
      .filter((name) => statSync(join(MIGRATIONS_DIR, name)).isDirectory())
      .sort();

    let count = 0;
    for (const name of names) {
      const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'));
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = applied.get(name);
      if (existing !== undefined) {
        if (existing !== checksum) {
          throw new Error(
            `Migration ${name} was edited after it was applied. Write a new migration instead.`,
          );
        }
        continue;
      }

      // One transaction per migration: it applies completely or not at all.
      await client.query('BEGIN');
      try {
        await client.query(sql.toString('utf8'));
        await client.query(
          `INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
           VALUES ($1, $2, now(), $3, now(), 1)`,
          [randomUUID(), checksum, name],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(
          `Migration ${name} failed and was rolled back: ${(error as Error).message}`,
        );
      }
      log(`applied ${name}`);
      count++;
    }
    log(count ? `${count} migration(s) applied.` : 'Database is up to date.');
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}
