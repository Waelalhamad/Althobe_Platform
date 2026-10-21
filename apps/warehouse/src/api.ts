// Hand-typed client for the Phase 2 endpoints (docs/api.md). Phase 3 replaces this with a client
// generated from the OpenAPI document. Money and sequence numbers arrive as strings.

export type LocationKind = 'WAREHOUSE' | 'STORE';
export type SessionKind = 'OPENING' | 'RECEIVE' | 'TRANSFER' | 'DAMAGE' | 'SALE' | 'RETURN';
export type Currency = 'SYP' | 'USD' | 'LYD' | 'TRY';

/** ADR-012: retail in SYP (Syria) and LYD (Libya), wholesale in USD. One currency per list. */
export const PRICE_KEYS = ['retailSyp', 'retailLyd', 'wholesale'] as const;
export type PriceKey = (typeof PRICE_KEYS)[number];
/** Prices to set: undefined leaves one alone, null removes it. Minor units of its currency. */
export type PriceChanges = Partial<Record<PriceKey, string | null>>;

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

export type Prices = Record<PriceKey, Money | null>;

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

/** Minor units of `currency` as a string (ADR-004); LYD has 3 decimals, the others 2. */
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
  ownPrices: Record<PriceKey, boolean>;
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

export interface Rate {
  currency: 'SYP' | 'LYD' | 'TRY';
  rate: string | null;
  /** The central bank's rate, for reference (ADR-013). */
  officialRate: string | null;
  updatedAt: string | null;
}

// ─── Accounting (ADR-013). Amounts: USD cents ("base") or minor units of `currency`. ──────────

export type VoucherType =
  | 'RECEIPT'
  | 'PAYMENT'
  | 'TRANSFER'
  | 'EXCHANGE'
  | 'JOURNAL'
  | 'INVENTORY'
  | 'REVALUATION'
  | 'REVERSAL'
  | 'RETAIL'
  | 'PAYROLL'
  | 'INVOICE';
export type Branch = 'SY' | 'LY';

// ─── Point of sale (ADR-014). SYP minor units unless a currency says otherwise. ───────────────

export type DrawerCurrency = 'SYP' | 'USD' | 'TRY';

export interface ShiftCash {
  currency: DrawerCurrency;
  opening: string;
  takings: string;
  change: string;
  refunds: string;
  expected: string;
  counted: string | null;
  difference: string | null;
}

export interface Shift {
  id: string;
  locationId: string;
  status: 'OPEN' | 'CLOSED';
  openedBy: { id: string; nameAr: string };
  openedAt: string;
  closedBy: { id: string; nameAr: string } | null;
  closedAt: string | null;
  journalEntryId: string | null;
  cash: ShiftCash[];
  salesCount: number;
  refundsCount: number;
  salesTotal: string;
  refundsTotal: string;
}

export interface PosSaleLine {
  lineNo: number;
  variant: {
    id: string;
    sku: string;
    barcode: string;
    title: string;
    size: string | null;
    productName: string;
  };
  quantity: number;
  unitPrice: string;
  netTotal: string;
  refundOfLine: number | null;
  refunded: number;
}

export interface PosSale {
  id: string;
  kind: 'SALE' | 'REFUND';
  receiptYear: number;
  receiptNo: number;
  shiftId: string;
  locationId: string;
  refundOfId: string | null;
  subtotal: string;
  discount: string;
  total: string;
  totalBase: string;
  change: string;
  sypRate: string;
  /** على الحساب (ADR-016): what the customer owes for it; on a refund, what went back on it. */
  onAccount: string;
  party: { id: string; nameAr: string } | null;
  note: string | null;
  createdBy: { id: string; nameAr: string };
  createdAt: string;
  lines: PosSaleLine[];
  payments: { currency: DrawerCurrency; amount: string; rate: string; base: string }[];
}

export interface PosLookup {
  variant: Variant;
  /** SYP minor units, or null: no retail price yet. */
  price: string | null;
  available: number | null;
}

export type CashCount = Partial<Record<DrawerCurrency, string>>;

/** One account of the chart (دليل الحسابات). */
export interface GlAccount {
  id: string;
  code: string;
  nameAr: string;
  class: number;
  parentId: string | null;
  isPostable: boolean;
  currency: Currency | null;
  kind: 'GENERAL' | 'CASH' | 'INVENTORY';
  systemRole: string | null;
  locationId: string | null;
  branch: Branch | null;
  isActive: boolean;
}

export interface JournalLine {
  lineNo: number;
  account: { id: string; code: string; nameAr: string };
  amountBase: string;
  currency: Currency;
  amountCurrency: string;
  rate: string;
  branch: Branch | null;
  locationId: string | null;
  memo: string | null;
}

export interface JournalEntry {
  id: string;
  voucherType: VoucherType;
  voucherYear: number;
  voucherNo: number;
  entryDate: string;
  memo: string | null;
  sourceType: string | null;
  sourceId: string | null;
  reversesId: string | null;
  reversedById: string | null;
  createdBy: { id: string; nameAr: string };
  createdAt: string;
  lines: JournalLine[];
}

export interface CashBox {
  account: GlAccount;
  /** In the box's own currency. */
  balance: string;
  /** USD cents in the books. */
  bookValue: string;
  rate: string | null;
}

export type Voucher =
  | {
      kind: 'RECEIPT' | 'PAYMENT';
      date?: string;
      boxId: string;
      counterAccountId: string;
      amount: string;
      rate?: string;
      memo: string;
    }
  | {
      kind: 'TRANSFER';
      date?: string;
      fromBoxId: string;
      toBoxId: string;
      amount: string;
      rate?: string;
      memo?: string;
    }
  | {
      kind: 'EXCHANGE';
      date?: string;
      fromBoxId: string;
      fromAmount: string;
      toBoxId: string;
      toAmount: string;
      rate?: string;
      memo?: string;
    }
  | {
      kind: 'JOURNAL';
      date?: string;
      memo: string;
      branch?: Branch;
      lines: { accountId: string; debit?: string; credit?: string; memo?: string }[];
    };

export interface StatementRow {
  entry: Pick<
    JournalEntry,
    'id' | 'voucherType' | 'voucherYear' | 'voucherNo' | 'entryDate' | 'memo'
  >;
  memo: string | null;
  currency: Currency;
  amountCurrency: string;
  amountBase: string;
  rate: string;
  balanceBase: string;
  balanceCurrency: string;
}

export interface Statement {
  account: GlAccount;
  opening: { base: string; currency: string };
  rows: StatementRow[];
  closing: { base: string; currency: string };
}

export type AccountRef = Pick<GlAccount, 'id' | 'code' | 'nameAr' | 'class'>;

export interface TrialBalance {
  rows: { account: AccountRef; opening: string; debit: string; credit: string; closing: string }[];
  totals: { opening: string; debit: string; credit: string; closing: string };
}

export interface IncomeStatement {
  sections: {
    key: 'revenue' | 'costOfSales' | 'expenses' | 'exchange';
    rows: { account: AccountRef; amount: string }[];
    total: string;
  }[];
  grossProfit: string;
  netProfit: string;
}

export interface SheetGroup {
  rows: { account: AccountRef; amount: string }[];
  total: string;
}

export interface BalanceSheet {
  asOf: string;
  assets: SheetGroup;
  liabilities: SheetGroup;
  equity: SheetGroup;
  profit: string;
  totalLiabilitiesAndEquity: string;
}

export interface BooksCheck {
  ok: boolean;
  locations: {
    locationId: string;
    nameAr: string;
    books: string;
    stock: string;
    difference: string;
  }[];
  transit: string;
}

export interface ClosingStatus {
  closedThrough: string | null;
  next: string | null;
  rates: Record<string, string>;
  missingRates: string[];
  preview: { accountId: string; currency: Currency; amountBase: string; rate: string }[];
  closed: {
    period: string;
    endsOn: string;
    closedBy: string;
    closedAt: string;
    revaluationEntryId: string | null;
  }[];
}

export interface Range {
  from?: string;
  to?: string;
  branch?: Branch;
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

// ─── Payroll (ADR-015). Amounts are minor units of the employee's currency. ────────────────────

export type Frequency = 'MONTHLY' | 'WEEKLY';

export interface Employee {
  id: string;
  nameAr: string;
  phone: string | null;
  jobTitle: string | null;
  branch: Branch;
  frequency: Frequency;
  isActive: boolean;
  /** Null without payroll.manage. */
  currency: Currency | null;
  salary: string | null;
  advanceBalance: string | null;
  notes: string | null;
}

export interface EmployeeDetail extends Employee {
  advances: {
    id: string;
    kind: 'GIVEN' | 'REPAID' | 'DEDUCTED' | 'RESTORED';
    amount: string;
    note: string | null;
    createdBy: string;
    createdAt: string;
    journalEntryId: string | null;
  }[];
  pay: {
    runId: string;
    frequency: Frequency;
    periodStart: string;
    periodEnd: string;
    status: PayrollRun['status'];
    gross: string;
    advanceDeduct: string;
    net: string;
    paidAt: string | null;
  }[];
}

export interface EmployeeInput {
  nameAr: string;
  phone?: string;
  jobTitle?: string;
  branch: Branch;
  currency: Currency;
  salary: string;
  frequency: Frequency;
  notes?: string;
}

export interface PayrollRun {
  id: string;
  frequency: Frequency;
  periodStart: string;
  periodEnd: string;
  status: 'DRAFT' | 'APPROVED' | 'CANCELLED';
  accrualEntryId: string | null;
  reversalEntryId: string | null;
  createdBy: string;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  totals: { currency: Currency; gross: string; net: string; unpaid: string }[];
  employees: number;
  unpaidEmployees: number;
}

export interface PayrollLine {
  id: string;
  employee: { id: string; nameAr: string; jobTitle: string | null };
  currency: Currency;
  branch: Branch;
  salary: string;
  bonus: string;
  deduction: string;
  deductionNote: string | null;
  advanceDeduct: string;
  gross: string;
  net: string;
  advanceBalance: string;
  paid: { paymentId: string; boxName: string; paidAt: string } | null;
}

export type PayrollRunDetail = PayrollRun & { lines: PayrollLine[] };

export interface PayrollSummary {
  advances: { currency: Currency; amount: string }[];
  unpaid: { currency: Currency; amount: string }[];
  unpaidEmployees: number;
  drafts: number;
  missingMonth: string | null;
  books: {
    ok: boolean;
    advances: { books: string; detail: string };
    payable: { books: string; detail: string };
  };
}

export type LinePatch = Partial<{
  salary: string;
  bonus: string;
  deduction: string;
  deductionNote: string;
  advanceDeduct: string;
}>;

// ─── Suppliers and customers (ADR-016). Amounts are minor units of the party's currency. ──────

export type PartyKind = 'SUPPLIER' | 'CUSTOMER';
/** Where received goods came from (developer report F-01). */
export type ReceiptSource = 'SUPPLIER' | 'CASH' | 'OPENING' | 'OWNER';

export interface Party {
  id: string;
  kind: PartyKind;
  nameAr: string;
  phone: string | null;
  currency: Currency;
  branch: Branch;
  notes: string | null;
  isActive: boolean;
  /** What is outstanding (they owe us / we owe them). Null without parties.read. */
  balance: string | null;
}

export interface PartyDetail extends Party {
  entries: {
    id: string;
    kind: 'BILL' | 'PAYMENT' | 'INVOICE' | 'RECEIPT' | 'POS_SALE' | 'POS_REFUND';
    amount: string;
    balance: string;
    sourceType: string;
    sourceId: string;
    journalEntryId: string | null;
    note: string | null;
    createdBy: string;
    createdAt: string;
  }[];
}

export interface PartiesSummary {
  customers: { currency: Currency; amount: string }[];
  suppliers: { currency: Currency; amount: string }[];
  books: Record<'receivable' | 'payable', { books: string; named: string; unassigned: string }>;
}

export const api = {
  mode: async () => get<{ practice: boolean; photos: boolean }>('/mode'),
  login: async (email: string, password: string) => post<User>('/auth/login', { email, password }),
  logout: async () => post<{ ok: true }>('/auth/logout'),
  me: async () => get<User>('/auth/me'),

  locations: async () => get<Location[]>('/locations'),
  updateLocation: async (id: string, patch: { nameAr?: string; nameEn?: string | null }) =>
    request<Location>('PATCH', `/locations/${id}`, patch),

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
      prices?: Partial<Record<PriceKey, string>>;
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
  setProductPrices: async (input: { productIds: string[] } & PriceChanges) =>
    post<Product[]>('/products/prices', input),

  // One product's or category's sizes all at once; a search shows the first 200.
  variants: async (params: { productId?: string; categoryId?: string; q?: string }) =>
    get<Variant[]>(
      `/variants?${new URLSearchParams({
        ...Object.fromEntries(Object.entries(params).filter(([, v]) => v)),
        limit: params.productId || params.categoryId ? '2000' : '200',
      })}`,
    ),
  /** A size's own price, overriding the product's; null goes back to the product's. */
  setPrices: async (input: { variantIds: string[] } & PriceChanges) =>
    post<Variant[]>('/variants/prices', input),

  // Exchange rates (ADR-012): units of the currency per 1 USD; null until the owner sets one.
  rateHistory: async () =>
    get<
      {
        currency: Currency;
        rate: string;
        officialRate: string | null;
        setBy: string;
        setAt: string;
      }[]
    >('/rates/history'),
  rates: async () => get<Rate[]>('/rates'),
  setRate: async (currency: Rate['currency'], rate: string, officialRate?: string | null) =>
    request<Rate>('PUT', '/rates', { currency, rate, officialRate }),
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
  deleteOptionGroup: async (id: string) => request<{ ok: true }>('DELETE', `/option-groups/${id}`),
  deleteOptionValue: async (id: string) => request<{ ok: true }>('DELETE', `/option-values/${id}`),

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
  /** A receipt confirmed with its supplier and what was paid on the spot (ADR-016). */
  commitReceipt: async (
    id: string,
    terms: {
      source: ReceiptSource;
      partyId?: string;
      invoiceNo?: string;
      paid?: { boxId: string; amount: string };
    },
  ) => post<{ sessionId: string; movements: Movement[] }>(`/parties/receipts/${id}`, terms),
  /** Goods out confirmed as a wholesale sale on the customer's account. */
  commitGoodsOut: async (id: string, terms: { partyId: string; amount: string; note?: string }) =>
    post<{ sessionId: string; movements: Movement[] }>(`/parties/goods-out/${id}`, terms),

  parties: async (params: { kind?: PartyKind; includeInactive?: boolean } = {}) =>
    get<Party[]>(
      `/parties?${query({ kind: params.kind, includeInactive: params.includeInactive ? 'true' : undefined })}`,
    ),
  party: async (id: string) => get<PartyDetail>(`/parties/${id}`),
  createParty: async (input: {
    kind: PartyKind;
    nameAr: string;
    phone?: string;
    currency: Currency;
    branch: Branch;
    notes?: string;
  }) => post<Party>('/parties', input),
  updateParty: async (
    id: string,
    patch: Partial<{
      nameAr: string;
      phone: string;
      currency: Currency;
      branch: Branch;
      notes: string;
      isActive: boolean;
    }>,
  ) => request<Party>('PATCH', `/parties/${id}`, patch),
  settleParty: async (
    id: string,
    input: { boxId: string; amount: string; note?: string },
    idempotencyKey: string,
  ) =>
    request<{ balance: string }>('POST', `/parties/${id}/settle`, input, {
      'idempotency-key': idempotencyKey,
    }),
  partiesSummary: async () => get<PartiesSummary>('/parties/summary'),
  settleUnassigned: async (
    input: {
      side: 'PAYABLE' | 'RECEIVABLE';
      boxId?: string;
      as?: 'OWNER' | 'OPENING';
      amount: string;
      note?: string;
    },
    idempotencyKey: string,
  ) =>
    request<{ left: string }>('POST', '/parties/unassigned', input, {
      'idempotency-key': idempotencyKey,
    }),

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

  // Point of sale (ADR-014). A sale or refund carries an Idempotency-Key: one receipt per click.
  posToday: async () =>
    get<{
      day: string;
      receipts: number;
      refunds: number;
      total: string;
      totalBase: string;
      profitBase: string;
      pieces: number;
    }>('/retail/today'),
  currentShift: async (locationId: string) =>
    get<Shift | null>(`/retail/shifts/current?${query({ locationId })}`),
  shifts: async (locationId: string) => get<Shift[]>(`/retail/shifts?${query({ locationId })}`),
  /** What the drawer held when the store's last shift closed, to start the next one from. */
  lastCount: async (locationId: string) =>
    get<{ closedAt: string; counted: CashCount } | null>(
      `/retail/shifts/last-count?${query({ locationId })}`,
    ),
  shift: async (id: string) => get<Shift>(`/retail/shifts/${id}`),
  openShift: async (locationId: string, opening: CashCount) =>
    post<Shift>('/retail/shifts', { locationId, opening }),
  closeShift: async (id: string, counted: CashCount) =>
    post<Shift>(`/retail/shifts/${id}/close`, { counted }),
  posLookup: async (barcode: string, locationId: string) =>
    get<PosLookup>(`/retail/lookup?${query({ barcode, locationId })}`),
  posSales: async (params: { shiftId?: string; receipt?: string }) =>
    get<PosSale[]>(`/retail/sales?${query(params)}`),
  posSale: async (id: string) => get<PosSale>(`/retail/sales/${id}`),
  sell: async (
    input: {
      shiftId: string;
      lines: { variantId: string; quantity: number }[];
      discount?: string;
      payments: { currency: DrawerCurrency; amount: string }[];
      account?: { partyId: string; amount: string };
    },
    idempotencyKey: string,
  ) => request<PosSale>('POST', '/retail/sales', input, { 'idempotency-key': idempotencyKey }),
  refund: async (
    saleId: string,
    input: { shiftId: string; lines: { lineNo: number; quantity: number }[]; reason: string },
    idempotencyKey: string,
  ) =>
    request<PosSale>('POST', `/retail/sales/${saleId}/refund`, input, {
      'idempotency-key': idempotencyKey,
    }),

  // Accounting (ADR-013). Posting carries an Idempotency-Key, so a double click posts once.
  glAccounts: async () => get<GlAccount[]>('/accounting/accounts'),
  createGlAccount: async (input: {
    parentId: string;
    nameAr: string;
    kind?: 'GENERAL' | 'CASH';
    currency?: Currency;
    branch?: Branch | null;
  }) => post<GlAccount>('/accounting/accounts', input),
  updateGlAccount: async (
    id: string,
    patch: { nameAr?: string; isActive?: boolean; branch?: Branch | null },
  ) => request<GlAccount>('PATCH', `/accounting/accounts/${id}`, patch),
  statement: async (id: string, range: Range) =>
    get<Statement>(`/accounting/accounts/${id}/statement?${query(range)}`),
  boxes: async () => get<CashBox[]>('/accounting/boxes'),
  entries: async (params: Range & { voucherType?: VoucherType }) =>
    get<JournalEntry[]>(`/accounting/entries?${query(params)}`),
  entry: async (id: string) => get<JournalEntry>(`/accounting/entries/${id}`),
  postVoucher: async (voucher: Voucher, idempotencyKey: string) =>
    request<JournalEntry>('POST', '/accounting/entries', voucher, {
      'idempotency-key': idempotencyKey,
    }),
  reverseEntry: async (id: string, idempotencyKey: string) =>
    request<JournalEntry>(
      'POST',
      `/accounting/entries/${id}/reverse`,
      {},
      { 'idempotency-key': idempotencyKey },
    ),
  trialBalance: async (range: Range) =>
    get<TrialBalance>(`/accounting/reports/trial-balance?${query(range)}`),
  incomeStatement: async (range: Range) =>
    get<IncomeStatement>(`/accounting/reports/income?${query(range)}`),
  balanceSheet: async (params: { asOf?: string; branch?: Branch }) =>
    get<BalanceSheet>(`/accounting/reports/balance-sheet?${query(params)}`),
  checkBooks: async () => get<BooksCheck>('/accounting/check'),
  closingStatus: async () => get<ClosingStatus>('/accounting/periods'),
  employees: async (includeInactive = false) =>
    get<Employee[]>(`/payroll/employees?${query({ includeInactive: String(includeInactive) })}`),
  employee: async (id: string) => get<EmployeeDetail>(`/payroll/employees/${id}`),
  createEmployee: async (input: EmployeeInput) => post<Employee>('/payroll/employees', input),
  updateEmployee: async (id: string, patch: Partial<EmployeeInput> & { isActive?: boolean }) =>
    request<Employee>('PATCH', `/payroll/employees/${id}`, patch),
  advance: async (
    employeeId: string,
    kind: 'advances' | 'repayments',
    input: { boxId: string; amount: string; note?: string },
    idempotencyKey: string,
  ) =>
    request<{ balance: string }>('POST', `/payroll/employees/${employeeId}/${kind}`, input, {
      'idempotency-key': idempotencyKey,
    }),
  payrollSummary: async () => get<PayrollSummary>('/payroll/summary'),
  payrollRuns: async () => get<PayrollRun[]>('/payroll/runs'),
  payrollRun: async (id: string) => get<PayrollRunDetail>(`/payroll/runs/${id}`),
  createPayrollRun: async (
    input: { frequency: 'MONTHLY'; period: string } | { frequency: 'WEEKLY'; weekStart: string },
  ) => post<PayrollRunDetail>('/payroll/runs', input),
  updatePayrollLine: async (runId: string, lineId: string, patch: LinePatch) =>
    request<PayrollRunDetail>('PATCH', `/payroll/runs/${runId}/lines/${lineId}`, patch),
  removePayrollLine: async (runId: string, lineId: string) =>
    request<PayrollRunDetail>('DELETE', `/payroll/runs/${runId}/lines/${lineId}`),
  payrollAction: async (
    runId: string,
    action: 'approve' | 'cancel' | 'pay',
    idempotencyKey: string,
    body: { boxId?: string; lineIds?: string[] } = {},
  ) =>
    request<PayrollRunDetail>('POST', `/payroll/runs/${runId}/${action}`, body, {
      'idempotency-key': idempotencyKey,
    }),
  closeMonth: async (period: string) =>
    post<{ period: string; endsOn: string; revaluationEntryId: string | null }>(
      '/accounting/periods/close',
      { period },
    ),
};

/** A query string of the parameters that are set. */
function query(params: object): string {
  return new URLSearchParams(
    Object.entries(params).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
    ),
  ).toString();
}
