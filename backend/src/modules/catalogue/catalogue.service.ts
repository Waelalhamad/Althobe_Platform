import { Prisma, type PriceList } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { BARCODE_ENTITY, buildInternalBarcode, isMisreadEan13 } from '../../shared/barcode.js';
import { inTransaction, type Db, type Queryable, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import {
  BarcodeNotFoundError,
  BarcodeTakenError,
  InvalidBarcodeError,
  InvalidOptionGroupsError,
  InvalidSelectionError,
  OptionCodeTakenError,
  OptionGroupInUseError,
  OptionValueTooDeepError,
  OptionGroupTakenError,
  OptionValueTakenError,
  ProductCodeTakenError,
  ProductInactiveError,
  TooManyCombinationsError,
} from './catalogue.errors.js';
import * as repo from './catalogue.repository.js';
import { buildSku, freeCode, suggestCode } from './sku.js';
import {
  addOptionValueSchema,
  createOptionGroupSchema,
  createProductSchema,
  generateVariantsSchema,
  registerExternalBarcodeSchema,
  searchVariantsSchema,
  setPricesSchema,
  setVariantActiveSchema,
  updateOptionGroupSchema,
  updateOptionValueSchema,
  updateProductSchema,
  type AddOptionValueInput,
  type CreateOptionGroupInput,
  type CreateProductInput,
  type GenerateVariantsInput,
  type RegisterExternalBarcodeInput,
  type SearchVariantsInput,
  type SetPricesInput,
  type SetVariantActiveInput,
  type UpdateOptionGroupInput,
  type UpdateOptionValueInput,
  type UpdateProductInput,
} from './catalogue.schema.js';
import type {
  OptionGroupView,
  OptionValueView,
  ProductView,
  VariantView,
} from './catalogue.types.js';

export type {
  OptionGroupView,
  OptionValueView,
  ProductView,
  VariantOption,
  VariantView,
} from './catalogue.types.js';

/** One request may create at most this many variants; more is almost certainly a mistake. */
export const MAX_COMBINATIONS = 500;

/** Selling prices are held in USD (ADR-009); display in other currencies comes later. */
export const PRICE_CURRENCY = 'USD';

const productSelect = {
  id: true,
  code: true,
  nameAr: true,
  nameEn: true,
  unitOfMeasure: true,
  isActive: true,
  optionGroups: { select: { groupId: true, group: { select: { sortOrder: true } } } },
  photos: {
    where: { deletedAt: null },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    take: 1,
    select: { id: true },
  },
} satisfies Prisma.ProductSelect;

type ProductRow = Prisma.ProductGetPayload<{ select: typeof productSelect }>;

function toProductView({ optionGroups, photos, ...product }: ProductRow): ProductView {
  return {
    ...product,
    mainPhotoId: photos[0]?.id ?? null,
    groupIds: [...optionGroups]
      .sort((a, b) => a.group.sortOrder - b.group.sortOrder)
      .map((g) => g.groupId),
  };
}

export function createCatalogueService(db: Db) {
  return {
    async createProduct(input: CreateProductInput, ctx: ActorContext): Promise<ProductView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(createProductSchema, input);
      try {
        return await inTransaction(db, async (tx) => {
          const groupIds = await resolveGroups(tx, data.groupIds);
          const product = toProductView(
            await tx.product.create({
              data: {
                code: data.code ?? (await repo.nextProductCode(tx)),
                nameAr: data.nameAr,
                nameEn: data.nameEn ?? null,
                unitOfMeasure: data.unitOfMeasure,
                optionGroups: { create: groupIds.map((groupId) => ({ groupId })) },
              },
              select: productSelect,
            }),
          );
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
        if (isUniqueViolation(error)) throw new ProductCodeTakenError(data.code ?? '');
        throw error;
      }
    },

    /**
     * Renames, retires/restores, or changes which option types a product is made with. A type
     * can be removed only while no variant of the product carries a value of it.
     */
    async updateProduct(
      id: string,
      input: UpdateProductInput,
      ctx: ActorContext,
    ): Promise<ProductView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(updateProductSchema, input);

      return inTransaction(db, async (tx) => {
        if (!(await repo.lockProduct(tx, id))) throw new NotFoundError('product', id);
        const before = toProductView(
          await tx.product.findUniqueOrThrow({ where: { id }, select: productSelect }),
        );

        if (data.code !== undefined && data.code !== before.code) {
          const clash = await tx.product.findUnique({ where: { code: data.code } });
          if (clash) throw new ProductCodeTakenError(data.code);
        }

        if (data.groupIds) {
          // A type the product already has stays allowed even if it was deactivated since.
          const groupIds = await resolveGroups(tx, data.groupIds, new Set(before.groupIds));
          const removed = before.groupIds.filter((g) => !groupIds.includes(g));
          const added = groupIds.filter((g) => !before.groupIds.includes(g));
          if (removed.length) {
            const used = await tx.variantOptionValue.findMany({
              where: { groupId: { in: removed }, variant: { productId: id } },
              select: { groupId: true },
              distinct: ['groupId'],
            });
            if (used.length) throw new OptionGroupInUseError(used.map((u) => u.groupId));
            await tx.productOptionGroup.deleteMany({
              where: { productId: id, groupId: { in: removed } },
            });
          }
          if (added.length) {
            await tx.productOptionGroup.createMany({
              data: added.map((groupId) => ({ productId: id, groupId })),
            });
          }
        }

        const after = toProductView(
          await tx.product.update({
            where: { id },
            data: {
              ...(data.code !== undefined ? { code: data.code } : {}),
              ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
              ...(data.nameEn !== undefined ? { nameEn: data.nameEn } : {}),
              ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
            select: productSelect,
          }),
        );
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'products.update',
          entityType: 'product',
          entityId: id,
          before,
          after,
        });
        return after;
      });
    },

    /**
     * Creates every missing combination of the chosen values — one list of values per option type
     * of the product. Existing combinations are left untouched, so running it again with an extra
     * colour only adds that colour. Each new variant gets an EAN-13 barcode from the database
     * sequence and an ASCII SKU.
     */
    async generateVariants(
      input: GenerateVariantsInput,
      ctx: ActorContext,
    ): Promise<{ created: VariantView[]; existing: VariantView[] }> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(generateVariantsSchema, input);
      if (data.prices) assertPermission(ctx, PERMISSIONS.prices.write);

      return inTransaction(db, async (tx) => {
        const product = await repo.lockProduct(tx, data.productId);
        if (!product) throw new NotFoundError('product', data.productId);
        if (!product.is_active) throw new ProductInactiveError(data.productId);

        const productGroups = await tx.productOptionGroup.findMany({
          where: { productId: data.productId },
          select: { groupId: true },
        });
        const own = new Set(productGroups.map((g) => g.groupId));
        const chosen = data.selections.map((s) => s.groupId);
        const missing = [...own].filter((g) => !chosen.includes(g));
        const extra = chosen.filter((g) => !own.has(g));
        if (missing.length || extra.length || new Set(chosen).size !== chosen.length) {
          throw new InvalidSelectionError(
            'Choose values for every option type of the product, each once, and only those',
            { missing, extra },
          );
        }

        const values = await tx.optionValue.findMany({
          where: { id: { in: data.selections.flatMap((s) => s.valueIds) } },
          select: {
            id: true,
            groupId: true,
            code: true,
            isActive: true,
            group: { select: { isActive: true, sortOrder: true, nameAr: true } },
            parent: {
              select: {
                code: true,
                isActive: true,
                parent: { select: { code: true, isActive: true } },
              },
            },
            details: { where: { isActive: true }, select: { id: true }, take: 1 },
          },
        });
        const byId = new Map(values.map((v) => [v.id, v]));
        const invalid = data.selections.flatMap((s) =>
          s.valueIds.filter((valueId) => {
            const v = byId.get(valueId);
            const ancestorsActive =
              (v?.parent?.isActive ?? true) && (v?.parent?.parent?.isActive ?? true);
            return (
              !v || v.groupId !== s.groupId || !v.isActive || !ancestorsActive || !v.group.isActive
            );
          }),
        );
        if (invalid.length) {
          throw new InvalidSelectionError('Unknown, inactive, or misplaced option values', {
            valueIds: invalid,
          });
        }
        // A value with details is a heading: the variant is made of one of its details.
        const headings = values.filter((v) => v.details.length > 0).map((v) => v.id);
        if (headings.length) {
          throw new InvalidSelectionError('Choose a detail of these values', {
            valueIds: headings,
          });
        }

        const count = data.selections.reduce((n, s) => n * s.valueIds.length, 1);
        if (count > MAX_COMBINATIONS) throw new TooManyCombinationsError(count, MAX_COMBINATIONS);

        // Every key ever used by this product, retired variants included: a combination keeps its
        // barcode for life and is restored, never recreated.
        const taken = new Set(
          (
            await tx.productVariant.findMany({
              where: { productId: data.productId },
              select: { optionKey: true },
            })
          ).map((v) => v.optionKey),
        );
        const fresh = cartesian(data.selections.map((s) => s.valueIds)).filter(
          (combo) => !taken.has(optionKey(combo)),
        );

        // SKU: the product code and each value's code, in type order (THB-SA-RY-…-56). A SKU
        // already in use (a code renamed and reused) gets -2, -3, … so it stays unique.
        const skuOf = (combo: string[]) =>
          buildSku(
            product.code,
            combo
              .map((id) => byId.get(id)!)
              .sort(
                (a, b) =>
                  a.group.sortOrder - b.group.sortOrder ||
                  a.group.nameAr.localeCompare(b.group.nameAr),
              )
              // A detail's code follows its parent's: جوخ هندي مشخط → JHST.
              .map((v) => (v.parent?.parent?.code ?? '') + (v.parent?.code ?? '') + v.code),
          );
        const wanted = fresh.map(skuOf);
        const usedSkus = new Set(
          (
            await tx.productVariant.findMany({
              where: { OR: wanted.map((sku) => ({ sku: { startsWith: sku } })) },
              select: { sku: true },
            })
          ).map((v) => v.sku),
        );
        const skus = wanted.map((sku) => {
          let unique = sku;
          for (let n = 2; usedSkus.has(unique); n++) unique = `${sku}-${n}`;
          usedSkus.add(unique);
          return unique;
        });

        const sequences = fresh.length ? await repo.nextBarcodeSequences(tx, fresh.length) : [];
        const rows = fresh.map((combo, i) => ({
          productId: data.productId,
          optionKey: optionKey(combo),
          barcode: buildInternalBarcode(BARCODE_ENTITY.variant, sequences[i]!),
          sku: skus[i]!,
        }));
        if (rows.length) {
          const inserted = await tx.productVariant.createManyAndReturn({
            data: rows,
            select: { id: true, optionKey: true },
          });
          const idByKey = new Map(inserted.map((v) => [v.optionKey, v.id]));
          const newIds = inserted.map((v) => v.id);
          if (data.prices?.retail !== undefined) {
            await writePrices(tx, newIds, 'RETAIL', data.prices.retail);
          }
          if (data.prices?.wholesale !== undefined) {
            await writePrices(tx, newIds, 'WHOLESALE', data.prices.wholesale);
          }
          await tx.variantOptionValue.createMany({
            data: fresh.flatMap((combo) =>
              combo.map((valueId, j) => ({
                variantId: idByKey.get(optionKey(combo))!,
                groupId: data.selections[j]!.groupId,
                valueId,
              })),
            ),
          });
        }

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

    /** Retires a variant (no longer received or sold) or restores it. Its history stays. */
    async setVariantActive(
      id: string,
      input: SetVariantActiveInput,
      ctx: ActorContext,
    ): Promise<VariantView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(setVariantActiveSchema, input);

      return inTransaction(db, async (tx) => {
        const [before] = await repo.findVariantsByIds(tx, [id]);
        if (!before) throw new NotFoundError('variant', id);
        await tx.productVariant.update({ where: { id }, data: { isActive: data.isActive } });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: data.isActive ? 'products.variant.restore' : 'products.variant.retire',
          entityType: 'variant',
          entityId: id,
          before: { isActive: before.isActive },
          after: { isActive: data.isActive },
        });
        return { ...before, isActive: data.isActive };
      });
    },

    /**
     * Sets the retail and/or wholesale price of one variant or many (a filtered list) to the same
     * amount; null removes a price. Every change is audited with the prices it replaced.
     */
    async setPrices(input: SetPricesInput, ctx: ActorContext): Promise<VariantView[]> {
      assertPermission(ctx, PERMISSIONS.prices.write);
      const data = parse(setPricesSchema, input);

      return inTransaction(db, async (tx) => {
        const before = await repo.findVariantsByIds(tx, data.variantIds);
        const missing = data.variantIds.filter((id) => !before.some((v) => v.id === id));
        if (missing.length) throw new NotFoundError('variant', missing[0]!);

        if (data.retail !== undefined) {
          await writePrices(tx, data.variantIds, 'RETAIL', data.retail);
        }
        if (data.wholesale !== undefined) {
          await writePrices(tx, data.variantIds, 'WHOLESALE', data.wholesale);
        }
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'prices.set',
          entityType: 'variant_prices',
          before: before.map((v) => ({ variantId: v.id, sku: v.sku, ...v.prices })),
          after: {
            variantIds: data.variantIds,
            currency: PRICE_CURRENCY,
            ...(data.retail !== undefined ? { retail: data.retail } : {}),
            ...(data.wholesale !== undefined ? { wholesale: data.wholesale } : {}),
          },
        });
        return repo.findVariantsByIds(tx, data.variantIds);
      });
    },

    // ── Option types and values (القصة، الزر، …) ────────────────────────────────────────────

    async listOptionGroups(ctx: ActorContext): Promise<OptionGroupView[]> {
      assertPermission(ctx, PERMISSIONS.products.read);
      return repo.listOptionGroups(db);
    },

    async createOptionGroup(
      input: CreateOptionGroupInput,
      ctx: ActorContext,
    ): Promise<OptionGroupView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(createOptionGroupSchema, input);
      try {
        return await inTransaction(db, async (tx) => {
          const last = await tx.optionGroup.aggregate({ _max: { sortOrder: true } });
          const group = await tx.optionGroup.create({
            data: { nameAr: data.nameAr, sortOrder: (last._max.sortOrder ?? 0) + 10 },
            select: { id: true, key: true, nameAr: true, sortOrder: true, isActive: true },
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'options.group.create',
            entityType: 'option_group',
            entityId: group.id,
            after: group,
          });
          return { ...group, values: [] };
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new OptionGroupTakenError(data.nameAr);
        throw error;
      }
    },

    /** Rename, deactivate/restore, or move one place up or down. */
    async updateOptionGroup(
      id: string,
      input: UpdateOptionGroupInput,
      ctx: ActorContext,
    ): Promise<OptionGroupView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(updateOptionGroupSchema, input);
      try {
        return await inTransaction(db, async (tx) => {
          const before = await tx.optionGroup.findUnique({ where: { id } });
          if (!before) throw new NotFoundError('option_group', id);

          if (data.move) {
            const siblings = await tx.optionGroup.findMany({
              orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
              select: { id: true },
            });
            for (const [i, siblingId] of moved(siblings, id, data.move).entries()) {
              await tx.optionGroup.update({
                where: { id: siblingId },
                data: { sortOrder: (i + 1) * 10 },
              });
            }
          }
          await tx.optionGroup.update({
            where: { id },
            data: {
              ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
              ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'options.group.update',
            entityType: 'option_group',
            entityId: id,
            before: { nameAr: before.nameAr, isActive: before.isActive },
            after: data,
          });
          return (await repo.listOptionGroups(tx)).find((g) => g.id === id)!;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new OptionGroupTakenError(data.nameAr ?? '');
        throw error;
      }
    },

    async addOptionValue(input: AddOptionValueInput, ctx: ActorContext): Promise<OptionValueView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(addOptionValueSchema, input);
      try {
        return await inTransaction(db, async (tx) => {
          const group = await tx.optionGroup.findUnique({ where: { id: data.groupId } });
          if (!group) throw new NotFoundError('option_group', data.groupId);
          const parentId = data.parentId ?? null;
          if (parentId) {
            const parent = await tx.optionValue.findFirst({
              where: { id: parentId, groupId: data.groupId },
              select: { parent: { select: { parentId: true } } },
            });
            if (!parent) throw new NotFoundError('option_value', parentId);
            // Three levels at most: type value → detail → detail of the detail.
            if (parent.parent?.parentId) throw new OptionValueTooDeepError();
          }
          const siblings = { groupId: data.groupId, parentId };
          const last = await tx.optionValue.aggregate({
            where: siblings,
            _max: { sortOrder: true },
          });
          const codes = new Set(
            (
              await tx.optionValue.findMany({
                where: siblings,
                select: { code: true },
              })
            ).map((v) => v.code),
          );
          if (data.code && codes.has(data.code)) throw new OptionCodeTakenError(data.code);
          const value = await tx.optionValue.create({
            data: {
              groupId: data.groupId,
              parentId,
              valueAr: data.valueAr,
              // Without a code, a suggestion from the Arabic name, made unique in its type.
              code: data.code ?? freeCode(suggestCode(data.valueAr), codes),
              sortOrder: (last._max.sortOrder ?? 0) + 10,
            },
            select: {
              id: true,
              parentId: true,
              valueAr: true,
              code: true,
              sortOrder: true,
              isActive: true,
            },
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'options.value.create',
            entityType: 'option_value',
            entityId: value.id,
            after: { groupId: data.groupId, ...value },
          });
          return value;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new OptionValueTakenError(data.valueAr);
        throw error;
      }
    },

    /**
     * Rename, deactivate/restore, or move one place. A rename shows everywhere at once; labels
     * already printed keep the old text. A deactivated value is hidden from new variants only.
     */
    async updateOptionValue(
      id: string,
      input: UpdateOptionValueInput,
      ctx: ActorContext,
    ): Promise<OptionValueView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(updateOptionValueSchema, input);
      try {
        return await inTransaction(db, async (tx) => {
          const before = await tx.optionValue.findUnique({ where: { id } });
          if (!before) throw new NotFoundError('option_value', id);
          if (data.code !== undefined && data.code !== before.code) {
            const clash = await tx.optionValue.findFirst({
              where: { groupId: before.groupId, parentId: before.parentId, code: data.code },
            });
            if (clash) throw new OptionCodeTakenError(data.code);
          }

          if (data.move) {
            const siblings = await tx.optionValue.findMany({
              where: { groupId: before.groupId, parentId: before.parentId },
              orderBy: [{ sortOrder: 'asc' }, { valueAr: 'asc' }],
              select: { id: true },
            });
            for (const [i, siblingId] of moved(siblings, id, data.move).entries()) {
              await tx.optionValue.update({
                where: { id: siblingId },
                data: { sortOrder: (i + 1) * 10 },
              });
            }
          }
          const value = await tx.optionValue.update({
            where: { id },
            data: {
              ...(data.valueAr !== undefined ? { valueAr: data.valueAr } : {}),
              ...(data.code !== undefined ? { code: data.code } : {}),
              ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
            select: {
              id: true,
              parentId: true,
              valueAr: true,
              code: true,
              sortOrder: true,
              isActive: true,
            },
          });
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'options.value.update',
            entityType: 'option_value',
            entityId: id,
            before: { valueAr: before.valueAr, code: before.code, isActive: before.isActive },
            after: data,
          });
          return value;
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new OptionValueTakenError(data.valueAr ?? '');
        throw error;
      }
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
          ...productSelect,
          _count: { select: { variants: { where: { deletedAt: null } } } },
        },
      });
      return rows.map(({ _count, ...product }) => ({
        ...toProductView(product),
        variantCount: _count.variants,
      }));
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

/** One statement for any number of variants: a filtered list of 500 is priced at once. */
async function writePrices(
  tx: Tx,
  variantIds: string[],
  list: PriceList,
  amount: bigint | null,
): Promise<void> {
  if (amount === null) {
    await tx.variantPrice.deleteMany({ where: { variantId: { in: variantIds }, list } });
    return;
  }
  await tx.$executeRaw`
    INSERT INTO variant_prices (id, variant_id, list, amount, currency, updated_at)
    SELECT gen_random_uuid(), v, ${list}::price_list, ${amount}, ${PRICE_CURRENCY}, now()
    FROM unnest(${variantIds}::uuid[]) AS v
    ON CONFLICT (variant_id, list)
    DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, updated_at = now()`;
}

/**
 * The option types a product is made with: the given ones (each must exist and be active, unless
 * the product already has it), or by default every active type.
 */
async function resolveGroups(
  tx: Tx,
  groupIds: string[] | undefined,
  alreadyOnProduct: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  if (!groupIds) {
    const active = await tx.optionGroup.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    if (!active.length) throw new InvalidOptionGroupsError([]);
    return active.map((g) => g.id);
  }
  const unique = [...new Set(groupIds)];
  const found = await tx.optionGroup.findMany({
    where: { id: { in: unique } },
    select: { id: true, isActive: true },
  });
  const usable = new Set(
    found.filter((g) => g.isActive || alreadyOnProduct.has(g.id)).map((g) => g.id),
  );
  const invalid = unique.filter((id) => !usable.has(id));
  if (invalid.length) throw new InvalidOptionGroupsError(invalid);
  return unique;
}

/**
 * The duplicate guard for a combination: its value ids sorted by code point and joined. The
 * migration builds existing keys with COLLATE "C", which sorts the same way.
 */
export function optionKey(valueIds: readonly string[]): string {
  return [...valueIds].sort().join(',');
}

/** [[a, b], [x]] → [[a, x], [b, x]]: one entry per list, in list order. */
export function cartesian(lists: readonly (readonly string[])[]): string[][] {
  return lists.reduce<string[][]>(
    (combos, list) => combos.flatMap((combo) => list.map((item) => [...combo, item])),
    [[]],
  );
}

/** The ids in their new order after moving `id` one place up or down (no-op at the ends). */
export function moved(items: readonly { id: string }[], id: string, move: 'up' | 'down'): string[] {
  const ids = items.map((i) => i.id);
  const from = ids.indexOf(id);
  const to = move === 'up' ? from - 1 : from + 1;
  if (from < 0 || to < 0 || to >= ids.length) return ids;
  [ids[from], ids[to]] = [ids[to]!, ids[from]!];
  return ids;
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
