import type { LocationKind } from '@prisma/client';
import { z } from 'zod';
import { writeAudit } from '../../shared/audit.js';
import { inTransaction, type Db, type Queryable } from '../../shared/db.js';
import { DomainError, NotFoundError } from '../../shared/errors.js';
import {
  assertPermission,
  PERMISSIONS,
  type ActorContext,
  type BranchCode,
} from '../../shared/permissions.js';
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
  /** SY · LY; null for the road between branches (TRANSIT). */
  branch: BranchCode | null;
  isActive: boolean;
}

const select = {
  id: true,
  code: true,
  nameAr: true,
  nameEn: true,
  kind: true,
  branch: true,
  isActive: true,
} as const;

export class LocationOutOfBranchError extends DomainError {
  constructor(locationId: string, branch: string) {
    super('LOCATION_OUT_OF_BRANCH', 'This location is in another branch', { locationId, branch });
  }
}

/**
 * F-04: whether the actor may work at this location. A user kept to a branch works only at its
 * locations; the road between branches (no branch) is reached only through a shipment.
 */
export function inBranch(ctx: ActorContext, location: { branch: string | null }): boolean {
  return !ctx.branch || location.branch === null || location.branch === ctx.branch;
}

const view = (row: Omit<LocationView, 'branch'> & { branch: string | null }): LocationView => ({
  ...row,
  branch: row.branch as BranchCode | null,
});

export function createLocationsService(db: Db) {
  return {
    /**
     * Warehouses first, then the store (enum declaration order), then by code. The road between
     * branches is not a place anyone works at, so it is not listed. `mine`: where this actor
     * works (F-04); the other branch's locations are listed as destinations of a shipment.
     */
    async listLocations(ctx: ActorContext): Promise<(LocationView & { mine: boolean })[]> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const rows = await db.location.findMany({
        where: { kind: { not: 'TRANSIT' } },
        select,
        orderBy: [{ kind: 'asc' }, { code: 'asc' }],
      });
      return rows.map((r) => ({ ...view(r), mine: inBranch(ctx, r) }));
    },

    async getLocation(id: string, ctx: ActorContext): Promise<LocationView> {
      assertPermission(ctx, PERMISSIONS.inventory.view);
      const location = await db.location.findUnique({ where: { id }, select });
      if (!location) throw new NotFoundError('location', id);
      return view(location);
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
        return view(after);
      });
    },

    // Trusted call for other modules, inside their already-authorised transaction.
    async locationsByIds(q: Queryable, ids: string[]): Promise<LocationView[]> {
      return (await q.location.findMany({ where: { id: { in: ids } }, select })).map(view);
    },

    /** Trusted call: every location, for accounting's per-location inventory accounts. */
    async allLocations(q: Queryable): Promise<LocationView[]> {
      return (
        await q.location.findMany({ select, orderBy: [{ kind: 'asc' }, { code: 'asc' }] })
      ).map(view);
    },

    /** Trusted call (F-04): the road between branches, where shipments travel. */
    async transitLocation(q: Queryable): Promise<LocationView> {
      const row = await q.location.findFirst({ where: { kind: 'TRANSIT' }, select });
      if (!row) throw new NotFoundError('location', 'TRANSIT');
      return view(row);
    },

    /**
     * Trusted call (F-04): the locations this actor works at, or null for every one. Reads of
     * stock are kept to them.
     */
    async branchLocationIds(q: Queryable, ctx: ActorContext): Promise<string[] | null> {
      if (!ctx.branch) return null;
      const rows = await q.location.findMany({
        where: { branch: ctx.branch },
        select: { id: true },
      });
      return rows.map((r) => r.id);
    },

    /** Trusted call (F-04): refuses a location in another branch. */
    async assertInBranch(q: Queryable, ctx: ActorContext, locationId: string): Promise<void> {
      if (!ctx.branch) return;
      const row = await q.location.findUnique({ where: { id: locationId }, select });
      if (!row) throw new NotFoundError('location', locationId);
      if (!inBranch(ctx, row)) throw new LocationOutOfBranchError(locationId, row.branch ?? '');
    },
  };
}

export type LocationsService = ReturnType<typeof createLocationsService>;
