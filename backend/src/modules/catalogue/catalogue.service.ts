import type { PriceList } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { BARCODE_ENTITY, buildInternalBarcode, isMisreadEan13 } from '../../shared/barcode.js';
import { inTransaction, type Db, type Queryable, type Tx } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import {
  BarcodeNotFoundError,
  BarcodeTakenError,
  CategoryCodeTakenError,
  CategoryHasChildrenError,
  CategoryInactiveError,
  CategoryTooDeepError,
  HasStockError,
  InvalidBarcodeError,
  InvalidOptionGroupsError,
  InvalidSelectionError,
  OptionGroupInUseError,
  TooManyCombinationsError,
} from './catalogue.errors.js';
import * as repo from './catalogue.repository.js';
import {
  createCategorySchema,
  generateProductsSchema,
  listProductsSchema,
  registerExternalBarcodeSchema,
  searchVariantsSchema,
  setActiveSchema,
  setPricesSchema,
  setProductPricesSchema,
  updateCategorySchema,
  type CreateCategoryInput,
  type GenerateProductsInput,
  type ListProductsInput,
  type RegisterExternalBarcodeInput,
  type SearchVariantsInput,
  type SetActiveInput,
  type SetPricesInput,
  type SetProductPricesInput,
  type UpdateCategoryInput,
} from './catalogue.schema.js';
import type { CategoryView, ProductView, VariantView } from './catalogue.types.js';
import { createOptionsService, isUniqueViolation, moved, renumber } from './options.service.js';
import { buildSku, freeCode, suggestCode } from './sku.js';

export type {
  CategoryView,
  OptionGroupView,
  OptionValueView,
  ProductView,
  VariantOption,
  VariantView,
} from './catalogue.types.js';

// ADR-011: category (ثوب) → product (one design: a value of each type but the size) → variant
// (one size: barcode, SKU, stock). Everything is editable; nothing with stock is ever deleted.

/** One request may create at most this many sizes; more is almost certainly a mistake. */
export const MAX_COMBINATIONS = 500;

/** Selling prices are held in USD (ADR-009); display in other currencies comes later. */
export const PRICE_CURRENCY = 'USD';

/** Categories nest three levels deep at most: ثوب → صيفي → … */
const MAX_CATEGORY_DEPTH = 3;

export function createCatalogueService(db: Db) {
  return {
    ...createOptionsService(db),

    // ── Categories ─────────────────────────────────────────────────────────────────────────

    async listCategories(ctx: ActorContext): Promise<CategoryView[]> {
      assertPermission(ctx, PERMISSIONS.products.read);
      return repo.listCategories(db);
    },

    async createCategory(input: CreateCategoryInput, ctx: ActorContext): Promise<CategoryView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(createCategorySchema, input);

      return inTransaction(db, async (tx) => {
        const all = await repo.listCategories(tx);
        const parent = data.parentId ? all.find((c) => c.id === data.parentId) : undefined;
        if (data.parentId && !parent) throw new NotFoundError('category', data.parentId);
        if (parent && depthOf(all, parent.id) >= MAX_CATEGORY_DEPTH) {
          throw new CategoryTooDeepError();
        }

        const codes = new Set(
          (await tx.category.findMany({ select: { code: true } })).map((c) => c.code),
        );
        if (data.code && codes.has(data.code)) throw new CategoryCodeTakenError(data.code);
        const groupIds = await resolveGroups(tx, data.groupIds ?? parent?.groupIds);
        const last = await tx.category.aggregate({
          where: { parentId: data.parentId ?? null, deletedAt: null },
          _max: { sortOrder: true },
        });

        const category = await tx.category.create({
          data: {
            nameAr: data.nameAr,
            nameEn: data.nameEn ?? null,
            // Without a code, a suggestion from the name (ثوب → THW), made unique.
            code: data.code ?? freeCode(suggestCode(data.nameAr), codes),
            parentId: data.parentId ?? null,
            unitOfMeasure: data.unitOfMeasure,
            sortOrder: (last._max.sortOrder ?? 0) + 10,
            optionGroups: { create: groupIds.map((groupId) => ({ groupId })) },
          },
          select: { id: true },
        });
        const view = (await repo.listCategories(tx)).find((c) => c.id === category.id)!;
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'categories.create',
          entityType: 'category',
          entityId: category.id,
          after: view,
        });
        return view;
      });
    },

    /**
     * Rename, recode, move in the tree, reorder, stop/restart, or change the option types. A type
     * leaves a category only while none of its products uses it.
     */
    async updateCategory(
      id: string,
      input: UpdateCategoryInput,
      ctx: ActorContext,
    ): Promise<CategoryView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(updateCategorySchema, input);

      return inTransaction(db, async (tx) => {
        if (!(await repo.lockCategory(tx, id))) throw new NotFoundError('category', id);
        const all = await repo.listCategories(tx);
        const before = all.find((c) => c.id === id)!;

        if (data.code !== undefined && data.code !== before.code) {
          if (await tx.category.findUnique({ where: { code: data.code } })) {
            throw new CategoryCodeTakenError(data.code);
          }
        }

        if (data.parentId !== undefined && data.parentId !== before.parentId) {
          if (data.parentId) {
            // Not into itself or its own branch, and the whole branch stays within three levels.
            if (!all.some((c) => c.id === data.parentId)) {
              throw new NotFoundError('category', data.parentId);
            }
            if (data.parentId === id || descendantsOf(all, id).includes(data.parentId)) {
              throw new CategoryTooDeepError();
            }
            if (depthOf(all, data.parentId) + heightOf(all, id) > MAX_CATEGORY_DEPTH) {
              throw new CategoryTooDeepError();
            }
          }
          const last = await tx.category.aggregate({
            where: { parentId: data.parentId, deletedAt: null },
            _max: { sortOrder: true },
          });
          await tx.category.update({
            where: { id },
            data: { parentId: data.parentId, sortOrder: (last._max.sortOrder ?? 0) + 10 },
          });
        }

        if (data.groupIds) {
          // A type the category already has stays allowed even if it was deactivated since.
          const groupIds = await resolveGroups(tx, data.groupIds, new Set(before.groupIds));
          const removed = before.groupIds.filter((g) => !groupIds.includes(g));
          const added = groupIds.filter((g) => !before.groupIds.includes(g));
          if (removed.length) {
            const inProducts = await tx.productStyleValue.findMany({
              where: { groupId: { in: removed }, product: { categoryId: id } },
              select: { groupId: true },
              distinct: ['groupId'],
            });
            const inSizes = await tx.variantOptionValue.findMany({
              where: { groupId: { in: removed }, variant: { product: { categoryId: id } } },
              select: { groupId: true },
              distinct: ['groupId'],
            });
            const used = [...inProducts, ...inSizes].map((u) => u.groupId);
            if (used.length) throw new OptionGroupInUseError([...new Set(used)]);
            await tx.categoryOptionGroup.deleteMany({
              where: { categoryId: id, groupId: { in: removed } },
            });
          }
          if (added.length) {
            await tx.categoryOptionGroup.createMany({
              data: added.map((groupId) => ({ categoryId: id, groupId })),
            });
          }
        }

        if (data.move) {
          const parentId = data.parentId !== undefined ? data.parentId : before.parentId;
          const siblings = await tx.category.findMany({
            where: { parentId, deletedAt: null },
            orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
            select: { id: true },
          });
          await renumber(moved(siblings, id, data.move), async (siblingId, sortOrder) =>
            tx.category.update({ where: { id: siblingId }, data: { sortOrder } }),
          );
        }

        await tx.category.update({
          where: { id },
          data: {
            ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
            ...(data.nameEn !== undefined ? { nameEn: data.nameEn } : {}),
            ...(data.code !== undefined ? { code: data.code } : {}),
            ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
          },
        });
        const after = (await repo.listCategories(tx)).find((c) => c.id === id)!;
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'categories.update',
          entityType: 'category',
          entityId: id,
          before,
          after,
        });
        return after;
      });
    },

    /**
     * Removes a category with its products and sizes — only if it has no sub-categories and none
     * of its sizes ever had stock (the ledger keeps every movement for good).
     */
    async deleteCategory(id: string, ctx: ActorContext): Promise<{ ok: true }> {
      assertPermission(ctx, PERMISSIONS.products.write);
      return inTransaction(db, async (tx) => {
        const category = await repo.lockCategory(tx, id);
        if (!category) throw new NotFoundError('category', id);
        if (await tx.category.count({ where: { parentId: id, deletedAt: null } })) {
          throw new CategoryHasChildrenError();
        }
        const variantWhere = { product: { categoryId: id } };
        await assertNoStock(tx, variantWhere);
        const now = new Date();
        await tx.productVariant.updateMany({
          where: { ...variantWhere, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
        await tx.product.updateMany({
          where: { categoryId: id, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
        await tx.category.update({ where: { id }, data: { deletedAt: now, isActive: false } });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'categories.delete',
          entityType: 'category',
          entityId: id,
          before: { code: category.code },
        });
        return { ok: true };
      });
    },

    // ── Products (designs) and their sizes ────────────────────────────────────────────────

    async listProducts(input: ListProductsInput, ctx: ActorContext): Promise<ProductView[]> {
      assertPermission(ctx, PERMISSIONS.products.read);
      const data = parse(listProductsSchema, input);
      return repo.listProducts(db, { categoryId: data.categoryId });
    },

    async getProduct(
      id: string,
      ctx: ActorContext,
    ): Promise<{ product: ProductView; variants: VariantView[] }> {
      assertPermission(ctx, PERMISSIONS.products.read);
      const [product] = await repo.listProducts(db, { ids: [id] });
      if (!product) throw new NotFoundError('product', id);
      const variants = await repo.searchVariants(db, { productId: id, limit: 10_000 });
      return { product, variants };
    },

    /**
     * Creates every missing combination of the chosen values: one product per design (the
     * non-size values) and one variant per size. One list of values per option type of the
     * category. Existing designs and sizes are left as they are (a deleted one is restored), so
     * running it again with an extra size only adds that size.
     */
    async generateProducts(
      input: GenerateProductsInput,
      ctx: ActorContext,
    ): Promise<{ products: ProductView[]; created: VariantView[]; existing: VariantView[] }> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(generateProductsSchema, input);
      if (data.prices) assertPermission(ctx, PERMISSIONS.prices.write);

      return inTransaction(db, async (tx) => {
        const category = await repo.lockCategory(tx, data.categoryId);
        if (!category) throw new NotFoundError('category', data.categoryId);
        if (!category.is_active) throw new CategoryInactiveError(data.categoryId);

        const categoryGroups = await tx.categoryOptionGroup.findMany({
          where: { categoryId: data.categoryId },
          select: { groupId: true, group: { select: { key: true } } },
        });
        const own = new Set(categoryGroups.map((g) => g.groupId));
        const chosen = data.selections.map((s) => s.groupId);
        const missing = [...own].filter((g) => !chosen.includes(g));
        const extra = chosen.filter((g) => !own.has(g));
        if (missing.length || extra.length || new Set(chosen).size !== chosen.length) {
          throw new InvalidSelectionError(
            'Choose values for every option type of the category, each once, and only those',
            { missing, extra },
          );
        }

        const values = await selectedValues(tx, data.selections);
        const byId = new Map(values.map((v) => [v.id, v]));

        const sizeGroupId = categoryGroups.find((g) => g.group.key === 'SIZE')?.groupId;
        const style = data.selections
          .filter((s) => s.groupId !== sizeGroupId)
          .sort((a, b) => typeOrder(byId.get(a.valueIds[0]!)!, byId.get(b.valueIds[0]!)!));
        const sizes = data.selections.find((s) => s.groupId === sizeGroupId)?.valueIds ?? [''];
        const designs = cartesian(style.map((s) => s.valueIds));
        const count = designs.length * sizes.length;
        if (count > MAX_COMBINATIONS) throw new TooManyCombinationsError(count, MAX_COMBINATIONS);

        // Products: find each design, restore it if deleted, or create it.
        const known = new Map(
          (
            await tx.product.findMany({
              where: { categoryId: data.categoryId },
              select: { id: true, code: true, styleKey: true, deletedAt: true },
            })
          ).map((p) => [p.styleKey, p]),
        );
        const restoredProducts = designs
          .map((d) => known.get(optionKey(d)))
          .filter((p) => p?.deletedAt)
          .map((p) => p!.id);
        if (restoredProducts.length) {
          await tx.product.updateMany({
            where: { id: { in: restoredProducts } },
            data: { deletedAt: null, isActive: true },
          });
        }
        const newDesigns = designs.filter((d) => !known.has(optionKey(d)));
        // SKU base: the category code and each value's code in type order (THB-SA-RY-…-WH).
        const productCodes = await uniqueCodes(
          tx,
          'product',
          newDesigns.map((d) =>
            buildSku(
              category.code,
              d.map((v) => segment(byId.get(v)!)),
            ),
          ),
        );
        if (newDesigns.length) {
          const inserted = await tx.product.createManyAndReturn({
            data: newDesigns.map((d, i) => ({
              categoryId: data.categoryId,
              code: productCodes[i]!,
              styleKey: optionKey(d),
            })),
            select: { id: true, code: true, styleKey: true, deletedAt: true },
          });
          for (const p of inserted) known.set(p.styleKey, p);
          await tx.productStyleValue.createMany({
            data: newDesigns.flatMap((d) =>
              d.map((valueId) => ({
                productId: known.get(optionKey(d))!.id,
                groupId: byId.get(valueId)!.groupId,
                valueId,
              })),
            ),
          });
          if (data.prices?.retail !== undefined) {
            await writeProductPrices(
              tx,
              inserted.map((p) => p.id),
              'RETAIL',
              data.prices.retail,
            );
          }
          if (data.prices?.wholesale !== undefined) {
            await writeProductPrices(
              tx,
              inserted.map((p) => p.id),
              'WHOLESALE',
              data.prices.wholesale,
            );
          }
        }
        const products = designs.map((d) => known.get(optionKey(d))!);

        // Sizes: one variant per product per size; a deleted one is restored with its barcode.
        const productIds = products.map((p) => p.id);
        const existingVariants = await tx.productVariant.findMany({
          where: { productId: { in: productIds } },
          select: { id: true, productId: true, optionKey: true, deletedAt: true },
        });
        const variantKey = (productId: string, size: string) => `${productId}|${size}`;
        const knownVariants = new Map(
          existingVariants.map((v) => [variantKey(v.productId, v.optionKey), v]),
        );
        const wanted = products.flatMap((p) => sizes.map((size) => ({ product: p, size })));
        const restored = wanted
          .map((w) => knownVariants.get(variantKey(w.product.id, w.size)))
          .filter((v) => v?.deletedAt)
          .map((v) => v!.id);
        if (restored.length) {
          await tx.productVariant.updateMany({
            where: { id: { in: restored } },
            data: { deletedAt: null, isActive: true },
          });
        }
        const fresh = wanted.filter((w) => !knownVariants.has(variantKey(w.product.id, w.size)));
        const skus = await uniqueCodes(
          tx,
          'variant',
          fresh.map((w) =>
            w.size ? buildSku(w.product.code, [segment(byId.get(w.size)!)]) : w.product.code,
          ),
        );
        const sequences = fresh.length ? await repo.nextBarcodeSequences(tx, fresh.length) : [];
        const createdIds = [...restored];
        if (fresh.length) {
          const inserted = await tx.productVariant.createManyAndReturn({
            data: fresh.map((w, i) => ({
              productId: w.product.id,
              optionKey: w.size,
              sku: skus[i]!,
              barcode: buildInternalBarcode(BARCODE_ENTITY.variant, sequences[i]!),
            })),
            select: { id: true, productId: true, optionKey: true },
          });
          createdIds.push(...inserted.map((v) => v.id));
          const sized = inserted.filter((v) => v.optionKey);
          if (sized.length) {
            await tx.variantOptionValue.createMany({
              data: sized.map((v) => ({
                variantId: v.id,
                groupId: sizeGroupId!,
                valueId: v.optionKey,
              })),
            });
          }
        }

        const all = await repo.searchVariants(tx, { categoryId: data.categoryId, limit: 10_000 });
        const touched = new Set(productIds);
        const mine = all.filter((v) => touched.has(v.product.id));
        const createdSet = new Set(createdIds);
        const created = mine.filter((v) => createdSet.has(v.id));
        if (created.length || restoredProducts.length) {
          await writeAudit(tx, {
            actorId: ctx.userId,
            action: 'products.generate',
            entityType: 'category',
            entityId: data.categoryId,
            after: {
              products: newDesigns.length,
              created: created.map((v) => ({ id: v.id, sku: v.sku, barcode: v.barcode })),
            },
          });
        }
        return {
          products: await repo.listProducts(tx, { ids: productIds }),
          created,
          existing: mine.filter((v) => !createdSet.has(v.id)),
        };
      });
    },

    /** Stops a product (no longer received or sold) or restarts it. Its history stays. */
    async setProductActive(
      id: string,
      input: SetActiveInput,
      ctx: ActorContext,
    ): Promise<ProductView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(setActiveSchema, input);
      return inTransaction(db, async (tx) => {
        const product = await tx.product.findFirst({ where: { id, deletedAt: null } });
        if (!product) throw new NotFoundError('product', id);
        await tx.product.update({ where: { id }, data: { isActive: data.isActive } });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: data.isActive ? 'products.restore' : 'products.retire',
          entityType: 'product',
          entityId: id,
          before: { isActive: product.isActive },
          after: data,
        });
        return (await repo.listProducts(tx, { ids: [id] }))[0]!;
      });
    },

    /** Removes a product and its sizes, only if none of them ever had stock. */
    async deleteProduct(id: string, ctx: ActorContext): Promise<{ ok: true }> {
      assertPermission(ctx, PERMISSIONS.products.write);
      return inTransaction(db, async (tx) => {
        const product = await tx.product.findFirst({ where: { id, deletedAt: null } });
        if (!product) throw new NotFoundError('product', id);
        await assertNoStock(tx, { productId: id });
        const now = new Date();
        await tx.productVariant.updateMany({
          where: { productId: id, deletedAt: null },
          data: { deletedAt: now, isActive: false },
        });
        await tx.product.update({ where: { id }, data: { deletedAt: now, isActive: false } });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'products.delete',
          entityType: 'product',
          entityId: id,
          before: { code: product.code },
        });
        return { ok: true };
      });
    },

    /** Stops one size or restarts it. */
    async setVariantActive(
      id: string,
      input: SetActiveInput,
      ctx: ActorContext,
    ): Promise<VariantView> {
      assertPermission(ctx, PERMISSIONS.products.write);
      const data = parse(setActiveSchema, input);
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
          after: data,
        });
        return { ...before, isActive: data.isActive };
      });
    },

    /** Removes one size, only if it never had stock. Adding it again restores its barcode. */
    async deleteVariant(id: string, ctx: ActorContext): Promise<{ ok: true }> {
      assertPermission(ctx, PERMISSIONS.products.write);
      return inTransaction(db, async (tx) => {
        const variant = await tx.productVariant.findFirst({ where: { id, deletedAt: null } });
        if (!variant) throw new NotFoundError('variant', id);
        await assertNoStock(tx, { id });
        await tx.productVariant.update({
          where: { id },
          data: { deletedAt: new Date(), isActive: false },
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'products.variant.delete',
          entityType: 'variant',
          entityId: id,
          before: { sku: variant.sku, barcode: variant.barcode },
        });
        return { ok: true };
      });
    },

    // ── Prices (ADR-009) ──────────────────────────────────────────────────────────────────

    /** The same retail and/or wholesale price for one product or many; null removes it. */
    async setProductPrices(
      input: SetProductPricesInput,
      ctx: ActorContext,
    ): Promise<ProductView[]> {
      assertPermission(ctx, PERMISSIONS.prices.write);
      const data = parse(setProductPricesSchema, input);
      return inTransaction(db, async (tx) => {
        const before = await repo.listProducts(tx, { ids: data.productIds });
        const missing = data.productIds.filter((id) => !before.some((p) => p.id === id));
        if (missing.length) throw new NotFoundError('product', missing[0]!);
        if (data.retail !== undefined) {
          await writeProductPrices(tx, data.productIds, 'RETAIL', data.retail);
        }
        if (data.wholesale !== undefined) {
          await writeProductPrices(tx, data.productIds, 'WHOLESALE', data.wholesale);
        }
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'prices.product.set',
          entityType: 'product_prices',
          before: before.map((p) => ({ productId: p.id, code: p.code, ...p.prices })),
          after: { ...data, currency: PRICE_CURRENCY },
        });
        return repo.listProducts(tx, { ids: data.productIds });
      });
    },

    /**
     * A size's own price, different from its product's (e.g. 64 costs more); null goes back to
     * the product's price. Every change is audited with what it replaced.
     */
    async setPrices(input: SetPricesInput, ctx: ActorContext): Promise<VariantView[]> {
      assertPermission(ctx, PERMISSIONS.prices.write);
      const data = parse(setPricesSchema, input);
      return inTransaction(db, async (tx) => {
        const before = await repo.findVariantsByIds(tx, data.variantIds);
        const missing = data.variantIds.filter((id) => !before.some((v) => v.id === id));
        if (missing.length) throw new NotFoundError('variant', missing[0]!);
        if (data.retail !== undefined) {
          await writeVariantPrices(tx, data.variantIds, 'RETAIL', data.retail);
        }
        if (data.wholesale !== undefined) {
          await writeVariantPrices(tx, data.variantIds, 'WHOLESALE', data.wholesale);
        }
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'prices.set',
          entityType: 'variant_prices',
          before: before.map((v) => ({ variantId: v.id, sku: v.sku, ...v.prices })),
          after: { ...data, currency: PRICE_CURRENCY },
        });
        return repo.findVariantsByIds(tx, data.variantIds);
      });
    },

    // ── Barcodes and lookups ──────────────────────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────

/** The chosen values, checked: known, under their type, active (with their headings), leaves. */
async function selectedValues(tx: Tx, selections: { groupId: string; valueIds: string[] }[]) {
  const values = await tx.optionValue.findMany({
    where: { id: { in: selections.flatMap((s) => s.valueIds) } },
    select: {
      id: true,
      groupId: true,
      code: true,
      isActive: true,
      group: { select: { isActive: true, sortOrder: true, nameAr: true } },
      parent: {
        select: { code: true, isActive: true, parent: { select: { code: true, isActive: true } } },
      },
      details: { where: { isActive: true }, select: { id: true }, take: 1 },
    },
  });
  const byId = new Map(values.map((v) => [v.id, v]));
  const invalid = selections.flatMap((s) =>
    s.valueIds.filter((valueId) => {
      const v = byId.get(valueId);
      const headingsActive = (v?.parent?.isActive ?? true) && (v?.parent?.parent?.isActive ?? true);
      return !v || v.groupId !== s.groupId || !v.isActive || !headingsActive || !v.group.isActive;
    }),
  );
  if (invalid.length) {
    throw new InvalidSelectionError('Unknown, inactive, or misplaced option values', {
      valueIds: invalid,
    });
  }
  // A value with details is a heading: a product is made of one of its details.
  const headings = values.filter((v) => v.details.length > 0).map((v) => v.id);
  if (headings.length) {
    throw new InvalidSelectionError('Choose a detail of these values', { valueIds: headings });
  }
  return values;
}

type SelectedValue = Awaited<ReturnType<typeof selectedValues>>[number];

const typeOrder = (a: SelectedValue, b: SelectedValue) =>
  a.group.sortOrder - b.group.sortOrder || a.group.nameAr.localeCompare(b.group.nameAr);

/** A value's SKU segment: a detail's code follows its headings' (جوخ هندي مشخط → JHST). */
const segment = (v: SelectedValue) =>
  (v.parent?.parent?.code ?? '') + (v.parent?.code ?? '') + v.code;

/** The wanted codes, each made unique (-2, -3, …) against existing ones and each other. */
async function uniqueCodes(
  tx: Tx,
  kind: 'product' | 'variant',
  wanted: string[],
): Promise<string[]> {
  if (!wanted.length) return [];
  const where = {
    OR: wanted.map((code) => ({ [kind === 'product' ? 'code' : 'sku']: { startsWith: code } })),
  };
  const used = new Set(
    kind === 'product'
      ? (await tx.product.findMany({ where, select: { code: true } })).map((p) => p.code)
      : (await tx.productVariant.findMany({ where, select: { sku: true } })).map((v) => v.sku),
  );
  return wanted.map((code) => {
    let unique = code;
    for (let n = 2; used.has(unique); n++) unique = `${code}-${n}`;
    used.add(unique);
    return unique;
  });
}

/** Refuses to delete anything whose sizes ever moved stock: the ledger is forever. */
async function assertNoStock(
  tx: Tx,
  variantWhere: { id?: string; productId?: string; product?: { categoryId: string } },
): Promise<void> {
  const movements = await tx.inventoryMovement.count({ where: { variant: variantWhere } });
  if (movements) throw new HasStockError();
}

/** One statement for any number of products: a filtered list is priced at once. */
async function writeProductPrices(
  tx: Tx,
  productIds: string[],
  list: PriceList,
  amount: bigint | null,
): Promise<void> {
  if (amount === null) {
    await tx.productPrice.deleteMany({ where: { productId: { in: productIds }, list } });
    return;
  }
  await tx.$executeRaw`
    INSERT INTO product_prices (id, product_id, list, amount, currency, updated_at)
    SELECT gen_random_uuid(), p, ${list}::price_list, ${amount}, ${PRICE_CURRENCY}, now()
    FROM unnest(${productIds}::uuid[]) AS p
    ON CONFLICT (product_id, list)
    DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, updated_at = now()`;
}

async function writeVariantPrices(
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
 * The option types a category uses: the given ones (each must exist and be active, unless the
 * category already has it), or by default every active type.
 */
async function resolveGroups(
  tx: Tx,
  groupIds: string[] | undefined,
  alreadyThere: ReadonlySet<string> = new Set(),
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
    found.filter((g) => g.isActive || alreadyThere.has(g.id)).map((g) => g.id),
  );
  const invalid = unique.filter((id) => !usable.has(id));
  if (invalid.length) throw new InvalidOptionGroupsError(invalid);
  return unique;
}

/** 1 for a top-level category, 2 for one inside it, … */
export function depthOf(
  all: readonly { id: string; parentId: string | null }[],
  id: string,
): number {
  let depth = 0;
  for (let c = all.find((x) => x.id === id); c; c = all.find((x) => x.id === c.parentId)) depth++;
  return depth;
}

export function descendantsOf(
  all: readonly { id: string; parentId: string | null }[],
  id: string,
): string[] {
  const children = all.filter((c) => c.parentId === id).map((c) => c.id);
  return children.flatMap((c) => [c, ...descendantsOf(all, c)]);
}

/** Levels in a branch: 1 for a category without sub-categories. */
function heightOf(all: readonly { id: string; parentId: string | null }[], id: string): number {
  const children = all.filter((c) => c.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => heightOf(all, c.id)));
}

/**
 * The duplicate guard for a design: its value ids sorted by code point and joined. The migration
 * builds existing keys with COLLATE "C", which sorts the same way.
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

export { moved } from './options.service.js';

/** GTIN-8/12/13/14 mod-10 check: weights 3,1,3,… from the rightmost data digit. */
function isValidGtin(code: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop()!;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}
