// Development seed. Safe to run repeatedly.
//
// Creates: a system user and the three locations (placeholder names — see PROJECT_STATUS.md open
// items). The option types and their starting values come from the product_options migration.
// Creates NO products and NO stock: products are entered in the app, and stock only ever enters
// through a counted OPENING scan session.
import { join } from 'node:path';
import { createDb } from '../src/shared/db.js';

process.loadEnvFile(join(import.meta.dirname, '..', '.env'));

const db = createDb();

const LOCATIONS = [
  { code: 'WH1', nameAr: 'المخزن الرئيسي', nameEn: 'Main warehouse', kind: 'WAREHOUSE' },
  { code: 'WH2', nameAr: 'المخزن الثاني', nameEn: 'Second warehouse', kind: 'WAREHOUSE' },
  { code: 'STORE', nameAr: 'المتجر', nameEn: 'Retail store', kind: 'STORE' },
] as const;

async function main() {
  await db.user.upsert({
    where: { email: 'system@althobe.local' },
    update: {},
    create: { email: 'system@althobe.local', nameAr: 'النظام', nameEn: 'System' },
  });

  // Locations are configuration, not stock; upserting them directly is fine.
  for (const location of LOCATIONS) {
    await db.location.upsert({ where: { code: location.code }, update: {}, create: location });
  }

  const groups = await db.optionGroup.findMany({
    orderBy: { sortOrder: 'asc' },
    select: { nameAr: true, values: { select: { valueAr: true }, orderBy: { sortOrder: 'asc' } } },
  });
  console.log(`Locations: ${LOCATIONS.map((l) => l.code).join(', ')}`);
  for (const g of groups) {
    console.log(`  ${g.nameAr}: ${g.values.map((v) => v.valueAr).join('، ') || '—'}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
