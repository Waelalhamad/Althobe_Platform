import { DomainError } from '../../shared/errors.js';

// Error codes are a public contract (docs/api.md). Adding is fine; renaming is breaking.

export class PayrollPeriodTakenError extends DomainError {
  constructor(runId: string) {
    super('PAYROLL_PERIOD_TAKEN', 'There is already a pay sheet for this period', { runId });
  }
}

export class NoEmployeesError extends DomainError {
  constructor(frequency: string) {
    super('NO_EMPLOYEES', 'No active employee is paid at this frequency', { frequency });
  }
}

export class RunNotDraftError extends DomainError {
  constructor(runId: string, status: string) {
    super('PAYROLL_NOT_DRAFT', 'Only a draft pay sheet can be changed or approved', {
      runId,
      status,
    });
  }
}

export class RunNotApprovedError extends DomainError {
  constructor(runId: string, status: string) {
    super('PAYROLL_NOT_APPROVED', 'Only an approved pay sheet can be paid', { runId, status });
  }
}

export class RunHasPaymentsError extends DomainError {
  constructor(runId: string) {
    super('PAYROLL_HAS_PAYMENTS', 'Someone on this pay sheet was already paid', { runId });
  }
}

export class NothingToPayError extends DomainError {
  constructor(runId: string, currency: string) {
    super('NOTHING_TO_PAY', 'Nobody on this sheet is still owed pay in this currency', {
      runId,
      currency,
    });
  }
}

export class AdvanceExceedsBalanceError extends DomainError {
  constructor(employeeId: string, balance: bigint, wanted: bigint) {
    super('ADVANCE_EXCEEDS_BALANCE', 'More than the employee still owes in advances', {
      employeeId,
      balance,
      wanted,
    });
  }
}

export class PayTooLowError extends DomainError {
  constructor(employeeId: string) {
    super('PAY_BELOW_ZERO', 'Deductions and advances cannot exceed the pay', { employeeId });
  }
}

export class EmployeeCurrencyLockedError extends DomainError {
  constructor(employeeId: string) {
    super(
      'EMPLOYEE_CURRENCY_LOCKED',
      'The salary currency cannot change once the employee has advances or pay sheets',
      { employeeId },
    );
  }
}
