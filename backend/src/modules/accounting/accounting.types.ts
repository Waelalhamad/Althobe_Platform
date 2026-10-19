import type { Currency } from '../../shared/money.js';

/** سند قبض · سند صرف · تحويل · صرافة · قيد يومية · قيد مخزون · إعادة تقييم · قيد عكسي */
export const VOUCHER_TYPES = [
  'RECEIPT',
  'PAYMENT',
  'TRANSFER',
  'EXCHANGE',
  'JOURNAL',
  'INVENTORY',
  'REVALUATION',
  'REVERSAL',
  // A closed POS shift (ADR-014).
  'RETAIL',
] as const;
export type VoucherType = (typeof VOUCHER_TYPES)[number];

/** One company, two countries (ADR-013): every line says which one it belongs to. */
export const BRANCHES = ['SY', 'LY'] as const;
export type Branch = (typeof BRANCHES)[number];

export type AccountKind = 'GENERAL' | 'CASH' | 'INVENTORY';

/** The accounts code posts to by itself. */
export type SystemRole =
  | 'CASH_PARENT'
  | 'INVENTORY_PARENT'
  | 'INVENTORY_TRANSIT'
  | 'RECEIVABLE'
  | 'PAYABLE'
  | 'CAPITAL'
  | 'OWNER_CURRENT'
  | 'RETAINED'
  | 'OPENING_EQUITY'
  | 'COGS'
  | 'DAMAGE'
  | 'STOCK_ADJUSTMENT'
  | 'FX_REALIZED'
  | 'FX_UNREALIZED'
  // The store drawer, one account per currency, and its counted differences (ADR-014).
  | 'STORE_CASH_SYP'
  | 'STORE_CASH_USD'
  | 'STORE_CASH_TRY'
  | 'CASH_OVER_SHORT'
  | 'RETAIL_SALES_SY'
  | 'SALES_RETURNS';

/** A line about to be posted. amountBase is USD cents, debit positive. */
export interface DraftLine {
  accountId: string;
  amountBase: bigint;
  currency: Currency;
  /** The same amount in `currency`, minor units, same sign. Equal to amountBase for USD. */
  amountCurrency: bigint;
  /** Units of `currency` per 1 USD; "1" for USD. */
  rate: string;
  branch?: Branch | null;
  locationId?: string | null;
  memo?: string | null;
}

export interface DraftEntry {
  voucherType: VoucherType;
  /** YYYY-MM-DD, the business date. */
  entryDate: string;
  memo?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  reversesId?: string | null;
  createdById: string;
  lines: DraftLine[];
}

export interface AccountView {
  id: string;
  code: string;
  nameAr: string;
  class: number;
  parentId: string | null;
  isPostable: boolean;
  currency: Currency | null;
  kind: AccountKind;
  systemRole: SystemRole | null;
  locationId: string | null;
  branch: Branch | null;
  isActive: boolean;
}

export interface LineView {
  lineNo: number;
  account: { id: string; code: string; nameAr: string };
  amountBase: bigint;
  currency: Currency;
  amountCurrency: bigint;
  rate: string;
  branch: Branch | null;
  locationId: string | null;
  memo: string | null;
}

export interface EntryView {
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
  createdAt: Date;
  lines: LineView[];
}
