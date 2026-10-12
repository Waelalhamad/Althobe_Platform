import type { LocationKind } from '@prisma/client';
import { z } from 'zod';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Queryable } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';
import { parse } from '../../shared/validation.js';

/** Only the names change: the code and kind stay, and so does every movement's location. */
export const updateLocationSchema = z
  .object({
    nameAr: z.string().trim().min(1).max(80).optional(),
    nameEn: z.string().trim().max(80).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

export interface LocationView {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  kind: LocationKind;
  isActive: boolean;
}

const select = {
  id: true,
  code: true,
  nameAr: true,
  nameEn: true,
  kind: true,
  isActive: true,
} as const;

export function createLocationsService(db: Db) {
  return {
    async listLocations(ctx: ActorContext): Promise<LocationView[]> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      // Warehouses first, then the store (enum declaration order), then by code.
      return db.location.findMany({ select, orderBy: [{ kind: 'asc' }, { code: 'asc' }] });
    },

    async getLocation(id: string, ctx: ActorContext): Promise<LocationView> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const location = await db.location.findUnique({ where: { id }, select });
      if (!location) throw new NotFoundError('location', id);
      return location;
    },

    async updateLocation(
      id: string,
      input: z.input<typeof updateLocationSchema>,
      ctx: ActorContext,
    ): Promise<LocationView> {
      assertPermission(ctx, PERMISSIONS.admin.locations);
      const data = parse(updateLocationSchema, input);
      return inTransaction(db, async (tx) => {
        const before = await tx.location.findUnique({ where: { id }, select });
        if (!before) throw new NotFoundError('location', id);
        const after = await tx.location.update({
          where: { id },
          data: {
            ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
            ...(data.nameEn !== undefined ? { nameEn: data.nameEn || null } : {}),
          },
          select,
        });
        await writeAudit(tx, {
          actorId: ctx.userId,
          action: 'locations.update',
          entityType: 'location',
          entityId: id,
          before: { nameAr: before.nameAr, nameEn: before.nameEn },
          after: { nameAr: after.nameAr, nameEn: after.nameEn },
        });
        return after;
      });
    },

    // Trusted call for other modules, inside their already-authorised transaction.
    async locationsByIds(q: Queryable, ids: string[]): Promise<LocationView[]> {
      return q.location.findMany({ where: { id: { in: ids } }, select });
    },
  };
}

export type LocationsService = ReturnType<typeof createLocationsService>;
