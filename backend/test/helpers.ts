import { randomUUID } from 'node:crypto';
import { inject } from 'vitest';
import { createDb, type Db } from '../src/shared/db.js';
import { createMemoryStorage } from '../src/shared/storage.js';
import { suggestCode } from '../src/modules/catalogue/sku.js';
import type { UnitCostInput } from '../src/shared/money.js';
import {
  ALL_PERMISSIONS,
  type ActorContext,
  type BranchCode,
  type Permission,
  type WriteContext,
} from '../src/shared/permissions.js';
import type { CategoryView, VariantView } from '../src/modules/catalogue/catalogue.service.js';
import type { LocationView } from '../src/modules/locations/locations.service.js';
import { createServices, type Services } from '../src/services.js';

export interface World {
  /** Holds every permission. Creates stocktakes. */
  owner: ActorContext;
  /** A second person with every permission — the stocktake approver. */
  approver: ActorContext;
  wh1: LocationView;
  wh2: LocationView;
  store: LocationView;
  /** The Libya warehouse (F-04). */
  ly: LocationView;
  /** Option types القماش / اللون / القياس with a few values each. */
  options: { fabric: OptionType; colour: OptionType; size: OptionType };
  /** Category ثوب تجريبي (THB-TEST), made of القماش, اللون, القياس. */
  category: CategoryView;
  /** The sizes 54 / 56 / 58 of one product (قطني · أبيض): X, Y, Z. */
  x: VariantView;
  y: VariantView;
  z: VariantView;
}

export interface TestContext {
  db: Db;
  services: Services;
  /** Photo storage in memory, in place of S3. */
  storage: ReturnType<typeof createMemoryStorage>;
  url: string;
  /** Wipes the test database and builds a fresh world. Call in beforeEach. */
  reset(): Promise<World>;
  close(): Promise<void>;
}

export function createTestContext(): TestContext {
  const url = inject('databaseUrl');
  const db = createDb(url);
  const storage = createMemoryStorage();
  const services = createServices(db, { storage });

  return {
    db,
    services,
    storage,
    url,
    async reset() {
      await wipe(db);
      storage.objects.clear();
      return buildWorld(db, services);
    },
    close: async () => db.$disconnect(),
  };
}

/** A write context with a fresh idempotency key, unless one is given. */
export function write(actor: ActorContext, idempotencyKey: string = randomUUID()): WriteContext {
  return { ...actor, idempotencyKey };
}

export function actorWith(actor: ActorContext, permissions: Permission[]): ActorContext {
  return { userId: actor.userId, permissions: new Set(permissions) };
}

export function withoutPermission(actor: ActorContext, permission: Permission): ActorContext {
  return {
    userId: actor.userId,
    permissions: new Set([...actor.permissions].filter((p) => p !== permission)),
  };
}

/** USD (the base currency, ADR-012) in cents. USD(10) is 10.00 USD. */
export function USD(amount: number) {
  return { amount: BigInt(Math.round(amount * 100)), currency: 'USD' as const };
}

/** SYP in minor units, with its rate. SYP(13000, '13000') is 13,000 SYP at 13,000 per dollar. */
export function SYP(amount: number, rateToBase: string) {
  return { amount: BigInt(amount) * 100n, currency: 'SYP' as const, rateToBase };
}

/** Puts `quantity` of a variant into a warehouse through the ledger (a costed receipt). */
export async function stock(
  services: Services,
  world: World,
  variant: VariantView,
  location: LocationView,
  quantity: number,
  unitCost: UnitCostInput = USD(1000),
) {
  return services.inventory.receiveStock(
    { variantId: variant.id, locationId: location.id, quantity, unitCost },
    write(world.owner),
  );
}

async function wipe(db: Db) {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename::text AS tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  // TRUNCATE is not UPDATE/DELETE, so the append-only triggers do not block test cleanup.
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  await db.$executeRawUnsafe(`ALTER SEQUENCE variant_barcode_seq RESTART WITH 1`);
}

async function buildWorld(db: Db, services: Services): Promise<World> {
  // Two people who may approve, so four eyes apply (a person without a login does not count).
  const person = { roles: ['owner'], passwordHash: 'not-a-login' };
  const ownerUser = await db.user.create({
    data: { email: 'owner@test.local', nameAr: 'المالك', ...person },
  });
  const approverUser = await db.user.create({
    data: { email: 'approver@test.local', nameAr: 'المدقق', ...person },
  });
  const owner = { userId: ownerUser.id, permissions: new Set(ALL_PERMISSIONS) };
  const approver = { userId: approverUser.id, permissions: new Set(ALL_PERMISSIONS) };

  // Both warehouses are in Syria here; the Libya warehouse and the road between branches are
  // for the shipment tests (F-04).
  const [wh1, wh2, store, ly] = (
    await Promise.all([
      db.location.create({
        data: { code: 'WH1', nameAr: 'المخزن الرئيسي', kind: 'WAREHOUSE', branch: 'SY' },
      }),
      db.location.create({
        data: { code: 'WH2', nameAr: 'المخزن الثاني', kind: 'WAREHOUSE', branch: 'SY' },
      }),
      db.location.create({
        data: { code: 'STORE', nameAr: 'المتجر', kind: 'STORE', branch: 'SY' },
      }),
      db.location.create({
        data: { code: 'LY1', nameAr: 'مستودع ليبيا', kind: 'WAREHOUSE', branch: 'LY' },
      }),
      db.location.create({ data: { code: 'TRANSIT', nameAr: 'بالطريق', kind: 'TRANSIT' } }),
    ])
  ).map((l) => ({ ...l, branch: l.branch as BranchCode | null }));

  const options = await createOptionTypes(db);
  const category = await services.catalogue.createCategory(
    { code: 'THB-TEST', nameAr: 'ثوب تجريبي', groupIds: Object.values(options).map((g) => g.id) },
    owner,
  );
  const { created } = await services.catalogue.generateProducts(
    {
      categoryId: category.id,
      selections: [
        pick(options.fabric, 'قطني'),
        pick(options.colour, 'أبيض'),
        pick(options.size, '54', '56', '58'),
      ],
    },
    owner,
  );
  const bySize = (size: string) => created.find((v) => v.size === size)!;

  return {
    owner,
    approver,
    wh1: wh1!,
    wh2: wh2!,
    store: store!,
    ly: ly!,
    options,
    category,
    x: bySize('54'),
    y: bySize('56'),
    z: bySize('58'),
  };
}

export interface OptionType {
  id: string;
  values: { id: string; valueAr: string }[];
}

/** A selection for generateProducts: the named values of one option type. */
export function pick(group: OptionType, ...names: string[]) {
  return {
    groupId: group.id,
    valueIds: names.map((name) => {
      const value = group.values.find((v) => v.valueAr === name);
      if (!value) throw new Error(`no value ${name} in option type`);
      return value.id;
    }),
  };
}

/** Fabric, colour and size, keyed like the built-in types the migration creates. */
async function createOptionTypes(db: Db) {
  const make = async (key: string, nameAr: string, sortOrder: number, values: string[]) =>
    db.optionGroup.create({
      data: {
        key,
        nameAr,
        sortOrder,
        values: {
          create: values.map((valueAr, i) => ({
            valueAr,
            code: suggestCode(valueAr),
            sortOrder: (i + 1) * 10,
          })),
        },
      },
      select: { id: true, values: { select: { id: true, valueAr: true } } },
    });
  return {
    fabric: await make('FABRIC', 'القماش', 50, ['قطني', 'جوخ هندي']),
    colour: await make('COLOUR', 'اللون', 60, ['أبيض', 'أسود']),
    size: await make('SIZE', 'القياس', 70, ['54', '56', '58', '60']),
  };
}
