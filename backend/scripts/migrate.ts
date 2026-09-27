// pnpm db:migrate — applies pending migrations to DIRECT_URL over port 443. Never resets anything.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyMigrations } from './migrations.js';

const envFile = join(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const url = process.env.DIRECT_URL;
if (!url) {
  console.error('DIRECT_URL is not set — see .env.example.');
  process.exit(1);
}

applyMigrations(url).catch((error: unknown) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
