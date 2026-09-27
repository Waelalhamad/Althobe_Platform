import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Services } from '../services.js';
import { actorOf, writeContextOf } from './server.js';

interface RouteDeps {
  services: Services;
  sessionCookie: string;
  secureCookies: boolean;
}

type Params<T> = FastifyRequest<{ Params: T }>;

/**
 * /api/v1 — the Phase 2 thin slice (docs/api.md → Planned endpoints).
 * Handlers stay thin: authenticate, pass input to a service (which validates and authorises),
 * return its result. No business rule lives here. Bodies are passed on `as never` because every
 * service parses its own input with Zod — the service, not the route, is the validation boundary.
 */
export async function registerRoutes(api: FastifyInstance, deps: RouteDeps) {
  const { services: s } = deps;

  const authenticate = async (request: FastifyRequest) => {
    request.auth = await s.auth.authenticate(request.cookies[deps.sessionCookie]);
  };

  // ── Auth ───────────────────────────────────────────────────────────────────────────────────
  api.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token, expiresAt, user } = await s.auth.login(request.body as never, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      });
      void reply.setCookie(deps.sessionCookie, token, {
        path: '/',
        httpOnly: true,
        secure: deps.secureCookies,
        sameSite: 'strict',
        expires: expiresAt,
      });
      return { data: user };
    },
  );

  api.post('/auth/logout', async (request, reply) => {
    await s.auth.logout(request.cookies[deps.sessionCookie]);
    void reply.clearCookie(deps.sessionCookie, { path: '/' });
    return { data: { ok: true } };
  });

  // Everything below requires a session.
  await api.register((priv, _options, done) => {
    priv.addHook('preHandler', authenticate);

    priv.get('/auth/me', (request, reply) => reply.send({ data: request.auth!.user }));

    priv.post('/auth/change-password', async (request) => {
      await s.auth.changeOwnPassword(
        request.body as never,
        actorOf(request),
        request.cookies[deps.sessionCookie] ?? '',
      );
      return { data: { ok: true } };
    });

    // ── Accounts (owner only; the service checks admin.users.write) ─────────────────────────
    priv.get('/users', async (request) => ({ data: await s.auth.listUsers(actorOf(request)) }));

    priv.post('/users', async (request) => ({
      data: await s.auth.adminCreateUser(request.body as never, actorOf(request)),
    }));

    priv.patch('/users/:id', async (request: Params<{ id: string }>) => ({
      data: await s.auth.updateUser(request.params.id, request.body as never, actorOf(request)),
    }));

    priv.post('/users/:id/reset-password', async (request: Params<{ id: string }>) => ({
      data: await s.auth.resetPassword(request.params.id, actorOf(request)),
    }));

    // ── Locations & catalogue ────────────────────────────────────────────────────────────────
    priv.get('/locations', async (request) => ({
      data: await s.locations.listLocations(actorOf(request)),
    }));

    priv.get('/products', async (request) => ({
      data: await s.catalogue.listProducts(actorOf(request)),
    }));

    priv.post('/products', async (request) => ({
      data: await s.catalogue.createProduct(request.body as never, actorOf(request)),
    }));

    priv.post('/products/:id/variants/generate', async (request: Params<{ id: string }>) => ({
      data: await s.catalogue.generateVariants(
        { ...(request.body as object), productId: request.params.id } as never,
        actorOf(request),
      ),
    }));

    priv.get(
      '/variants',
      async (
        request: FastifyRequest<{
          Querystring: { q?: string; productId?: string; limit?: string };
        }>,
      ) => {
        const { q, productId, limit } = request.query;
        return {
          data: await s.catalogue.searchVariants(
            { q, productId, limit: limit ? Number(limit) : undefined },
            actorOf(request),
          ),
        };
      },
    );

    priv.get('/barcodes/:code', async (request: Params<{ code: string }>) => ({
      data: await s.inventory.resolveBarcode(request.params.code, actorOf(request)),
    }));

    // ── Inventory reads ──────────────────────────────────────────────────────────────────────
    priv.get(
      '/inventory/balances',
      async (
        request: FastifyRequest<{ Querystring: { locationId?: string; inStockOnly?: string } }>,
      ) => ({
        data: await s.inventory.listBalances(
          {
            locationId: request.query.locationId as string,
            inStockOnly: request.query.inStockOnly === 'true',
            limit: 500,
          },
          actorOf(request),
        ),
      }),
    );

    priv.get(
      '/inventory/movements',
      async (
        request: FastifyRequest<{
          Querystring: { variantId?: string; locationId?: string; beforeSeq?: string };
        }>,
      ) => {
        const { variantId, locationId, beforeSeq } = request.query;
        const rows = await s.inventory.getMovementHistory(
          {
            variantId,
            locationId,
            beforeSeq: beforeSeq && /^\d+$/.test(beforeSeq) ? BigInt(beforeSeq) : undefined,
          },
          actorOf(request),
        );
        const names = await s.auth.displayNames(rows.map((r) => r.movement.createdById));
        return {
          data: rows.map((r) => ({ ...r, createdByName: names[r.movement.createdById] ?? null })),
        };
      },
    );

    priv.get('/inventory/summary', async (request) => ({
      data: await s.inventory.stockSummary(actorOf(request)),
    }));

    // Corrections that are not counts (counts go through a stocktake). Requires Idempotency-Key.
    priv.post('/inventory/adjustments', async (request) => ({
      data: await s.inventory.adjustStock(request.body as never, writeContextOf(request)),
    }));

    // ── Scan sessions ────────────────────────────────────────────────────────────────────────
    priv.get(
      '/scan-sessions',
      async (request: FastifyRequest<{ Querystring: { locationId?: string } }>) => ({
        data: await s.scanSessions.listOpenSessions(
          { locationId: request.query.locationId },
          actorOf(request),
        ),
      }),
    );

    priv.post('/scan-sessions', async (request) => ({
      data: await s.scanSessions.openSession(request.body as never, actorOf(request)),
    }));

    priv.get('/scan-sessions/:id', async (request: Params<{ id: string }>) => ({
      data: await s.scanSessions.getSession({ sessionId: request.params.id }, actorOf(request)),
    }));

    priv.post('/scan-sessions/:id/scans', async (request: Params<{ id: string }>) => ({
      data: await s.scanSessions.scan(
        { ...(request.body as object), sessionId: request.params.id } as never,
        actorOf(request),
      ),
    }));

    // Quantity override and/or cost for one line.
    priv.patch(
      '/scan-sessions/:id/lines/:variantId',
      async (request: Params<{ id: string; variantId: string }>) => {
        const body = (request.body ?? {}) as { quantity?: unknown; unitCost?: unknown };
        const ref = { sessionId: request.params.id, variantId: request.params.variantId };
        let line;
        if (body.quantity !== undefined) {
          line = await s.scanSessions.setLineQuantity(
            { ...ref, quantity: body.quantity } as never,
            actorOf(request),
          );
        }
        if (body.unitCost !== undefined) {
          line = await s.scanSessions.setLineCost(
            { ...ref, unitCost: body.unitCost } as never,
            actorOf(request),
          );
        }
        return { data: line ?? null };
      },
    );

    priv.delete(
      '/scan-sessions/:id/lines/:variantId',
      async (request: Params<{ id: string; variantId: string }>) => {
        await s.scanSessions.removeLine(
          { sessionId: request.params.id, variantId: request.params.variantId },
          actorOf(request),
        );
        return { data: { ok: true } };
      },
    );

    priv.post('/scan-sessions/:id/commit', async (request: Params<{ id: string }>) => ({
      data: await s.scanSessions.commitSession({ sessionId: request.params.id }, actorOf(request)),
    }));

    priv.post('/scan-sessions/:id/cancel', async (request: Params<{ id: string }>) => {
      await s.scanSessions.cancelSession({ sessionId: request.params.id }, actorOf(request));
      return { data: { ok: true } };
    });

    // ── Stocktakes (docs/inventory.md → Stocktake) ───────────────────────────────────────────
    const st = s.stocktakes;
    type StParams = Params<{ id: string }>;

    priv.get(
      '/stocktakes',
      async (request: FastifyRequest<{ Querystring: { locationId?: string } }>) => ({
        data: await st.listStocktakes({ locationId: request.query.locationId }, actorOf(request)),
      }),
    );

    priv.post('/stocktakes', async (request) => ({
      data: await st.createStocktake(request.body as never, actorOf(request)),
    }));

    priv.get('/stocktakes/:id', async (request: StParams) => ({
      data: await st.getStocktake({ stocktakeId: request.params.id }, actorOf(request)),
    }));

    priv.post('/stocktakes/:id/start', async (request: StParams) => ({
      data: await st.startCounting({ stocktakeId: request.params.id }, actorOf(request)),
    }));

    priv.post('/stocktakes/:id/scans', async (request: StParams) => ({
      data: await st.scanCount(
        { ...(request.body as object), stocktakeId: request.params.id } as never,
        actorOf(request),
      ),
    }));

    priv.patch(
      '/stocktakes/:id/lines/:variantId',
      async (request: Params<{ id: string; variantId: string }>) => ({
        data: await st.setCount(
          {
            ...(request.body as object),
            stocktakeId: request.params.id,
            variantId: request.params.variantId,
          } as never,
          actorOf(request),
        ),
      }),
    );

    priv.post('/stocktakes/:id/review', async (request: StParams) => ({
      data: await st.submitForReview(
        { ...(request.body ?? {}), stocktakeId: request.params.id },
        actorOf(request),
      ),
    }));

    priv.post('/stocktakes/:id/apply', async (request: StParams) => ({
      data: await st.applyStocktake({ stocktakeId: request.params.id }, actorOf(request)),
    }));

    priv.post('/stocktakes/:id/cancel', async (request: StParams) => {
      await st.cancelStocktake({ stocktakeId: request.params.id }, actorOf(request));
      return { data: { ok: true } };
    });
    done();
  });
}
