import { DomainError } from '../../shared/errors.js';

// Error codes are a public contract (docs/api.md). Adding is fine; renaming is breaking.

export class PartyNotUsableError extends DomainError {
  constructor(partyId: string, reason: 'INACTIVE' | 'NOT_SUPPLIER' | 'NOT_CUSTOMER' | 'NOT_SYP') {
    super('PARTY_NOT_USABLE', 'This supplier or customer cannot be used here', {
      partyId,
      reason,
    });
  }
}

export class PartyCurrencyMismatchError extends DomainError {
  constructor(partyId: string, partyCurrency: string, found: string[]) {
    super('PARTY_CURRENCY_MISMATCH', "The goods' cost is not in this party's currency", {
      partyId,
      partyCurrency,
      found,
    });
  }
}

export class PartyCurrencyLockedError extends DomainError {
  constructor(partyId: string) {
    super('PARTY_CURRENCY_LOCKED', 'The currency cannot change once there are movements', {
      partyId,
    });
  }
}

export class WrongSessionKindError extends DomainError {
  constructor(sessionId: string, kind: string, expected: string) {
    super('WRONG_SESSION_KIND', 'This scan session is of another kind', {
      sessionId,
      kind,
      expected,
    });
  }
}

export class CashMustCoverGoodsError extends DomainError {
  constructor() {
    super(
      'CASH_MUST_COVER_GOODS',
      'Without a supplier, goods paid in cash are paid in full; name the supplier to owe the rest',
    );
  }
}

export class UnassignedTooSmallError extends DomainError {
  constructor(left: bigint, wanted: bigint) {
    super('UNASSIGNED_EXCEEDED', 'More than what is left without a name', { left, wanted });
  }
}
