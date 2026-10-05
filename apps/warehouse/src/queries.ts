import { queryOptions } from '@tanstack/react-query';
import { api, type User } from './api';

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: api.me,
  retry: false,
  staleTime: Infinity,
});
export const modeQuery = queryOptions({
  queryKey: ['mode'],
  queryFn: api.mode,
  staleTime: Infinity,
});
export const locationsQuery = queryOptions({
  queryKey: ['locations'],
  queryFn: api.locations,
  staleTime: 60_000,
});
export const productsQuery = queryOptions({ queryKey: ['products'], queryFn: api.products });
export const photosQuery = (productId: string) =>
  queryOptions({ queryKey: ['photos', productId], queryFn: async () => api.photos(productId) });

export const optionGroupsQuery = queryOptions({
  queryKey: ['option-groups'],
  queryFn: api.optionGroups,
});

export const variantsQuery = (productId: string) =>
  queryOptions({
    queryKey: ['variants', productId],
    queryFn: async () => api.variants({ productId }),
  });

export const balancesQuery = (locationId: string) =>
  queryOptions({
    queryKey: ['balances', locationId],
    queryFn: async () => api.balances(locationId),
  });

export const sessionQuery = (id: string) =>
  queryOptions({ queryKey: ['session', id], queryFn: async () => api.session(id) });

export const openSessionsQuery = queryOptions({
  queryKey: ['open-sessions'],
  queryFn: api.openSessions,
});

export const stocktakesQuery = queryOptions({ queryKey: ['stocktakes'], queryFn: api.stocktakes });

export const stocktakeQuery = (id: string) =>
  queryOptions({ queryKey: ['stocktake', id], queryFn: async () => api.stocktake(id) });

export const summaryQuery = queryOptions({ queryKey: ['summary'], queryFn: api.summary });
export const usersQuery = queryOptions({ queryKey: ['users'], queryFn: api.users });

export const movementsQuery = (params: { variantId?: string; locationId?: string }) =>
  queryOptions({ queryKey: ['movements', params], queryFn: async () => api.movements(params) });

/** UI hint only — the server enforces every permission regardless. */
export function can(user: User | undefined, permission: string): boolean {
  return user?.permissions.includes(permission) ?? false;
}
