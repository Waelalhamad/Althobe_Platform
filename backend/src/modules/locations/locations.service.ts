import type { LocationKind } from '@prisma/client';
import type { Db, Queryable } from '../../shared/db.js';
import { NotFoundError } from '../../shared/errors.js';
import { assertPermission, PERMISSIONS, type ActorContext } from '../../shared/permissions.js';

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

    // Trusted call for other modules, inside their already-authorised transaction.
    async locationsByIds(q: Queryable, ids: string[]): Promise<LocationView[]> {
      return q.location.findMany({ where: { id: { in: ids } }, select });
    },
  };
}

export type LocationsService = ReturnType<typeof createLocationsService>;
