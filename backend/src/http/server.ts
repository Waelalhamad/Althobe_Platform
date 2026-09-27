import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyRequest } from 'fastify';
import { DomainError } from '../shared/errors.js';
import type { WriteContext } from '../shared/permissions.js';
import type { Authenticated } from '../modules/auth/auth.service.js';
import type { Services } from '../services.js';
import { errorBody, isDomainError, statusFor } from './errors.js';
import { registerRoutes } from './routes.js';

export const SESSION_COOKIE = 'althobe_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: Authenticated | null;
  }
}

export interface ServerOptions {
  services: Services;
  /** Built warehouse app to serve from the same origin (production). */
  staticDir?: string;
  /** Secure cookies need HTTPS; off only for local development over http. */
  secureCookies: boolean;
  /** Running against the practice database; the app shows a banner. */
  practice?: boolean;
  logger?: boolean;
}

export async function buildServer(options: ServerOptions) {
  const app = Fastify({
    logger: options.logger
      ? { redact: ['req.headers.cookie', 'req.headers.authorization', 'body.password'] }
      : false,
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  // JSON has no bigint. Money and sequence numbers cross the wire as strings (docs/api.md).
  app.setReplySerializer((payload) =>
    JSON.stringify(payload, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    ),
  );

  await app.register(fastifyCookie);
  await app.register(fastifyRateLimit, { global: false });

  app.decorateRequest('auth', null);

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Frame-Options', 'DENY');
  });

  // Cookie auth + JSON-only writes: a cross-site form cannot send application/json without a CORS
  // preflight, which this API never grants. Together with sameSite=strict this closes CSRF.
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const isWrite = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const hasBody = Number(request.headers['content-length'] ?? 0) > 0;
    if (isWrite && hasBody && !request.headers['content-type']?.startsWith('application/json')) {
      return reply
        .code(415)
        .send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send JSON' } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (isDomainError(error)) return reply.code(statusFor(error)).send(errorBody(error));
    const status = (error as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply
        .code(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many attempts, wait a minute' } });
    }
    if (status && status >= 400 && status < 500) {
      return reply
        .code(status)
        .send({ error: { code: 'BAD_REQUEST', message: (error as Error).message } });
    }
    request.log.error(error);
    return reply
      .code(500)
      .send({ error: { code: 'INTERNAL', message: 'Unexpected server error' } });
  });

  app.get('/api/v1/mode', () => ({ data: { practice: options.practice ?? false } }));

  await app.register(
    async (api) => {
      await registerRoutes(api, {
        services: options.services,
        sessionCookie: SESSION_COOKIE,
        secureCookies: options.secureCookies,
      });
    },
    { prefix: '/api/v1' },
  );

  if (options.staticDir && existsSync(options.staticDir)) {
    await app.register(fastifyStatic, { root: options.staticDir });
    // Client-side routes: any non-API GET falls back to the SPA shell.
    app.setNotFoundHandler(async (request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/'))
        return reply.sendFile('index.html');
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });
  }

  return app;
}

/** The actor for this request, or 401. */
export function actorOf(request: FastifyRequest): Authenticated['actor'] {
  if (!request.auth) throw new Error('route is missing the authenticate preHandler');
  return request.auth.actor;
}

export class IdempotencyKeyRequiredError extends DomainError {
  constructor() {
    super('IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header (8–100 characters)');
  }
}

/** Direct stock writes carry the client's Idempotency-Key, so a retry never acts twice. */
export function writeContextOf(request: FastifyRequest): WriteContext {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw new IdempotencyKeyRequiredError();
  }
  return { ...actorOf(request), idempotencyKey: key };
}
