import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';
import { applyMigrations } from '../scripts/migrations.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const backendDir = join(import.meta.dirname, '..');

/**
 * Integration tests run on the Neon "test" branch and wipe it between tests (ADR-006).
 * This refuses to start unless that branch is clearly not the main database.
 */
export default async function setup(project: TestProject) {
  const envFile = join(backendDir, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);

  const url = process.env.TEST_DATABASE_URL;
  if (!url || url.includes('USER:PASSWORD')) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Integration tests need the direct URL of a Neon branch named ' +
        '"test" — see .env.example. (Unit tests alone: pnpm test:unit)',
    );
  }

  // Same endpoint is fine only if it is a different database; same endpoint + same database is
  // the real data.
  const target = databaseOf(url);
  for (const name of ['DATABASE_URL', 'DIRECT_URL'] as const) {
    const other = process.env[name];
    if (other && databaseOf(other) === target) {
      throw new Error(
        `Refusing to run: TEST_DATABASE_URL points at the same database as ${name}. ` +
          'The test suite deletes all data. Use a separate test database or Neon branch.',
      );
    }
  }

  await applyMigrations(url, (line) => console.log(`[test db] ${line}`));

  project.provide('databaseUrl', url);
}

/** Endpoint (with "-pooler" removed, so pooled and direct compare equal) plus database name. */
function databaseOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname.replace('-pooler', '')}${parsed.pathname}`;
}
