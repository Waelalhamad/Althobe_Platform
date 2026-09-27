import type { Prisma } from '@prisma/client';
import type { Queryable, Tx } from '../../shared/db.js';
import type { VariantView } from './catalogue.types.js';

const variantSelect = {
  id: true,
  sku: true,
  barcode: true,
  fabric: true,
  colour: true,
  size: true,
  isActive: true,
  product: {
    select: {
      id: true,
      code: true,
      nameAr: true,
      nameEn: true,
      unitOfMeasure: true,
      isActive: true,
    },
  },
} satisfies Prisma.ProductVariantSelect;

const live = { deletedAt: null } as const;

export async function findVariantByBarcode(
  q: Queryable,
  barcode: string,
): Promise<VariantView | null> {
  return q.productVariant.findFirst({ where: { barcode, ...live }, select: variantSelect });
}

export async function findVariantByExternalBarcode(
  q: Queryable,
  barcode: string,
): Promise<VariantView | null> {
  const row = await q.variantBarcode.findUnique({
    where: { barcode },
    select: { variant: { select: variantSelect } },
  });
  return row?.variant ?? null;
}

export async function findVariantBySku(q: Queryable, sku: string): Promise<VariantView | null> {
  return q.productVariant.findFirst({ where: { sku, ...live }, select: variantSelect });
}

export async function findVariantsByIds(q: Queryable, ids: string[]): Promise<VariantView[]> {
  return q.productVariant.findMany({ where: { id: { in: ids }, ...live }, select: variantSelect });
}

export async function searchVariants(
  q: Queryable,
  args: { q?: string | undefined; productId?: string | undefined; limit: number },
): Promise<VariantView[]> {
  const text = args.q;
  return q.productVariant.findMany({
    where: {
      ...live,
      ...(args.productId ? { productId: args.productId } : {}),
      ...(text
        ? {
            OR: [
              { sku: { contains: text, mode: 'insensitive' } },
              { barcode: { startsWith: text } },
              { fabric: { contains: text, mode: 'insensitive' } },
              { colour: { contains: text, mode: 'insensitive' } },
              { product: { nameAr: { contains: text, mode: 'insensitive' } } },
            ],
          }
        : {}),
    },
    select: variantSelect,
    orderBy: [{ product: { code: 'asc' } }, { fabric: 'asc' }, { colour: 'asc' }, { size: 'asc' }],
    take: args.limit,
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

/** Allocates barcode sequence numbers from the database — never from application code. */
export async function nextBarcodeSequences(tx: Tx, count: number): Promise<bigint[]> {
  const rows = await tx.$queryRaw<{ value: bigint }[]>`
    SELECT nextval('variant_barcode_seq') AS value FROM generate_series(1, ${count}::int)`;
  return rows.map((row) => row.value);
}
