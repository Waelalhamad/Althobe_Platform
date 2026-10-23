import { queryOptions } from '@tanstack/react-query';
import {
  api,
  type Branch,
  type Location,
  type PartyKind,
  type Range,
  type User,
  type VoucherType,
} from './api';

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

/** F-04: only the locations this user works at (a Libya keeper: Libya's). */
export const myLocationsQuery = queryOptions({
  ...locationsQuery,
  select: (locations: Location[]) => locations.filter((l) => l.mine),
});
export const categoriesQuery = queryOptions({ queryKey: ['categories'], queryFn: api.categories });

/** All products, or one category's. */
export const productsQuery = (categoryId?: string) =>
  queryOptions({
    queryKey: ['products', categoryId ?? 'all'],
    queryFn: async () => api.products(categoryId),
  });

export const productQuery = (id: string) =>
  queryOptions({ queryKey: ['product', id], queryFn: async () => api.product(id) });
export const photosQuery = (productId: string) =>
  queryOptions({ queryKey: ['photos', productId], queryFn: async () => api.photos(productId) });

export const optionGroupsQuery = queryOptions({
  queryKey: ['option-groups'],
  queryFn: api.optionGroups,
});

/** One product's sizes, or a whole category's. */
export const variantsQuery = (params: { productId?: string; categoryId?: string }) =>
  queryOptions({
    queryKey: ['variants', params],
    queryFn: async () => api.variants(params),
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

/**
 * Whose job is the warehouse: who receives, moves, counts or builds products. Store staff and an
 * accountant may look at stock, but their home is the till or the books.
 */
export function doesStockWork(user: User | undefined): boolean {
  return [
    'products.write',
    'inventory.receive',
    'inventory.transfer',
    'inventory.damage',
    'inventory.adjust',
    'inventory.stocktake.count',
    'inventory.stocktake.apply',
  ].some((p) => can(user, p));
}

/** What the store sold today (ADR-014), for the owner's «اليوم». */
export const posTodayQuery = queryOptions({
  queryKey: ['pos', 'today'],
  queryFn: api.posToday,
  refetchInterval: 60_000,
});

/** Exchange rates (ADR-012): read by whoever enters a cost; changed only by the owner. */
export const ratesQuery = queryOptions({ queryKey: ['rates'], queryFn: api.rates });

// ─── Accounting (ADR-013). Every key starts with 'books', so one invalidation refreshes all. ──
export const glAccountsQuery = queryOptions({
  queryKey: ['books', 'accounts'],
  queryFn: api.glAccounts,
});
export const boxesQuery = queryOptions({ queryKey: ['books', 'boxes'], queryFn: api.boxes });
export const booksCheckQuery = queryOptions({
  queryKey: ['books', 'check'],
  queryFn: api.checkBooks,
});
export const closingQuery = queryOptions({
  queryKey: ['books', 'closing'],
  queryFn: api.closingStatus,
});

export const entriesQuery = (params: Range & { voucherType?: VoucherType }) =>
  queryOptions({
    queryKey: ['books', 'entries', params],
    queryFn: async () => api.entries(params),
  });
export const entryQuery = (id: string) =>
  queryOptions({ queryKey: ['books', 'entry', id], queryFn: async () => api.entry(id) });
export const statementQuery = (id: string, range: Range) =>
  queryOptions({
    queryKey: ['books', 'statement', id, range],
    queryFn: async () => api.statement(id, range),
  });
export const trialBalanceQuery = (range: Range) =>
  queryOptions({
    queryKey: ['books', 'trial', range],
    queryFn: async () => api.trialBalance(range),
  });
export const incomeQuery = (range: Range) =>
  queryOptions({
    queryKey: ['books', 'income', range],
    queryFn: async () => api.incomeStatement(range),
  });
export const balanceSheetQuery = (params: { asOf?: string; branch?: Branch }) =>
  queryOptions({
    queryKey: ['books', 'balance-sheet', params],
    queryFn: async () => api.balanceSheet(params),
  });

// ─── Payroll (ADR-015). Keys start with 'payroll'; what it posts also changes 'books'. ─────────
export const employeesQuery = (includeInactive = false) =>
  queryOptions({
    queryKey: ['payroll', 'employees', includeInactive],
    queryFn: async () => api.employees(includeInactive),
  });
export const employeeQuery = (id: string) =>
  queryOptions({ queryKey: ['payroll', 'employee', id], queryFn: async () => api.employee(id) });
export const payrollSummaryQuery = queryOptions({
  queryKey: ['payroll', 'summary'],
  queryFn: api.payrollSummary,
});
export const payrollRunsQuery = queryOptions({
  queryKey: ['payroll', 'runs'],
  queryFn: api.payrollRuns,
});
export const payrollRunQuery = (id: string) =>
  queryOptions({ queryKey: ['payroll', 'run', id], queryFn: async () => api.payrollRun(id) });

// ─── Suppliers and customers (ADR-016). Keys start with 'parties'; moves also change 'books'. ──
export const partiesQuery = (kind?: PartyKind, includeInactive = false) =>
  queryOptions({
    queryKey: ['parties', 'list', kind ?? 'all', includeInactive],
    queryFn: async () => api.parties({ kind, includeInactive }),
  });
export const partyQuery = (id: string) =>
  queryOptions({ queryKey: ['parties', 'one', id], queryFn: async () => api.party(id) });
export const partiesSummaryQuery = queryOptions({
  queryKey: ['parties', 'summary'],
  queryFn: api.partiesSummary,
});
