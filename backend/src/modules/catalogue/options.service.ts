import { Prisma } from '@prisma/client';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';
import {
  OptionCodeTakenError,
  OptionGroupTakenError,
  OptionValueTakenError,
  OptionValueTooDeepError,
} from './catalogue.errors.js';
import * as repo from './catalogue.repository.js';
import {
  addOptionValueSchema,
  createOptionGroupSchema,
  updateOptionGroupSchema,
  updateOptionValueSchema,
  type AddOptionValueInput,
  type CreateOptionGroupInput,
  type UpdateOptionGroupInput,
  type UpdateOptionValueInput,
} from './catalogue.schema.js';
import type { OptionGroupView, OptionValueView } from './catalogue.types.js';
import { freeCode, suggestCode } from './sku.js';

// Option types (القصة، الزر، … القياس) and their values, with details up to three levels
// (ADR-008). Deactivated, never deleted.

const valueSelect = {
  id: true,
  parentId: true,
  valueAr: true,
  code: true,
  sortOrder: true,
  isActive: true,
} as const;

export function createOptionsService(db: Db) {
  return {
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
            await renumber(moved(siblings, id, data.move), async (siblingId, sortOrder) =>
              tx.optionGroup.update({ where: { id: siblingId }, data: { sortOrder } }),
            );
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
            (await tx.optionValue.findMany({ where: siblings, select: { code: true } })).map(
              (v) => v.code,
            ),
          );
          if (data.code && codes.has(data.code)) throw new OptionCodeTakenError(data.code);
          const value = await tx.optionValue.create({
            data: {
              groupId: data.groupId,
              parentId,
              valueAr: data.valueAr,
              // Without a code, a suggestion from the Arabic name, unique among its siblings.
              code: data.code ?? freeCode(suggestCode(data.valueAr), codes),
              sortOrder: (last._max.sortOrder ?? 0) + 10,
            },
            select: valueSelect,
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
     * Rename, recode, deactivate/restore, or move one place. A rename shows everywhere at once;
     * labels already printed keep the old text. A deactivated value is hidden from new products.
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
            await renumber(moved(siblings, id, data.move), async (siblingId, sortOrder) =>
              tx.optionValue.update({ where: { id: siblingId }, data: { sortOrder } }),
            );
          }
          const value = await tx.optionValue.update({
            where: { id },
            data: {
              ...(data.valueAr !== undefined ? { valueAr: data.valueAr } : {}),
              ...(data.code !== undefined ? { code: data.code } : {}),
              ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
            },
            select: valueSelect,
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
  };
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

/** Writes sort orders 10, 20, 30, … in the given order. */
export async function renumber(
  ids: readonly string[],
  write: (id: string, sortOrder: number) => Promise<unknown>,
): Promise<void> {
  for (const [i, id] of ids.entries()) await write(id, (i + 1) * 10);
}

export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
