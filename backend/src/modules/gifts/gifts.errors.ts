import { DomainError } from '../../shared/errors.js';

// Error codes are a public contract (docs/api.md). Adding is fine; renaming is breaking.

export class NotAGiftSessionError extends DomainError {
  constructor(sessionId: string, kind: string) {
    super('NOT_A_GIFT', 'Only a gift scan session is confirmed as a gift', { sessionId, kind });
  }
}
