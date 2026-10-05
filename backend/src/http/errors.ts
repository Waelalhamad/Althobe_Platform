import { DomainError } from '../shared/errors.js';

// docs/api.md → status codes. A business rule saying "no" is 422, not 400: the request was
// well-formed; the business refused it.
const STATUS_BY_CODE: Record<string, number> = {
  VALIDATION_FAILED: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  NOT_AUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  PERMISSION_DENIED: 403,
  IDEMPOTENCY_KEY_REUSED: 409,
  PRODUCT_CODE_TAKEN: 409,
  EMAIL_TAKEN: 409,
  BARCODE_TAKEN: 409,
  OPTION_GROUP_TAKEN: 409,
  OPTION_VALUE_TAKEN: 409,
  SCAN_SESSION_NOT_OPEN: 409,
  STOCKTAKE_INVALID_STATE: 409,
  OPENING_ALREADY_RECORDED: 409,
};

export function statusFor(error: DomainError): number {
  return STATUS_BY_CODE[error.code] ?? (error.code.endsWith('_NOT_FOUND') ? 404 : 422);
}

export function errorBody(error: DomainError) {
  return { error: { code: error.code, message: error.message, details: error.details } };
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
