// Creates a new migration from the difference between prisma/migrations and schema.prisma,
// without touching the main database. The Neon "test" branch is used as Prisma's shadow database
// (it is wiped by the test suite anyway). Review the SQL, append any raw constraints by hand,
// then apply with `pnpm db:migrate`.
//
// Usage: pnpm db:migration:new <snake_case_name>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.loadEnvFile(join(import.meta.dirname, '..', '.env'));

const name = process.argv[2];
if (!name || !/^[a-z0-9_]+$/.test(name)) {
  console.error('Usage: pnpm db:migration:new <snake_case_name>');
  process.exit(1);
}

const shadow = process.env.TEST_DATABASE_URL;
if (!shadow) {
  console.error('TEST_DATABASE_URL is not set — it is used as the shadow database.');
  process.exit(1);
}

const sql = execFileSync(
  'pnpm',
  [
    'exec',
    'prisma',
    'migrate',
    'diff',
    '--from-migrations',
    'prisma/migrations',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--shadow-database-url',
    shadow,
    '--script',
  ],
  { encoding: 'utf8', shell: process.platform === 'win32' },
);

const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const dir = join(import.meta.dirname, '..', 'prisma', 'migrations', `${stamp}_${name}`);
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'migration.sql'), sql);
console.log(`Created ${dir}\\migration.sql — review it before running pnpm db:migrate.`);
