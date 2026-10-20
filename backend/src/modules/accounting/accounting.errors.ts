import { DomainError } from '../../shared/errors.js';

// Error codes are a public contract (docs/api.md). Adding is fine; renaming is breaking.

export class PeriodClosedError extends DomainError {
  constructor(date: string, closedThrough: string) {
    super('PERIOD_CLOSED', 'That month is closed; nothing can be dated in it any more', {
      date,
      closedThrough,
    });
  }
}

export class DateInFutureError extends DomainError {
  constructor(date: string) {
    super('DATE_IN_FUTURE', 'An entry cannot be dated after today', { date });
  }
}

export class RateNotSetError extends DomainError {
  constructor(currency: string) {
    super('RATE_NOT_SET', 'No exchange rate is set for this currency', { currency });
  }
}

export class AccountNotUsableError extends DomainError {
  constructor(
    accountId: string,
    reason:
      'HEADING' | 'INACTIVE' | 'NOT_CASH' | 'INVENTORY' | 'SAME_ACCOUNT' | 'IS_CASH' | 'PAYROLL',
  ) {
    super('ACCOUNT_NOT_USABLE', 'This account cannot be used here', { accountId, reason });
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(details: Record<string, unknown>) {
    super('CURRENCY_MISMATCH', 'The accounts are in different currencies', details);
  }
}

export class EntryNotBalancedError extends DomainError {
  constructor(totalBase: bigint) {
    super('ENTRY_NOT_BALANCED', 'Debits must equal credits', { totalBase });
  }
}

export class AmountTooSmallError extends DomainError {
  constructor() {
    super('AMOUNT_TOO_SMALL', 'The amount is worth less than one cent');
  }
}

export class EntryNotReversibleError extends DomainError {
  constructor(entryId: string, reason: 'SYSTEM' | 'ALREADY_REVERSED' | 'IS_REVERSAL') {
    super('ENTRY_NOT_REVERSIBLE', 'This entry cannot be reversed', { entryId, reason });
  }
}

export class PeriodNotClosableError extends DomainError {
  constructor(period: string, next: string | null) {
    super('PERIOD_NOT_CLOSABLE', 'Months are closed in order, once they have ended', {
      period,
      next,
    });
  }
}

export class SystemAccountError extends DomainError {
  constructor(accountId: string) {
    super('ACCOUNT_IS_SYSTEM', 'This account is used by the system and stays active', {
      accountId,
    });
  }
}
