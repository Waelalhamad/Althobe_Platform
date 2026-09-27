// Development seed. Safe to run repeatedly.
//
// Creates: a system user, the three locations (placeholder names — see PROJECT_STATUS.md open
// items), and one sample product with a small variant matrix.
// Creates NO stock. Stock only ever enters through a counted OPENING scan session.
import { join } from 'node:path';
import { createDb } from '../src/shared/db.js';
import { ALL_PERMISSIONS } from '../src/shared/permissions.js';
import { createServices } from '../src/services.js';

process.loadEnvFile(join(import.meta.dirname, '..', '.env'));

const db = createDb();
const services = createServices(db);

const LOCATIONS = [
  { code: 'WH1', nameAr: 'المخزن الرئيسي', nameEn: 'Main warehouse', kind: 'WAREHOUSE' },
  { code: 'WH2', nameAr: 'المخزن الثاني', nameEn: 'Second warehouse', kind: 'WAREHOUSE' },
  { code: 'STORE', nameAr: 'المتجر', nameEn: 'Retail store', kind: 'STORE' },
] as const;

async function main() {
  const system = await db.user.upsert({
    where: { email: 'system@althobe.local' },
    update: {},
    create: { email: 'system@althobe.local', nameAr: 'النظام', nameEn: 'System' },
  });
  const ctx = { userId: system.id, permissions: new Set(ALL_PERMISSIONS) };

  // Locations are configuration, not stock; upserting them directly is fine.
  for (const location of LOCATIONS) {
    await db.location.upsert({ where: { code: location.code }, update: {}, create: location });
  }

  const existing = await db.product.findUnique({ where: { code: 'THB-CLASSIC' } });
  const product =
    existing ??
    (await services.catalogue.createProduct(
      { code: 'THB-CLASSIC', nameAr: 'ثوب عربي كلاسيك', nameEn: 'Classic Arabic Thobe' },
      ctx,
    ));

  const { created, existing: kept } = await services.catalogue.generateVariants(
    {
      productId: product.id,
      fabrics: ['قطني'],
      colours: ['أبيض', 'أسود'],
      sizes: ['54', '56', '58'],
    },
    ctx,
  );

  console.log(`Locations: ${LOCATIONS.map((l) => l.code).join(', ')}`);
  console.log(
    `Product ${product.code}: ${created.length} variants created, ${kept.length} already existed`,
  );
  for (const v of [...kept, ...created]) {
    console.log(`  ${v.barcode}  ${v.sku}  ${v.fabric} / ${v.colour} / ${v.size}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => db.$disconnect());
