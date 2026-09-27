import type { z } from 'zod';
import { ValidationError } from './errors.js';

// Services parse their own input: in Phase 1 the service *is* the boundary, and in Phase 2 the
// HTTP layer reuses the same schemas.
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}
