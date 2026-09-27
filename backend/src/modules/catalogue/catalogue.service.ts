import { Prisma } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { BARCODE_ENTITY, buildInternalBarcode, isMisreadEan13 } from '../../shared/barcode.js';
import { inTransaction, type Db, type Queryable } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import {
  BarcodeNotFoundError,
  BarcodeTakenError,
  InvalidBarcodeError,
  ProductCodeTakenError,
  ProductInactiveError,
} from './catalogue.errors.js';
import * as repo from './catalogue.repository.js';
import {
  createProductSchema,
  generateVariantsSchema,
  registerExternalBarcodeSchema,
  searchVariantsSchema,
  type CreateProductInput,
  type GenerateVariantsInput,
  type RegisterExternalBarcodeInput,
  type SearchVariantsInput,
} from './catalogue.schema.js';
import type { ProductView, VariantView } from './catalogue.types.js';

export type { ProductView, VariantView } from './catalogue.types.js';

export function createCatalogueService(db: Db) {
  return {
    async createProduct(input: CreateProductInput, ctx: ActorContext): Promise<ProductView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(createProductSchema, input);
      try {
        return await inTransaction(db, async (tx) => {
          const product = await tx.product.create({
            data: {
              code: data.code,
              nameAr: data.nameAr,
              nameEn: data.nameEn ?? null,
              unitOfMeasure: data.unitOfMeasure,
            },
            select: {
              id: true,
              code: true,
              nameAr: true,
              nameEn: true,
              unitOfMeasure: true,
              isActive: true,
            },
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'products.create',
            entityType: 'product',
            entityId: product.id,
            after: product,
          });
          return product;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new ProductCodeTakenError(data.code);
        throw error;
      }
    },

    /**
     * Creates every missing fabric × colour × size combination for a product. Existing
     * combinations are left untouched, so running it again with an extra size only adds that size.
     * Each new variant gets an EAN-13 barcode from the database sequence and an ASCII SKU.
     */
    async generateVariants(
      input: GenerateVariantsInput,
      ctx: ActorContext,
    ): Promise<{ created: VariantView[]; existing: VariantView[] }> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(generateVariantsSchema, input);

      return inTransaction(db, async (tx) => {
        const product = await repo.lockProduct(tx, data.productId);
        if (!product) throw new NotFoundError('product', data.productId);
        if (!product.is_active) throw new ProductInactiveError(data.productId);

        const current = await tx.productVariant.findMany({
          where: { productId: data.productId, deletedAt: null },
          select: { fabric: true, colour: true, size: true },
        });
        const taken = new Set(current.map((v) => comboKey(v.fabric, v.colour, v.size)));

        const wanted = data.fabrics.flatMap((fabric) =>
          data.colours.flatMap((colour) => data.sizes.map((size) => ({ fabric, colour, size }))),
        );
        const missing = wanted.filter((c) => !taken.has(comboKey(c.fabric, c.colour, c.size)));

        const sequences = missing.length ? await repo.nextBarcodeSequences(tx, missing.length) : [];
        const rows = missing.map((combo, i) => {
          const sequence = sequences[i]!;
          return {
            productId: data.productId,
            ...combo,
            barcode: buildInternalBarcode(BARCODE_ENTITY.variant, sequence),
            // Human-readable, ASCII, unique. Attributes live in their own columns (they may be
            // Arabic), so the SKU does not try to encode them.
            sku: `${product.code}-${sequence.toString().padStart(6, '0')}`,
          };
        });
        if (rows.length) await tx.productVariant.createMany({ data: rows });

        const all = await repo.searchVariants(tx, { productId: data.productId, limit: 10_000 });
        const createdBarcodes = new Set(rows.map((r) => r.barcode));
        const created = all.filter((v) => createdBarcodes.has(v.barcode));
        const existing = all.filter((v) => !createdBarcodes.has(v.barcode));

        if (created.length) {
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'products.variants.generate',
            entityType: 'product',
            entityId: data.productId,
            after: { created: created.map((v) => ({ id: v.id, sku: v.sku, barcode: v.barcode })) },
          });
        }
        return { created, existing };
      });
    },

    /** Attaches a barcode that arrived printed on the goods (manufacturer GTIN or supplier code). */
    async registerExternalBarcode(input: RegisterExternalBarcodeInput, ctx: ActorContext) {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(registerExternalBarcodeSchema, input);
      if (data.kind === 'GTIN' && !isValidGtin(data.barcode)) {
        throw new InvalidBarcodeError(data.barcode);
      }
      if (data.kind === 'SUPPLIER' && !/^[A-Za-z0-9-]+$/.test(data.barcode)) {
        throw new InvalidBarcodeError(data.barcode);
      }

      try {
        return await inTransaction(db, async (tx) => {
          const [variant] = await repo.findVariantsByIds(tx, [data.variantId]);
          if (!variant) throw new NotFoundError('variant', data.variantId);
          // An external code equal to one of our internal codes would make a scan ambiguous.
          if (await repo.findVariantByBarcode(tx, data.barcode)) {
            throw new BarcodeTakenError(data.barcode);
          }
          const row = await tx.variantBarcode.create({
            data: { variantId: data.variantId, barcode: data.barcode, kind: data.kind },
            select: { id: true, variantId: true, barcode: true, kind: true },
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'products.barcode.register',
            entityType: 'variant',
            entityId: data.variantId,
            after: row,
          });
          return row;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new BarcodeTakenError(data.barcode);
        throw error;
      }
    },

    async listProducts(ctx: ActorContext): Promise<(ProductView & { variantCount: number })[]> {
      assertPermission(ctx, PERMISSIONS.products.read);
      const rows = await db.product.findMany({
        where: { deletedAt: null },
        orderBy: { code: 'asc' },
        select: {
          id: true,
          code: true,
          nameAr: true,
          nameEn: true,
          unitOfMeasure: true,
          isActive: true,
          _count: { select: { variants: { where: { deletedAt: null } } } },
        },
      });
      return rows.map(({ _count, ...product }) => ({ ...product, variantCount: _count.variants }));
    },

    async getVariant(id: string, ctx: ActorContext): Promise<VariantView> {
      assertPermission(ctx, PERMISSIONS.products.read);
      const [variant] = await repo.findVariantsByIds(db, [id]);
      if (!variant) throw new NotFoundError('variant', id);
      return variant;
    },

    async searchVariants(input: SearchVariantsInput, ctx: ActorContext): Promise<VariantView[]> {
      assertPermission(ctx, PERMISSIONS.products.read);
      const data = parse(searchVariantsSchema, input);
      return repo.searchVariants(db, data);
    },

    // ── Trusted calls for other modules ─────────────────────────────────────────────────────
    // No permission check: the calling module has already authorised its own operation, and
    // these run inside its transaction.

    async variantsByIds(q: Queryable, ids: string[]): Promise<VariantView[]> {
      return repo.findVariantsByIds(q, ids);
    },

    /**
     * Resolution order (docs/barcode.md): internal barcode → external barcode → SKU.
     * A 13-digit code with a wrong check digit that matches nothing is reported as a misread,
     * never guessed.
     */
    async lookupBarcode(q: Queryable, rawCode: string): Promise<VariantView> {
      const code = rawCode.trim();
      const found =
        (/^\d{13}$/.test(code) && !isMisreadEan13(code)
          ? await repo.findVariantByBarcode(q, code)
          : null) ??
        (await repo.findVariantByExternalBarcode(q, code)) ??
        (await repo.findVariantBySku(q, code));
      if (found) return found;
      if (isMisreadEan13(code)) throw new InvalidBarcodeError(code);
      throw new BarcodeNotFoundError(code);
    },
  };
}

export type CatalogueService = ReturnType<typeof createCatalogueService>;

function comboKey(fabric: string, colour: string, size: string): string {
  return JSON.stringify([fabric, colour, size]);
}

/** GTIN-8/12/13/14 mod-10 check: weights 3,1,3,… from the rightmost data digit. */
function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
