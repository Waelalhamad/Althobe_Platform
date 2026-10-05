import type { PriceList, Prisma } from '@prisma/client';
import type { Queryable, Tx } from '../../shared/db.js';
import type {
  CategoryView,
  OptionGroupView,
  PriceView,
  Prices,
  ProductView,
  VariantOption,
  VariantView,
} from './catalogue.types.js';

// ─── Option values: a value and up to two levels above it (جوخ هندي → مشخط) ──────────────────

const valueFields = { id: true, valueAr: true, sortOrder: true } as const;
const valueWithPath = {
  select: {
    ...valueFields,
    parent: { select: { ...valueFields, parent: { select: valueFields } } },
  },
} as const;

interface ValueNode {
  id: string;
  valueAr: string;
  sortOrder: number;
  parent?: ValueNode | null;
}

/** Top-down: [جوخ هندي, مشخط]. */
function pathOf(value: ValueNode): ValueNode[] {
  const path: ValueNode[] = [];
  for (let v: ValueNode | null | undefined = value; v; v = v.parent) path.unshift(v);
  return path;
}

const optionRowSelect = {
  groupId: true,
  group: { select: { key: true, nameAr: true, sortOrder: true } },
  value: valueWithPath,
} as const;

interface OptionRow {
  groupId: string;
  group: { key: string | null; nameAr: string; sortOrder: number };
  value: ValueNode;
}

const byType = (a: OptionRow, b: OptionRow) =>
  a.group.sortOrder - b.group.sortOrder || a.group.nameAr.localeCompare(b.group.nameAr);

function toOptions(rows: readonly OptionRow[]): VariantOption[] {
  return [...rows].sort(byType).map((o) => ({
    groupId: o.groupId,
    groupKey: o.group.key,
    group: o.group.nameAr,
    valueId: o.value.id,
    // A detail reads with what it details: "جوخ هندي مشخط".
    value: pathOf(o.value)
      .map((v) => v.valueAr)
      .join(' '),
  }));
}

/** Sort key: each type's value order, details after their heading. */
const orderOf = (rows: readonly OptionRow[]) =>
  [...rows].sort(byType).flatMap((o) => pathOf(o.value).map((v) => v.sortOrder));

function compareKeys(x: number[], y: number[]): number {
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

const priceSelect = { select: { list: true, amount: true, currency: true } } as const;

type PriceRow = { list: PriceList; amount: bigint; currency: string };

function priceOn(prices: readonly PriceRow[], list: PriceList): PriceView | null {
  const price = prices.find((p) => p.list === list);
  return price ? { amount: price.amount, currency: price.currency } : null;
}

const pricesOf = (rows: readonly PriceRow[]): Prices => ({
  retail: priceOn(rows, 'RETAIL'),
  wholesale: priceOn(rows, 'WHOLESALE'),
});

const firstPhoto = {
  where: { deletedAt: null },
  orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  take: 1,
  select: { id: true },
} satisfies Prisma.Product$photosArgs;

// ─── Variants ────────────────────────────────────────────────────────────────────────────────

const variantSelect = {
  id: true,
  sku: true,
  barcode: true,
  isActive: true,
  prices: priceSelect,
  optionValues: { select: optionRowSelect },
  product: {
    select: {
      id: true,
      code: true,
      isActive: true,
      prices: priceSelect,
      photos: firstPhoto,
      styleValues: { select: optionRowSelect },
      category: {
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          unitOfMeasure: true,
          isActive: true,
        },
      },
    },
  },
} satisfies Prisma.ProductVariantSelect;

type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;

const live = { deletedAt: null } as const;

function toView(row: VariantRow): VariantView {
  const { product } = row;
  const design = toOptions(product.styleValues);
  const options = toOptions([...product.styleValues, ...row.optionValues]);
  const own = pricesOf(row.prices);
  const base = pricesOf(product.prices);
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    isActive: row.isActive,
    options,
    title: options.map((o) => o.value).join(' · '),
    size: options.find((o) => o.groupKey === 'SIZE')?.value ?? null,
    prices: { retail: own.retail ?? base.retail, wholesale: own.wholesale ?? base.wholesale },
    ownPrices: { retail: own.retail !== null, wholesale: own.wholesale !== null },
    photoId: product.photos[0]?.id ?? null,
    product: {
      id: product.id,
      code: product.code,
      nameAr: product.category.nameAr,
      nameEn: product.category.nameEn,
      title: design.map((o) => o.value).join(' · '),
      categoryId: product.category.id,
      unitOfMeasure: product.category.unitOfMeasure,
      isActive: product.isActive && product.category.isActive,
    },
  };
}

/** By category code, then the design's option order, then size. */
function compareVariants(a: VariantRow, b: VariantRow): number {
  const [ca, cb] = [a.product.category.code, b.product.category.code];
  if (ca !== cb) return ca < cb ? -1 : 1;
  return (
    compareKeys(orderOf(a.product.styleValues), orderOf(b.product.styleValues)) ||
    compareKeys(orderOf(a.optionValues), orderOf(b.optionValues)) ||
    (a.sku < b.sku ? -1 : 1)
  );
}

export async function findVariantByBarcode(
  q: Queryable,
  barcode: string,
): Promise<VariantView | null> {
  const row = await q.productVariant.findFirst({
    where: { barcode, ...live },
    select: variantSelect,
  });
  return row ? toView(row) : null;
}

export async function findVariantByExternalBarcode(
  q: Queryable,
  barcode: string,
): Promise<VariantView | null> {
  const row = await q.variantBarcode.findUnique({
    where: { barcode },
    select: { variant: { select: variantSelect } },
  });
  return row ? toView(row.variant) : null;
}

export async function findVariantBySku(q: Queryable, sku: string): Promise<VariantView | null> {
  const row = await q.productVariant.findFirst({ where: { sku, ...live }, select: variantSelect });
  return row ? toView(row) : null;
}

export async function findVariantsByIds(q: Queryable, ids: string[]): Promise<VariantView[]> {
  const rows = await q.productVariant.findMany({
    where: { id: { in: ids }, ...live },
    select: variantSelect,
  });
  return rows.map(toView);
}

const valueMatches = (text: string) => ({
  value: {
    OR: [{ valueAr: { contains: text } }, { parent: { valueAr: { contains: text } } }],
  },
});

export async function searchVariants(
  q: Queryable,
  args: {
    q?: string | undefined;
    productId?: string | undefined;
    categoryId?: string | undefined;
    limit: number;
  },
): Promise<VariantView[]> {
  const text = args.q;
  const rows = await q.productVariant.findMany({
    where: {
      ...live,
      product: {
        deletedAt: null,
        ...(args.categoryId ? { categoryId: args.categoryId } : {}),
      },
      ...(args.productId ? { productId: args.productId } : {}),
      ...(text
        ? {
            OR: [
              { sku: { contains: text, mode: 'insensitive' } },
              { barcode: { startsWith: text } },
              { product: { category: { nameAr: { contains: text, mode: 'insensitive' } } } },
              { product: { styleValues: { some: valueMatches(text) } } },
              { optionValues: { some: valueMatches(text) } },
            ],
          }
        : {}),
    },
    select: variantSelect,
    orderBy: [{ product: { code: 'asc' } }, { sku: 'asc' }],
    take: args.limit,
  });
  return rows.sort(compareVariants).map(toView);
}

// ─── Products ────────────────────────────────────────────────────────────────────────────────

const productSelect = {
  id: true,
  code: true,
  isActive: true,
  prices: priceSelect,
  photos: firstPhoto,
  styleValues: { select: optionRowSelect },
  category: { select: { id: true, code: true, nameAr: true, isActive: true } },
  _count: { select: { variants: { where: live } } },
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

function toProductView(row: ProductRow): ProductView {
  const options = toOptions(row.styleValues);
  return {
    id: row.id,
    code: row.code,
    isActive: row.isActive,
    category: row.category,
    options,
    title: options.map((o) => o.value).join(' · '),
    prices: pricesOf(row.prices),
    mainPhotoId: row.photos[0]?.id ?? null,
    variantCount: row._count.variants,
  };
}

export async function listProducts(
  q: Queryable,
  args: { categoryId?: string | undefined; ids?: string[] | undefined },
): Promise<ProductView[]> {
  const rows = await q.product.findMany({
    where: {
      ...live,
      category: live,
      ...(args.categoryId ? { categoryId: args.categoryId } : {}),
      ...(args.ids ? { id: { in: args.ids } } : {}),
    },
    select: productSelect,
  });
  return rows
    .sort((a, b) => {
      const [ca, cb] = [a.category.code, b.category.code];
      if (ca !== cb) return ca < cb ? -1 : 1;
      return compareKeys(orderOf(a.styleValues), orderOf(b.styleValues));
    })
    .map(toProductView);
}

// ─── Categories and option types ─────────────────────────────────────────────────────────────

export async function listCategories(q: Queryable): Promise<CategoryView[]> {
  const rows = await q.category.findMany({
    where: live,
    orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
    select: {
      id: true,
      code: true,
      nameAr: true,
      nameEn: true,
      parentId: true,
      sortOrder: true,
      isActive: true,
      unitOfMeasure: true,
      optionGroups: { select: { groupId: true, group: { select: { sortOrder: true } } } },
      _count: { select: { products: { where: live } } },
    },
  });
  return rows.map(({ optionGroups, _count, ...category }) => ({
    ...category,
    groupIds: [...optionGroups]
      .sort((a, b) => a.group.sortOrder - b.group.sortOrder)
      .map((g) => g.groupId),
    productCount: _count.products,
  }));
}

export async function listOptionGroups(q: Queryable): Promise<OptionGroupView[]> {
  return q.optionGroup.findMany({
    orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
    select: {
      id: true,
      key: true,
      nameAr: true,
      sortOrder: true,
      isActive: true,
      values: {
        orderBy: [{ sortOrder: 'asc' }, { valueAr: 'asc' }],
        select: {
          id: true,
          parentId: true,
          valueAr: true,
          code: true,
          sortOrder: true,
          isActive: true,
        },
      },
    },
  });
}

/** Serialises concurrent product generation in the same category. */
export async function lockCategory(tx: Tx, categoryId: string) {
  const rows = await tx.$queryRaw<{ id: string; code: string; is_active: boolean }[]>`
    SELECT id, code, is_active FROM categories
    WHERE id = ${categoryId}::uuid AND deleted_at IS NULL
    FOR UPDATE`;
  return rows[0] ?? null;
}

/** Allocates barcode sequence numbers from the database — never from application code. */
export async function nextBarcodeSequences(tx: Tx, count: number): Promise<bigint[]> {
  const rows = await tx.$queryRaw<{ value: bigint }[]>`
    SELECT nextval('variant_barcode_seq') AS value FROM generate_series(1, ${count}::int)`;
  return rows.map((row) => row.value);
}
