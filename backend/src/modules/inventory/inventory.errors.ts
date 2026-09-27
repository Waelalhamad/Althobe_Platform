import type { LocationKind, MovementType } from '@prisma/client';
import { DomainError } from '../../shared/errors.js';

export class InsufficientStockError extends DomainError {
  constructor(details: {
    variantId: string;
    locationId: string;
    requested: number;
    quantity: number;
  }) {
    super('INSUFFICIENT_STOCK', 'Not enough stock', details);
  }
}

export class InsufficientAvailableStockError extends DomainError {
  constructor(details: {
    variantId: string;
    locationId: string;
    requested: number;
    quantity: number;
    reserved: number;
    available: number;
  }) {
    super('INSUFFICIENT_AVAILABLE_STOCK', 'Not enough unreserved stock available', details);
  }
}

export class MovementNotAllowedAtLocationError extends DomainError {
  constructor(details: {
    locationId: string;
    kind: LocationKind;
    movement: MovementType | 'RESERVATION';
  }) {
    super(
      'MOVEMENT_NOT_ALLOWED_AT_LOCATION',
      'This movement is not allowed at this location',
      details,
    );
  }
}

export class LocationInactiveError extends DomainError {
  constructor(locationId: string) {
    super('LOCATION_INACTIVE', 'Location is inactive', { locationId });
  }
}

export class VariantInactiveError extends DomainError {
  constructor(variantId: string) {
    super('VARIANT_INACTIVE', 'Variant or its product is inactive', { variantId });
  }
}

export class ReservationNotFoundError extends DomainError {
  constructor(reservationId: string) {
    super('RESERVATION_NOT_FOUND', 'No active reservation with this id', { reservationId });
  }
}

export class ScanSessionNotOpenError extends DomainError {
  constructor(sessionId: string, status: string) {
    super('SCAN_SESSION_NOT_OPEN', 'The scan session is not open', { sessionId, status });
  }
}

export class EmptyScanSessionError extends DomainError {
  constructor(sessionId: string) {
    super('SCAN_SESSION_EMPTY', 'The scan session has no quantities to commit', { sessionId });
  }
}

export class MissingCostError extends DomainError {
  constructor(sessionId: string, variantIds: string[]) {
    super('SCAN_SESSION_MISSING_COST', 'Every received line needs a unit cost', {
      sessionId,
      variantIds,
    });
  }
}

export class CostNotAllowedError extends DomainError {
  constructor(sessionId: string, kind: string) {
    super(
      'COST_NOT_ALLOWED',
      'Unit cost can only be set when receiving or counting opening stock',
      {
        sessionId,
        kind,
      },
    );
  }
}

export class OpeningAlreadyRecordedError extends DomainError {
  constructor(locationId: string, variantIds: string[]) {
    super(
      'OPENING_ALREADY_RECORDED',
      'Opening stock can be counted once per variant per location; use a stocktake to correct it',
      { locationId, variantIds },
    );
  }
}

export class StocktakeStateError extends DomainError {
  constructor(stocktakeId: string, status: string, expected: string[]) {
    super('STOCKTAKE_INVALID_STATE', 'The stocktake is not in the right state for this', {
      stocktakeId,
      status,
      expected,
    });
  }
}

export class UncountedLinesError extends DomainError {
  constructor(stocktakeId: string, variantIds: string[]) {
    super(
      'STOCKTAKE_UNCOUNTED_LINES',
      'Some lines were never counted; confirm them as zero or count them',
      {
        stocktakeId,
        variantIds,
      },
    );
  }
}

export class VariantNotInStocktakeError extends DomainError {
  constructor(stocktakeId: string, variantId: string) {
    super('STOCKTAKE_VARIANT_OUT_OF_SCOPE', 'This variant is not part of this partial stocktake', {
      stocktakeId,
      variantId,
    });
  }
}

export class SecondApproverRequiredError extends DomainError {
  constructor(stocktakeId: string) {
    super(
      'STOCKTAKE_SECOND_APPROVER_REQUIRED',
      'A stocktake must be applied by someone other than its creator',
      {
        stocktakeId,
      },
    );
  }
}
