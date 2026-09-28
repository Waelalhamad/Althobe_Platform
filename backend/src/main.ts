// API entry point. `pnpm dev` (watch) or `node dist/main.js` (production).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer } from './http/server.js';
import { createServices } from './services.js';
import { createDb, pingDb } from './shared/db.js';

const envFile = join(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

// --practice: run against the separate practice database, so people can learn the scanner and
// printer without touching real stock (the ledger is append-only).
const practice = process.argv.includes('--practice');
if (practice) {
  if (!process.env.PRACTICE_DATABASE_URL) throw new Error('PRACTICE_DATABASE_URL is not set');
  process.env.DATABASE_URL = process.env.PRACTICE_DATABASE_URL;
  console.log('*** PRACTICE MODE: using the practice database, not real stock ***');
}

const production = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3000);

const db = createDb();
const app = await buildServer({
  services: createServices(db),
  staticDir: join(import.meta.dirname, '..', '..', 'apps', 'warehouse', 'dist'),
  secureCookies: production,
  practice,
  checkHealth: async () => pingDb(db),
  logger: true,
});

const shutdown = async () => {
  await app.close();
  await db.$disconnect();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port, host: production ? '0.0.0.0' : '127.0.0.1' });
