// Hand-typed client for the Phase 2 endpoints (docs/api.md). Phase 3 replaces this with a client
// generated from the OpenAPI document. Money and sequence numbers arrive as strings.

export type LocationKind = 'WAREHOUSE' | 'STORE';
export type SessionKind = 'OPENING' | 'RECEIVE' | 'TRANSFER' | 'DAMAGE' | 'SALE' | 'RETURN';
export type Currency = 'SYP' | 'USD';

export interface User {
  id: string;
  email: string;
  nameAr: string;
  nameEn: string | null;
  roles: string[];
  permissions: string[];
}

export interface Location {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  kind: LocationKind;
  isActive: boolean;
}

/** ثوب، طقم … in a tree up to three levels (ADR-011). */
export interface Category {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  /** The option types its products are made with, in type order. */
  groupIds: string[];
  productCount: number;
}

export interface Prices {
  retail: Money | null;
  wholesale: Money | null;
}

/** One design in a category; its sizes are its variants. */
export interface Product {
  id: string;
  /** SKU base, e.g. THB-SA-RY-MD-SN-JHST-WH. */
  code: string;
  isActive: boolean;
  category: { id: string; code: string; nameAr: string; isActive: boolean };
  /** One per non-size option type. */
  options: VariantOption[];
  /** "سعودية · ملكي · … · أبيض". */
  title: string;
  prices: Prices;
  mainPhotoId: string | null;
  variantCount: number;
}

export interface VariantOption {
  groupId: string;
  groupKey: string | null;
  group: string;
  valueId: string;
  value: string;
}

/** Minor units as a string (ADR-004); prices are in USD for now (ADR-009). */
export interface Money {
  amount: string;
  currency: Currency;
}

export interface Variant {
  id: string;
  sku: string;
  barcode: string;
  isActive: boolean;
  /** One chosen value per option type, in type order. */
  options: VariantOption[];
  /** The values joined: "سعودية · ملكي · جوخ هندي · أبيض · 56". */
  title: string;
  /** The القياس value, printed large on labels. */
  size: string | null;
  /** This size's own price, else the product's; null = not priced yet. */
  prices: Prices;
  /** Which prices are this size's own. */
  ownPrices: { retail: boolean; wholesale: boolean };
  /** The product's main photo. */
  photoId: string | null;
  product: {
    id: string;
    code: string;
    /** The category's name, e.g. ثوب. */
    nameAr: string;
    nameEn: string | null;
    /** The design: "سعودية · ملكي · … · أبيض". */
    title: string;
    categoryId: string;
    unitOfMeasure: string;
    isActive: boolean;
  };
}

export interface OptionValue {
  id: string;
  /** The value this one details (جوخ هندي for مشخط); null at the top. */
  parentId: string | null;
  valueAr: string;
  /** Short Latin code the SKU is built from (سعودية → SA). */
  code: string;
  sortOrder: number;
  isActive: boolean;
}

/** An option type: القصة، الزر، السحاب، الكم، القماش، اللون، القياس, or one the owner added. */
export interface OptionGroup {
  id: string;
  key: string | null;
  nameAr: string;
  sortOrder: number;
  isActive: boolean;
  values: OptionValue[];
}

export type Move = 'up' | 'down';

export interface Photo {
  id: string;
  width: number;
  height: number;
  sortOrder: number;
}

export interface UnitCost {
  amount: string;
  currency: Currency;
  rateToBase: string;
}

export interface ScanLine {
  variant: Variant;
  quantity: number;
  unitCost: UnitCost | null;
}

export interface ScanSessionHeader {
  id: string;
  kind: SessionKind;
  status: 'OPEN' | 'COMMITTED' | 'CANCELLED';
  locationId: string;
  toLocationId: string | null;
  reason: string | null;
  note: string | null;
  createdById: string;
  committedAt: string | null;
  totalQuantity: number;
}

export interface ScanSession extends ScanSessionHeader {
  lines: ScanLine[];
}

export interface Balance {
  variantId: string;
  locationId: string;
  quantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  valueBaseAmount: string | null;
  averageCostBaseAmount: string | null;
}

export interface Movement {
  id: string;
  seq: string;
  variantId: string;
  locationId: string;
  type: string;
  quantity: number;
  balanceAfter: number;
  referenceType: string;
  reason: string | null;
  note: string | null;
  createdById: string;
  createdAt: string;
}

export interface HistoryRow {
  movement: Movement;
  variant: Variant | null;
  createdByName: string | null;
}

export interface SummaryRow {
  locationId: string;
  productId: string;
  productCode: string;
  productNameAr: string;
  variants: number;
  quantity: number;
  valueBaseAmount: string | null;
}

export interface Account {
  id: string;
  email: string;
  nameAr: string;
  roles: string[];
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export type StocktakeStatus = 'DRAFT' | 'COUNTING' | 'REVIEW' | 'APPLIED' | 'CANCELLED';

export interface StocktakeLine {
  variant: Variant;
  expectedQuantity: number;
  countedQuantity: number | null;
  difference: number | null;
}

export interface Stocktake {
  id: string;
  locationId: string;
  scope: 'FULL' | 'PARTIAL';
  status: StocktakeStatus;
  note: string | null;
  snapshotAt: string | null;
  createdById: string;
  appliedById: string | null;
  appliedAt: string | null;
  lines: StocktakeLine[];
  movementsSinceSnapshot: number;
}

export interface StocktakeSummary extends Omit<Stocktake, 'lines' | 'movementsSinceSnapshot'> {
  createdAt: string;
  lineCount: number;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extraHeaders,
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
  if (!response.ok) {
    throw new ApiError(
      response.status,
      json.error?.code ?? 'NETWORK',
      json.error?.message ?? response.statusText,
      json.error?.details,
    );
  }
  return json.data as T;
}

const get = async <T>(path: string) => request<T>('GET', path);
const post = async <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);

export const api = {
  mode: async () => get<{ practice: boolean; photos: boolean }>('/mode'),
  login: async (email: string, password: string) => post<User>('/auth/login', { email, password }),
  logout: async () => post<{ ok: true }>('/auth/logout'),
  me: async () => get<User>('/auth/me'),

  locations: async () => get<Location[]>('/locations'),

  categories: async () => get<Category[]>('/categories'),
  createCategory: async (input: {
    nameAr: string;
    code?: string;
    parentId?: string;
    groupIds?: string[];
  }) => post<Category>('/categories', input),
  updateCategory: async (
    id: string,
    patch: {
      nameAr?: string;
      code?: string;
      parentId?: string | null;
      groupIds?: string[];
      isActive?: boolean;
      move?: Move;
    },
  ) => request<Category>('PATCH', `/categories/${id}`, patch),
  deleteCategory: async (id: string) => request<{ ok: true }>('DELETE', `/categories/${id}`),
  generateProducts: async (
    categoryId: string,
    input: {
      selections: { groupId: string; valueIds: string[] }[];
      prices?: { retail?: string; wholesale?: string };
    },
  ) =>
    post<{ products: Product[]; created: Variant[]; existing: Variant[] }>(
      `/categories/${categoryId}/products/generate`,
      input,
    ),

  products: async (categoryId?: string) =>
    get<Product[]>(`/products${categoryId ? `?categoryId=${categoryId}` : ''}`),
  product: async (id: string) => get<{ product: Product; variants: Variant[] }>(`/products/${id}`),
  setProductActive: async (id: string, isActive: boolean) =>
    request<Product>('PATCH', `/products/${id}`, { isActive }),
  deleteProduct: async (id: string) => request<{ ok: true }>('DELETE', `/products/${id}`),
  /** Same price for every listed product (all their sizes); null removes it. Minor units. */
  setProductPrices: async (input: {
    productIds: string[];
    retail?: string | null;
    wholesale?: string | null;
  }) => post<Product[]>('/products/prices', input),

  // One product's or category's sizes all at once; a search shows the first 200.
  variants: async (params: { productId?: string; categoryId?: string; q?: string }) =>
    get<Variant[]>(
      `/variants?${new URLSearchParams({
        ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)),
        limit: params.productId || params.categoryId ? '2000' : '200',
      })}`,
    ),
  /** A size's own price, overriding the product's; null goes back to the product's. */
  setPrices: async (input: {
    variantIds: string[];
    retail?: string | null;
    wholesale?: string | null;
  }) => post<Variant[]>('/variants/prices', input),
  setVariantActive: async (id: string, isActive: boolean) =>
    request<Variant>('PATCH', `/variants/${id}`, { isActive }),
  deleteVariant: async (id: string) => request<{ ok: true }>('DELETE', `/variants/${id}`),

  photos: async (productId: string) => get<Photo[]>(`/products/${productId}/photos`),
  uploadPhoto: async (
    productId: string,
    photo: { image: string; thumb: string; width: number; height: number },
  ) => post<Photo>(`/products/${productId}/photos`, photo),
  updatePhoto: async (id: string, patch: { move: Move | 'first' }) =>
    request<Photo>('PATCH', `/photos/${id}`, patch),
  deletePhoto: async (id: string) => request<{ ok: true }>('DELETE', `/photos/${id}`),

  optionGroups: async () => get<OptionGroup[]>('/option-groups'),
  createOptionGroup: async (nameAr: string) => post<OptionGroup>('/option-groups', { nameAr }),
  updateOptionGroup: async (
    id: string,
    patch: { nameAr?: string; isActive?: boolean; move?: Move },
  ) => request<OptionGroup>('PATCH', `/option-groups/${id}`, patch),
  addOptionValue: async (groupId: string, valueAr: string, parentId?: string) =>
    post<OptionValue>(`/option-groups/${groupId}/values`, {
      valueAr,
      ...(parentId ? { parentId } : {}),
    }),
  updateOptionValue: async (
    id: string,
    patch: { valueAr?: string; code?: string; isActive?: boolean; move?: Move },
  ) => request<OptionValue>('PATCH', `/option-values/${id}`, patch),

  balances: async (locationId: string) =>
    get<{ variant: Variant; balance: Balance }[]>(`/inventory/balances?locationId=${locationId}`),

  openSessions: async () => get<(ScanSessionHeader & { lineCount: number })[]>('/scan-sessions'),
  openSession: async (input: {
    kind: SessionKind;
    locationId: string;
    toLocationId?: string;
    reason?: string;
    note?: string;
  }) => post<ScanSession>('/scan-sessions', input),
  session: async (id: string) => get<ScanSession>(`/scan-sessions/${id}`),
  scan: async (id: string, barcode: string, scanId: string) =>
    post<{ duplicate: boolean; line: ScanLine }>(`/scan-sessions/${id}/scans`, { barcode, scanId }),
  setLine: async (
    id: string,
    variantId: string,
    patch: { quantity?: number; unitCost?: UnitCost },
  ) => request<ScanLine>('PATCH', `/scan-sessions/${id}/lines/${variantId}`, patch),
  removeLine: async (id: string, variantId: string) =>
    request<{ ok: true }>('DELETE', `/scan-sessions/${id}/lines/${variantId}`),
  commit: async (id: string) =>
    post<{ sessionId: string; movements: Movement[] }>(`/scan-sessions/${id}/commit`),
  cancel: async (id: string) => post<{ ok: true }>(`/scan-sessions/${id}/cancel`),

  stocktakes: async () => get<StocktakeSummary[]>('/stocktakes'),
  stocktake: async (id: string) => get<Stocktake>(`/stocktakes/${id}`),
  createStocktake: async (locationId: string) =>
    post<Stocktake>('/stocktakes', { locationId, scope: 'FULL' }),
  startStocktake: async (id: string) => post<Stocktake>(`/stocktakes/${id}/start`),
  scanCount: async (id: string, barcode: string, scanId: string) =>
    post<{ duplicate: boolean; line: StocktakeLine }>(`/stocktakes/${id}/scans`, {
      barcode,
      scanId,
    }),
  setCount: async (id: string, variantId: string, countedQuantity: number) =>
    request<Stocktake>('PATCH', `/stocktakes/${id}/lines/${variantId}`, { countedQuantity }),
  reviewStocktake: async (id: string, confirmUncountedAsZero = false) =>
    post<Stocktake>(`/stocktakes/${id}/review`, { confirmUncountedAsZero }),
  applyStocktake: async (id: string) =>
    post<{ stocktake: Stocktake; movements: Movement[] }>(`/stocktakes/${id}/apply`),
  cancelStocktake: async (id: string) => post<{ ok: true }>(`/stocktakes/${id}/cancel`),

  movements: async (params: { variantId?: string; locationId?: string; beforeSeq?: string }) =>
    get<HistoryRow[]>(
      `/inventory/movements?${new URLSearchParams(
        Object.fromEntries(Object.entries(params).filter(([, v]) => v)),
      )}`,
    ),
  summary: async () => get<SummaryRow[]>('/inventory/summary'),
  adjust: async (
    input: { variantId: string; locationId: string; delta: number; reason: string },
    idempotencyKey: string,
  ) =>
    request<unknown>('POST', '/inventory/adjustments', input, {
      'idempotency-key': idempotencyKey,
    }),

  users: async () => get<Account[]>('/users'),
  createUser: async (input: { email: string; nameAr: string; roles: string[] }) =>
    post<{ user: Account; password: string }>('/users', input),
  updateUser: async (
    id: string,
    patch: { nameAr?: string; roles?: string[]; isActive?: boolean },
  ) => request<Account>('PATCH', `/users/${id}`, patch),
  resetPassword: async (id: string) => post<{ password: string }>(`/users/${id}/reset-password`),
  changePassword: async (currentPassword: string, newPassword: string) =>
    post<{ ok: true }>('/auth/change-password', { currentPassword, newPassword }),
};
