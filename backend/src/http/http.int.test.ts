import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestContext, stock, type World } from '../../test/helpers.js';
import { buildServer, SESSION_COOKIE } from './server.js';

// The Phase 2 API, end to end in-process: cookies, status codes, and the opening-count flow.

const t = createTestContext();
let app: FastifyInstance;
let w: World;
const PASSWORD = 'correct-horse-battery-staple';

beforeAll(async () => {
  app = await buildServer({ services: t.services, secureCookies: false });
});
beforeEach(async () => {
  w = await t.reset();
  await t.services.auth.createUser({
    email: 'keeper@test.local',
    nameAr: 'أمين المستودع',
    roles: ['warehouse_keeper'],
    password: PASSWORD,
  });
  await t.services.auth.createUser({
    email: 'shop@test.local',
    nameAr: 'موظف المتجر',
    roles: ['store_staff'],
    password: PASSWORD,
  });
  await t.services.auth.createUser({
    email: 'boss@test.local',
    nameAr: 'صاحب المحل',
    roles: ['owner'],
    password: PASSWORD,
  });
  await t.services.auth.createUser({
    email: 'manager@test.local',
    nameAr: 'مدير المخزون',
    roles: ['inventory_manager'],
    password: PASSWORD,
  });
});
afterAll(async () => {
  await app.close();
  await t.close();
});

interface Body<T> {
  data: T;
  error?: { code: string };
}
const dataOf = <T>(res: { json: <R>() => R }) => res.json<Body<T>>().data;

async function login(email: string, password = PASSWORD) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  });
  const cookie = res.cookies.find((c) => c.name === SESSION_COOKIE);
  return { res, cookie, headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie.value}` } : {} };
}

describe('health', () => {
  it('answers 200 without a login when the database is reachable', async () => {
    const healthy = await buildServer({
      services: t.services,
      secureCookies: false,
      checkHealth: async () => {
        await Promise.resolve();
      },
    });
    const res = await healthy.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(200);
    expect(dataOf<{ ok: boolean }>(res)).toEqual({ ok: true });
    await healthy.close();
  });

  it('answers 503 when the database is unreachable', async () => {
    const broken = await buildServer({
      services: t.services,
      secureCookies: false,
      checkHealth: async () => {
        await Promise.reject(new Error('down'));
      },
    });
    const res = await broken.inject({ method: 'GET', url: '/api/v1/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json<Body<never>>().error?.code).toBe('UNAVAILABLE');
    await broken.close();
  });
});

describe('auth', () => {
  it('rejects a wrong password and an unknown email identically', async () => {
    const wrong = await login('keeper@test.local', 'nope-nope-nope');
    const unknown = await login('nobody@test.local');
    for (const { res, cookie } of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: { code: 'INVALID_CREDENTIALS' } });
      expect(cookie).toBeUndefined();
    }
  });

  it('sets an httpOnly, SameSite=Strict session cookie; logout revokes it server-side', async () => {
    const { res, cookie, headers } = await login('KEEPER@test.local'); // email is case-insensitive
    expect(res.statusCode).toBe(200);
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
    expect(dataOf<{ permissions: string[] }>(res).permissions).toContain('inventory.receive');
    expect(dataOf<{ permissions: string[] }>(res).permissions).not.toContain('inventory.cost.view');

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(dataOf<{ email: string }>(me).email).toBe('keeper@test.local');

    // Never send anything password-related to the browser (a spread once leaked the hash).
    for (const body of [res.body, me.body]) expect(body).not.toMatch(/password/i);

    await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(after.statusCode).toBe(401);
  });

  it('requires a session for everything but login', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/locations' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'NOT_AUTHENTICATED' } });
  });

  it('refuses non-JSON writes (CSRF defence)', async () => {
    const { headers } = await login('keeper@test.local');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/scan-sessions',
      headers: { ...headers, 'content-type': 'text/plain' },
      payload: 'kind=OPENING',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('opening count over HTTP — the first real use', () => {
  it('scan, override, commit, and see the balance', async () => {
    const { headers } = await login('keeper@test.local');
    const post = async (url: string, payload: object = {}) =>
      app.inject({ method: 'POST', url: `/api/v1${url}`, headers, payload });

    const opened = await post('/scan-sessions', { kind: 'OPENING', locationId: w.wh1.id });
    expect(opened.statusCode).toBe(200);
    const sessionId = dataOf<{ id: string }>(opened).id;

    const scanId = randomUUID();
    await post(`/scan-sessions/${sessionId}/scans`, { barcode: w.x.barcode, scanId });
    const dup = await post(`/scan-sessions/${sessionId}/scans`, { barcode: w.x.barcode, scanId });
    expect(dataOf(dup)).toMatchObject({ duplicate: true, line: { quantity: 1 } });
    await post(`/scan-sessions/${sessionId}/scans`, { barcode: w.x.barcode, scanId: randomUUID() });

    const unknown = await post(`/scan-sessions/${sessionId}/scans`, {
      barcode: '2009999999997',
      scanId: randomUUID(),
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ error: { code: 'BARCODE_NOT_FOUND' } });

    await post(`/scan-sessions/${sessionId}/scans`, { barcode: w.y.barcode, scanId: randomUUID() });
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/scan-sessions/${sessionId}/lines/${w.y.id}`,
      headers,
      payload: { quantity: 20 },
    });
    expect(dataOf<{ quantity: number }>(patched).quantity).toBe(20);

    const committed = await post(`/scan-sessions/${sessionId}/commit`);
    expect(committed.statusCode).toBe(200);
    const { movements } = dataOf<{ movements: { type: string; quantity: number; seq: string }[] }>(
      committed,
    );
    expect(movements.map((m) => [m.type, m.quantity])).toEqual([
      ['OPENING', 2],
      ['OPENING', 20],
    ]);
    expect(typeof movements[0]!.seq).toBe('string'); // bigint crosses the wire as a string

    const balances = await app.inject({
      method: 'GET',
      url: `/api/v1/inventory/balances?locationId=${w.wh1.id}`,
      headers,
    });
    const rows =
      dataOf<
        { variant: { id: string }; balance: { quantity: number; valueBaseAmount: unknown } }[]
      >(balances);
    expect(rows.find((r) => r.variant.id === w.x.id)?.balance).toMatchObject({
      quantity: 2,
      valueBaseAmount: null,
    });

    // Committing again returns the original result; a second opening count is a conflict.
    expect((await post(`/scan-sessions/${sessionId}/commit`)).statusCode).toBe(200);
    const second = await post('/scan-sessions', { kind: 'OPENING', locationId: w.wh1.id });
    const secondId = dataOf<{ id: string }>(second).id;
    await post(`/scan-sessions/${secondId}/scans`, { barcode: w.x.barcode, scanId: randomUUID() });
    const conflict = await post(`/scan-sessions/${secondId}/commit`);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: 'OPENING_ALREADY_RECORDED' } });
  });

  it('store staff cannot receive (403); business refusals are 422', async () => {
    const shop = await login('shop@test.local');
    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/scan-sessions',
      headers: shop.headers,
      payload: { kind: 'OPENING', locationId: w.store.id },
    });
    expect(denied.statusCode).toBe(403);

    // Until the POS exists, store staff record the store's own sales.
    const sale = await app.inject({
      method: 'POST',
      url: '/api/v1/scan-sessions',
      headers: shop.headers,
      payload: { kind: 'SALE', locationId: w.store.id, note: 'زبون' },
    });
    expect(sale.statusCode).toBe(200);

    const keeper = await login('keeper@test.local');
    const refused = await app.inject({
      method: 'POST',
      url: '/api/v1/scan-sessions',
      headers: keeper.headers,
      payload: { kind: 'RECEIVE', locationId: w.store.id },
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { code: 'MOVEMENT_NOT_ALLOWED_AT_LOCATION' } });
  });
});

describe('stocktake over HTTP — counted by one person, approved by another', () => {
  it('blind count by the keeper, applied by the inventory manager', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    const keeper = await login('keeper@test.local');
    const manager = await login('manager@test.local');
    const call = async (
      who: typeof keeper,
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      payload?: object,
    ) =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers: who.headers,
        ...(payload ? { payload } : {}),
      });

    const created = await call(keeper, 'POST', '/stocktakes', {
      locationId: w.wh1.id,
      scope: 'FULL',
    });
    expect(created.statusCode).toBe(200);
    const id = dataOf<{ id: string }>(created).id;

    const started = await call(keeper, 'POST', `/stocktakes/${id}/start`);
    expect(dataOf<{ status: string }>(started).status).toBe('COUNTING');

    await call(keeper, 'POST', `/stocktakes/${id}/scans`, {
      barcode: w.x.barcode,
      scanId: randomUUID(),
    });
    const set = await call(keeper, 'PATCH', `/stocktakes/${id}/lines/${w.x.id}`, {
      countedQuantity: 8,
    });
    expect(set.statusCode).toBe(200);

    const reviewed = await call(keeper, 'POST', `/stocktakes/${id}/review`, {});
    expect(dataOf<{ status: string }>(reviewed).status).toBe('REVIEW');

    // The keeper counts but cannot approve.
    const denied = await call(keeper, 'POST', `/stocktakes/${id}/apply`);
    expect(denied.statusCode).toBe(403);

    const applied = await call(manager, 'POST', `/stocktakes/${id}/apply`);
    expect(applied.statusCode).toBe(200);
    expect(
      dataOf<{ movements: { type: string; quantity: number }[] }>(applied).movements,
    ).toMatchObject([{ type: 'STOCKTAKE', quantity: -2 }]);

    const list = await call(manager, 'GET', `/stocktakes?locationId=${w.wh1.id}`);
    expect(dataOf<{ id: string; status: string }[]>(list)).toMatchObject([
      { id, status: 'APPLIED' },
    ]);
  });
});

type Who = Awaited<ReturnType<typeof login>>;
const call = async (
  who: Who,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: object,
  extra?: object,
) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { ...who.headers, ...extra },
    ...(payload ? { payload } : {}),
  });

describe('accounts over HTTP (owner only)', () => {
  it('create → first login → change own password; lockout protection; deactivation is immediate', async () => {
    const owner = await login('boss@test.local');

    const created = await call(owner, 'POST', '/users', {
      email: 'new.keeper@test.local',
      nameAr: 'موظف جديد',
      roles: ['warehouse_keeper'],
    });
    expect(created.statusCode).toBe(200);
    const { user, password } = dataOf<{ user: { id: string }; password: string }>(created);
    expect(password.length).toBeGreaterThanOrEqual(12);

    const first = await login('new.keeper@test.local', password);
    expect(first.res.statusCode).toBe(200);
    const changed = await call(first, 'POST', '/auth/change-password', {
      currentPassword: password,
      newPassword: 'a-brand-new-password-1',
    });
    expect(changed.statusCode).toBe(200);
    expect((await login('new.keeper@test.local', password)).res.statusCode).toBe(401);
    const again = await login('new.keeper@test.local', 'a-brand-new-password-1');
    expect(again.res.statusCode).toBe(200);

    // The owner cannot lock themselves out; a manager cannot manage accounts at all.
    const me = dataOf<{ id: string }>(await call(owner, 'GET', '/auth/me'));
    const self = await call(owner, 'PATCH', `/users/${me.id}`, { isActive: false });
    expect(self.statusCode).toBe(422);
    expect(self.json()).toMatchObject({ error: { code: 'LOCKOUT_PREVENTED' } });
    const manager = await login('manager@test.local');
    expect((await call(manager, 'GET', '/users')).statusCode).toBe(403);

    // Deactivation ends the person's sessions now, not at their next login.
    await call(owner, 'PATCH', `/users/${user.id}`, { isActive: false });
    expect((await call(again, 'GET', '/auth/me')).statusCode).toBe(401);
  });
});

describe('adjustments, history and summary over HTTP', () => {
  it('adjusts once per key, and the history says who did it and why', async () => {
    await stock(t.services, w, w.x, w.wh1, 10);
    const owner = await login('boss@test.local');
    const body = {
      variantId: w.x.id,
      locationId: w.wh1.id,
      delta: -2,
      reason: 'وُجدت قطعتان مع صنف آخر',
    };

    const noKey = await call(owner, 'POST', '/inventory/adjustments', body);
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });

    const key = { 'idempotency-key': randomUUID() };
    expect((await call(owner, 'POST', '/inventory/adjustments', body, key)).statusCode).toBe(200);
    expect((await call(owner, 'POST', '/inventory/adjustments', body, key)).statusCode).toBe(200);
    expect(await t.db.inventoryMovement.count({ where: { type: 'ADJUSTMENT' } })).toBe(1);

    const history = dataOf<
      {
        movement: { type: string; quantity: number; reason: string | null };
        variant: { id: string };
        createdByName: string;
      }[]
    >(await call(owner, 'GET', `/inventory/movements?variantId=${w.x.id}`));
    expect(history[0]).toMatchObject({
      movement: { type: 'ADJUSTMENT', quantity: -2, reason: body.reason },
      variant: { id: w.x.id },
      createdByName: 'صاحب المحل',
    });
    expect(history[1]).toMatchObject({ movement: { type: 'PURCHASE', quantity: 10 } });

    const summary = dataOf<
      { locationId: string; quantity: number; valueBaseAmount: string | null }[]
    >(await call(owner, 'GET', '/inventory/summary'));
    expect(summary).toMatchObject([{ locationId: w.wh1.id, quantity: 8 }]);
    expect(summary[0]!.valueBaseAmount).not.toBeNull();

    // Store staff see quantities, never value.
    const shop = await login('shop@test.local');
    const hidden = dataOf<{ valueBaseAmount: string | null }[]>(
      await call(shop, 'GET', '/inventory/summary'),
    );
    expect(hidden[0]!.valueBaseAmount).toBeNull();
  });
});

describe('product photos over HTTP', () => {
  it('uploads as JSON beyond the default body limit; the image link needs a session', async () => {
    const shop = await login('shop@test.local');
    const boss = await login('boss@test.local');
    // ~1.5 MB of JPEG, base64 in JSON: over the 1 MB default, under the photo route's limit.
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1_500_000, 7)]);
    const thumb = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1000, 7)]);
    const body = {
      image: jpeg.toString('base64'),
      thumb: thumb.toString('base64'),
      width: 1200,
      height: 1600,
    };

    expect((await call(shop, 'POST', `/products/${w.x.product.id}/photos`, body)).statusCode).toBe(
      403,
    );
    const res = await call(boss, 'POST', `/products/${w.x.product.id}/photos`, body);
    expect(res.statusCode).toBe(200);
    const { id } = dataOf<{ id: string }>(res);

    const anonymous = await app.inject({ method: 'GET', url: `/api/v1/photos/${id}?size=thumb` });
    expect(anonymous.statusCode).toBe(401);
    const link = await call(shop, 'GET', `/photos/${id}?size=thumb`);
    expect(link.statusCode).toBe(302);
    expect(link.headers.location).toMatch(/^memory:\/\/products\/.*-thumb\.jpg$/);

    const mode = await call(shop, 'GET', '/mode');
    expect(dataOf<{ photos: boolean }>(mode).photos).toBe(true);
  });
});
