import type { PriceList, Prisma } from '@prisma/client';
import type { Queryable, Tx } from '../../shared/db.js';
import type { OptionGroupView, PriceView, VariantView } from './catalogue.types.js';

const valueFields = { id: true, valueAr: true, sortOrder: true } as const;

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

const variantSelect = {
  id: true,
  sku: true,
  barcode: true,
  isActive: true,
  product: {
    select: {
      id: true,
      code: true,
      nameAr: true,
      nameEn: true,
      unitOfMeasure: true,
      isActive: true,
      photos: {
        where: { deletedAt: null },
        select: { id: true, sortOrder: true, values: { select: { valueId: true } } },
      },
    },
  },
  prices: { select: { list: true, amount: true, currency: true } },
  optionValues: {
    select: {
      groupId: true,
      group: { select: { key: true, nameAr: true, sortOrder: true } },
      // The value and up to two levels above it (جوخ هندي → مشخط).
      value: {
        select: {
          ...valueFields,
          parent: { select: { ...valueFields, parent: { select: valueFields } } },
        },
      },
    },
  },
} satisfies Prisma.ProductVariantSelect;

type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;

const live = { deletedAt: null } as const;

function toView(row: VariantRow): VariantView {
  const { photos, ...product } = row.product;
  const sorted = [...row.optionValues].sort(
    (a, b) => a.group.sortOrder - b.group.sortOrder || a.group.nameAr.localeCompare(b.group.nameAr),
  );
  const options = sorted.map((o) => {
    const path = pathOf(o.value);
    return {
      groupId: o.groupId,
      groupKey: o.group.key,
      group: o.group.nameAr,
      valueId: o.value.id,
      // A detail reads with what it details: "جوخ هندي مشخط".
      value: path.map((v) => v.valueAr).join(' '),
      pathIds: path.map((v) => v.id),
    };
  });
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    isActive: row.isActive,
    options: options.map(({ pathIds: _, ...option }) => option),
    title: options.map((o) => o.value).join(' · '),
    size: options.find((o) => o.groupKey === 'SIZE')?.value ?? null,
    prices: { retail: priceOn(row, 'RETAIL'), wholesale: priceOn(row, 'WHOLESALE') },
    // A photo tagged جوخ هندي shows every جوخ هندي detail.
    photoId: bestPhoto(
      photos,
      options.flatMap((o) => o.pathIds),
    ),
    product,
  };
}

/**
 * The photo that shows this variant best (ADR-010): among photos whose every tag is one of the
 * variant's values, the one with the most tags; ties go to the earlier photo. Untagged photos are
 * general photos of the product and match every variant.
 */
export function bestPhoto(
  photos: readonly { id: string; sortOrder: number; values: readonly { valueId: string }[] }[],
  variantValueIds: readonly string[],
): string | null {
  const own = new Set(variantValueIds);
  const matching = photos.filter((p) => p.values.every((v) => own.has(v.valueId)));
  matching.sort((a, b) => b.values.length - a.values.length || a.sortOrder - b.sortOrder);
  return matching[0]?.id ?? null;
}

function priceOn(row: VariantRow, list: PriceList): PriceView | null {
  const price = row.prices.find((p) => p.list === list);
  return price ? { amount: price.amount, currency: price.currency } : null;
}

/**
 * Within one product: by each type's value order (القصة, then الزر, …), so a table of variants
 * reads like the option lists. Across products: by product code.
 */
function compareVariants(a: VariantRow, b: VariantRow): number {
  if (a.product.code !== b.product.code) return a.product.code < b.product.code ? -1 : 1;
  const order = (row: VariantRow) =>
    [...row.optionValues]
      .sort((x, y) => x.group.sortOrder - y.group.sortOrder)
      .flatMap((o) => pathOf(o.value).map((v) => v.sortOrder));
  const [x, y] = [order(a), order(b)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length || (a.sku < b.sku ? -1 : 1);
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

export async function searchVariants(
  q: Queryable,
  args: { q?: string | undefined; productId?: string | undefined; limit: number },
): Promise<VariantView[]> {
  const text = args.q;
  const rows = await q.productVariant.findMany({
    where: {
      ...live,
      ...(args.productId ? { productId: args.productId } : {}),
      ...(text
        ? {
            OR: [
              { sku: { contains: text, mode: 'insensitive' } },
              { barcode: { startsWith: text } },
              { product: { nameAr: { contains: text, mode: 'insensitive' } } },
              {
                optionValues: {
                  some: {
                    value: {
                      OR: [
                        { valueAr: { contains: text } },
                        { parent: { valueAr: { contains: text } } },
                      ],
                    },
                  },
                },
              },
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

/** Serialises concurrent variant generation for the same product. */
export async function lockProduct(tx: Tx, productId: string) {
  const rows = await tx.$queryRaw<{ id: string; code: string; is_active: boolean }[]>`
    SELECT id, code, is_active FROM products
    WHERE id = ${productId}::uuid AND deleted_at IS NULL
    FOR UPDATE`;
  return rows[0] ?? null;
}

/**
 * The next generated product code, P-0001, P-0002, … from the database sequence. Skips a number
 * someone already used by hand, so a generated code never collides.
 */
export async function nextProductCode(tx: Tx): Promise<string> {
  for (;;) {
    const [row] = await tx.$queryRaw<
      { value: bigint }[]
    >`SELECT nextval('product_code_seq') AS value`;
    const code = `P-${row!.value.toString().padStart(4, '0')}`;
    if (!(await tx.product.findUnique({ where: { code }, select: { id: true } }))) return code;
  }
}

/** Allocates barcode sequence numbers from the database — never from application code. */
export async function nextBarcodeSequences(tx: Tx, count: number): Promise<bigint[]> {
  const rows = await tx.$queryRaw<{ value: bigint }[]>`
    SELECT nextval('variant_barcode_seq') AS value FROM generate_series(1, ${count}::int)`;
  return rows.map((row) => row.value);
}
