import { DomainError } from '../../shared/errors.js';

// Error codes are a public contract (docs/api.md). Adding is fine; renaming is breaking.

export class NotAStoreError extends DomainError {
  constructor(locationId: string) {
    super('LOCATION_NOT_A_STORE', 'The point of sale runs only at a store', { locationId });
  }
}

export class ShiftAlreadyOpenError extends DomainError {
  constructor(shiftId: string) {
    super('SHIFT_ALREADY_OPEN', 'This store already has an open shift', { shiftId });
  }
}

export class ShiftNotOpenError extends DomainError {
  constructor(shiftId: string) {
    super('SHIFT_NOT_OPEN', 'The shift is not open', { shiftId });
  }
}

export class NoRetailPriceError extends DomainError {
  constructor(variantIds: string[]) {
    super('NO_RETAIL_PRICE', 'These pieces have no retail price in SYP yet', { variantIds });
  }
}

export class PaymentTooLowError extends DomainError {
  constructor(total: bigint, paid: bigint) {
    super('PAYMENT_TOO_LOW', 'What was paid does not cover the total', { total, paid });
  }
}

export class RefundTooLargeError extends DomainError {
  constructor(lineNo: number, remaining: number) {
    super('REFUND_EXCEEDS_SALE', 'More pieces than are left to refund on this line', {
      lineNo,
      remaining,
    });
  }
}

export class RateNotSetError extends DomainError {
  constructor(currency: string) {
    super('RATE_NOT_SET', 'No exchange rate is set for this currency', { currency });
  }
}

export class NotRefundableError extends DomainError {
  constructor(saleId: string) {
    super('NOT_REFUNDABLE', 'Only a sale can be refunded', { saleId });
  }
}
