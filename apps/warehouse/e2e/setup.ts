import { expect, type APIRequestContext } from '@playwright/test';

// Setup through the API (same session cookie) keeps runs short on a slow network. The TEST
// database is wiped by the integration suite, so each run makes sure its option types exist.

export async function api<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  data?: object,
) {
  const res = await request.fetch(`/api/v1${url}`, { method, ...(data ? { data } : {}) });
  expect(res.ok(), `${method} ${url} → ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { data: T }).data;
}

interface Group {
  id: string;
  nameAr: string;
  values: { id: string; valueAr: string }[];
}

/** An option type with at least these values, created if missing. Returns it with value ids. */
export async function ensureOptionType(rq: APIRequestContext, nameAr: string, values: string[]) {
  const find = async () =>
    (await api<Group[]>(rq, 'GET', '/option-groups')).find((g) => g.nameAr === nameAr);
  const group = (await find()) ?? (await api<Group>(rq, 'POST', '/option-groups', { nameAr }));
  await api(rq, 'PATCH', `/option-groups/${group.id}`, { isActive: true });
  for (const valueAr of values) {
    const existing = group.values.find((v) => v.valueAr === valueAr);
    if (!existing) await api(rq, 'POST', `/option-groups/${group.id}/values`, { valueAr });
    else await api(rq, 'PATCH', `/option-values/${existing.id}`, { isActive: true });
  }
  const fresh = (await find())!;
  return {
    id: fresh.id,
    valueIds: (...names: string[]) =>
      names.map((n) => fresh.values.find((v) => v.valueAr === n)!.id),
  };
}

/** A category made with one option type (القياس), one product, and one size variant per size. */
export async function productWithSizes(
  rq: APIRequestContext,
  code: string,
  nameAr: string,
  sizes: string[],
) {
  const size = await ensureOptionType(rq, 'القياس', sizes);
  const category = await api<{ id: string }>(rq, 'POST', '/categories', {
    code,
    nameAr,
    groupIds: [size.id],
  });
  const { created } = await api<{ created: { id: string; barcode: string }[] }>(
    rq,
    'POST',
    `/categories/${category.id}/products/generate`,
    { selections: [{ groupId: size.id, valueIds: size.valueIds(...sizes) }] },
  );
  return created;
}
