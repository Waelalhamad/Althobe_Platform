// Every business rejection is a DomainError with a stable, SCREAMING_SNAKE_CASE code.
// Clients switch on `code`, never on `message` (docs/api.md). Phase 2 maps codes to HTTP status.

export type ErrorDetails = Record<string, unknown>;

export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: ErrorDetails = {},
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(issues: { path: string; message: string }[]) {
    super('VALIDATION_FAILED', 'The request is not valid', { issues });
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id: string) {
    super(`${entity.toUpperCase()}_NOT_FOUND`, `${entity} not found`, { id });
  }
}

export class PermissionDeniedError extends DomainError {
  constructor(permission: string) {
    super('PERMISSION_DENIED', `Missing permission: ${permission}`, { permission });
  }
}

export class IdempotencyKeyReusedError extends DomainError {
  constructor(key: string, operation: string) {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      'This idempotency key was already used for a different request',
      { key, operation },
    );
  }
}
