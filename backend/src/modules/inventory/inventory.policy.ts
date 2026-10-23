import type { LocationKind, MovementType } from '@prisma/client';

// docs/inventory.md → "Movement policy by location kind". The single place this rule lives.
// The store is stocked by transfer, never straight from a supplier, and retail does not reserve.

const ALL_MOVEMENTS: readonly MovementType[] = [
  'OPENING',
  'PURCHASE',
  'SALE',
  'RETURN',
  'TRANSFER_OUT',
  'TRANSFER_IN',
  'ADJUSTMENT',
  'DAMAGE',
  'STOCKTAKE',
  'RECEIPT_CORRECTION',
  'GIFT',
];

const ALLOWED_MOVEMENTS: Record<LocationKind, ReadonlySet<MovementType>> = {
  WAREHOUSE: new Set(ALL_MOVEMENTS),
  // Receipts (and so their corrections) happen at warehouses only.
  STORE: new Set(
    ALL_MOVEMENTS.filter((type) => type !== 'PURCHASE' && type !== 'RECEIPT_CORRECTION'),
  ),
  // The road between branches (F-04): shipments pass through it, and what never arrives is
  // lost from it. Nothing else happens there.
  TRANSIT: new Set(['TRANSFER_OUT', 'TRANSFER_IN', 'SHIPPING_LOSS']),
};

const RESERVATIONS_ALLOWED: ReadonlySet<LocationKind> = new Set(['WAREHOUSE']);

export function isMovementAllowed(kind: LocationKind, type: MovementType): boolean {
  return ALLOWED_MOVEMENTS[kind].has(type);
}

export function areReservationsAllowed(kind: LocationKind): boolean {
  return RESERVATIONS_ALLOWED.has(kind);
}
