import {
  ApiError,
  type Currency,
  type LocationKind,
  type Money,
  type OptionGroup,
  type OptionValue,
  type PriceKey,
  type Prices,
  type SessionKind,
  type Variant,
} from './api';

// Arabic copy keyed by the API's stable error codes (docs/api.md: clients switch on `code`).
const ERRORS: Record<string, string> = {
  INVALID_CREDENTIALS: 'البريد الإلكتروني أو كلمة المرور غير صحيحة',
  NOT_AUTHENTICATED: 'انتهت الجلسة، يرجى تسجيل الدخول من جديد',
  PERMISSION_DENIED: 'ليس لديك صلاحية لهذا الإجراء',
  RATE_LIMITED: 'محاولات كثيرة، انتظر دقيقة ثم حاول مجدداً',
  VALIDATION_FAILED: 'البيانات المدخلة غير صحيحة',
  BARCODE_NOT_FOUND: 'الباركود غير معروف — لا يوجد صنف بهذا الرمز',
  INVALID_BARCODE: 'قراءة خاطئة للباركود — امسح مرة أخرى',
  VARIANT_INACTIVE: 'هذا الصنف موقوف',
  LOCATION_INACTIVE: 'هذا الموقع موقوف',
  MOVEMENT_NOT_ALLOWED_AT_LOCATION: 'هذه العملية غير مسموحة في هذا الموقع',
  SCAN_SESSION_NOT_OPEN: 'هذه الجلسة مغلقة',
  SCAN_SESSION_EMPTY: 'لا يوجد شيء لتأكيده',
  SCAN_SESSION_MISSING_COST: 'يجب إدخال التكلفة لكل صنف قبل التأكيد',
  COST_NOT_ALLOWED: 'لا تُدخل تكلفة في هذا النوع من الجلسات',
  OPENING_ALREADY_RECORDED: 'تم جرد هذا الصنف افتتاحياً في هذا الموقع من قبل',
  INSUFFICIENT_STOCK: 'الكمية المتوفرة غير كافية',
  INSUFFICIENT_AVAILABLE_STOCK: 'الكمية المتاحة غير كافية (جزء منها محجوز)',
  PRODUCT_CODE_TAKEN: 'رمز المنتج مستخدم مسبقاً',
  PRODUCT_INACTIVE: 'المنتج موقوف',
  PHOTOS_DISABLED: 'تخزين الصور غير مفعّل على هذا الخادم',
  INVALID_IMAGE: 'الملف ليس صورة (JPEG أو WebP أو PNG)',
  IMAGE_TOO_LARGE: 'الصورة كبيرة جداً',
  INVALID_PHOTO_TAGS: 'لا يمكن ربط الصورة بقيمة ليست من خيارات هذا المنتج',
  OPTION_GROUP_TAKEN: 'يوجد نوع خيار بهذا الاسم',
  OPTION_VALUE_TAKEN: 'هذه القيمة موجودة مسبقاً',
  CATEGORY_CODE_TAKEN: 'يوجد تصنيف بهذا الرمز',
  CATEGORY_INACTIVE: 'هذا التصنيف موقوف',
  CATEGORY_TOO_DEEP: 'التصنيفات حتى ثلاثة مستويات، ولا يوضع تصنيف داخل نفسه',
  CATEGORY_HAS_CHILDREN: 'احذف التصنيفات الفرعية أو انقلها أولاً',
  HAS_STOCK: 'له حركات مخزون — أوقفه بدل حذفه',
  OPTION_VALUE_TOO_DEEP: 'التفاصيل حتى ثلاثة مستويات فقط',
  OPTION_CODE_TAKEN: 'هذا الرمز مستخدم لقيمة أخرى في نفس النوع',
  OPTION_IN_USE: 'لا يمكن الحذف: مستخدم في منتجات قائمة — احذف تلك المنتجات أولاً، أو أخفِه',
  OPTION_BUILT_IN: 'نوع القياس أساسي ولا يُحذف — يمكن إخفاؤه',
  INVALID_OPTION_GROUPS: 'نوع خيار غير معروف أو موقوف',
  OPTION_GROUP_IN_USE: 'لا يمكن إزالة هذا النوع: أصناف هذا المنتج تستخدمه',
  INVALID_SELECTION: 'اختر قيمة واحدة على الأقل لكل نوع، من القيم المفعّلة فقط',
  TOO_MANY_COMBINATIONS: 'عدد كبير جداً من الأصناف دفعة واحدة (الحد 500)',
  STOCKTAKE_INVALID_STATE: 'حالة الجرد لا تسمح بهذا الإجراء',
  STOCKTAKE_UNCOUNTED_LINES: 'بعض الأصناف لم تُعدّ بعد',
  STOCKTAKE_VARIANT_OUT_OF_SCOPE: 'هذا الصنف ليس ضمن هذا الجرد',
  STOCKTAKE_SECOND_APPROVER_REQUIRED: 'يجب أن يعتمد الجرد شخص غير الذي أنشأه',
  LOCKOUT_PREVENTED: 'لا يمكن تنفيذ هذا: سيُفقد الوصول إلى إدارة المستخدمين',
  EMAIL_TAKEN: 'يوجد حساب بهذا البريد الإلكتروني',
  IDEMPOTENCY_KEY_REQUIRED: 'خطأ داخلي في الطلب، أعد المحاولة',
  NETWORK: 'تعذّر الاتصال بالخادم',
  PERIOD_CLOSED: 'هذا الشهر مُقفل: لا يمكن تسجيل شيء بتاريخ داخله',
  PERIOD_NOT_CLOSABLE: 'تُقفل الأشهر بالترتيب، وبعد انتهاء الشهر فقط',
  DATE_IN_FUTURE: 'لا يمكن أن يكون التاريخ بعد اليوم',
  RATE_NOT_SET: 'لم يُحدَّد سعر الصرف لهذه العملة — أدخله في «أسعار الصرف» أو في السند',
  ACCOUNT_NOT_USABLE: 'لا يمكن استخدام هذا الحساب هنا',
  CURRENCY_MISMATCH: 'عملتا الحسابين مختلفتان — استخدم «صرافة» لتبديل العملة',
  ENTRY_NOT_BALANCED: 'القيد غير متوازن: مجموع المدين يجب أن يساوي مجموع الدائن',
  AMOUNT_TOO_SMALL: 'المبلغ أصغر من سنت واحد',
  ENTRY_NOT_REVERSIBLE: 'لا يمكن عكس هذا القيد',
  ACCOUNT_IS_SYSTEM: 'هذا الحساب يستخدمه النظام ولا يُوقف',
  LOCATION_NOT_A_STORE: 'نقطة البيع تعمل في المتجر فقط',
  SHIFT_ALREADY_OPEN: 'يوجد وردية مفتوحة في هذا المتجر',
  SHIFT_NOT_OPEN: 'الوردية مغلقة — افتح وردية جديدة',
  NO_RETAIL_PRICE: 'هذه القطعة ليس لها سعر مفرق بالليرة السورية بعد — اطلب من المدير وضع السعر',
  PAYMENT_TOO_LOW: 'المبلغ المدفوع أقل من المطلوب',
  REFUND_EXCEEDS_SALE: 'الكمية أكبر مما بقي في الفاتورة',
  NOT_REFUNDABLE: 'لا يمكن إرجاع هذه الفاتورة هنا',
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    // A type still chosen in categories: name them, so the owner knows where to remove it.
    const categories = error.details.categories;
    if (error.code === 'OPTION_IN_USE' && Array.isArray(categories)) {
      return `لا يمكن الحذف: هذا النوع مستخدم في التصنيفات: ${categories.join('، ')} — أزله من إعدادات التصنيف أولاً`;
    }
    return ERRORS[error.code] ?? `خطأ: ${error.code}`;
  }
  return ERRORS.NETWORK!;
}

export const STOCKTAKE_STATUS: Record<string, string> = {
  DRAFT: 'مسودة',
  COUNTING: 'قيد العد',
  REVIEW: 'بانتظار الاعتماد',
  APPLIED: 'معتمد',
  CANCELLED: 'ملغى',
};

export const MOVEMENT_TYPE: Record<string, string> = {
  OPENING: 'جرد افتتاحي',
  PURCHASE: 'إدخال',
  SALE: 'بيع / إخراج',
  RETURN: 'مرتجع',
  TRANSFER_OUT: 'نقل — خروج',
  TRANSFER_IN: 'نقل — دخول',
  ADJUSTMENT: 'تعديل',
  DAMAGE: 'تالف',
  STOCKTAKE: 'فرق جرد',
};

/** سند قبض، سند صرف… — the name of each kind of journal entry (ADR-013). */
export const VOUCHER_TYPE: Record<string, string> = {
  RECEIPT: 'سند قبض',
  PAYMENT: 'سند صرف',
  TRANSFER: 'تحويل بين صناديق',
  EXCHANGE: 'صرافة',
  JOURNAL: 'قيد يومية',
  INVENTORY: 'قيد مخزون',
  REVALUATION: 'إعادة تقييم',
  REVERSAL: 'قيد عكسي',
  RETAIL: 'وردية المتجر',
};

export const BRANCH: Record<string, string> = { SY: 'سوريا', LY: 'ليبيا' };

/** "قبض 2026/0007": the number on the paper. */
export function voucherNumber(e: { voucherYear: number; voucherNo: number }): string {
  return `${e.voucherYear}/${String(e.voucherNo).padStart(4, '0')}`;
}

/** Today in Damascus as YYYY-MM-DD, the business date of the books. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(new Date());
}

export const ROLE: Record<string, string> = {
  owner: 'المالك',
  manager: 'مدير',
  inventory_manager: 'مدير مخزون',
  warehouse_keeper: 'أمين مستودع',
  store_staff: 'موظف متجر',
  accountant: 'محاسب',
};

export const LOCATION_KIND: Record<LocationKind, string> = { WAREHOUSE: 'مخزن', STORE: 'متجر' };

export const SESSION_KIND: Record<SessionKind, string> = {
  OPENING: 'جرد افتتاحي',
  RECEIVE: 'إدخال بضاعة',
  TRANSFER: 'نقل بضاعة',
  DAMAGE: 'تالف',
  SALE: 'إخراج / بيع',
  RETURN: 'مرتجع',
};

const numberFormat = new Intl.NumberFormat('ar-SY-u-nu-latn');

export function formatQuantity(n: number): string {
  return numberFormat.format(n);
}

/** ISO 4217 decimals: the Libyan dinar has 1000 dirhams (ADR-012). */
export const EXPONENT: Record<Currency, number> = { SYP: 2, USD: 2, LYD: 3, TRY: 2 };
export const CURRENCY_SYMBOL: Record<Currency, string> = {
  SYP: 'ل.س',
  USD: '$',
  LYD: 'د.ل',
  TRY: 'ل.ت',
};

export const CURRENCY_NAME: Record<Currency, string> = {
  SYP: 'ليرة سورية',
  USD: 'دولار',
  LYD: 'دينار ليبي',
  TRY: 'ليرة تركية',
};

/** Each price list: its currency and its names on screen (ADR-012). */
export const PRICE_META: Record<
  PriceKey,
  { currency: Currency; label: string; short: string; term: 'retail' | 'wholesale' }
> = {
  retailSyp: { currency: 'SYP', label: 'المفرق — سوريا (ل.س)', short: 'مفرق ل.س', term: 'retail' },
  retailLyd: { currency: 'LYD', label: 'المفرق — ليبيا (د.ل)', short: 'مفرق د.ل', term: 'retail' },
  wholesale: { currency: 'USD', label: 'الجملة ($)', short: 'جملة $', term: 'wholesale' },
};

/** Minor units (string) → display. Without a currency it is USD, the reporting currency. */
export function formatMoney(minor: string | null, currency: Currency = 'USD'): string {
  if (minor === null) return '—';
  const value = BigInt(minor);
  // The sign is kept apart: -0.50 has a whole part of 0, which has no sign of its own.
  const magnitude = value < 0n ? -value : value;
  const scale = 10n ** BigInt(EXPONENT[currency]);
  const fraction = magnitude % scale;
  const text =
    numberFormat.format(magnitude / scale) +
    (fraction ? `.${fraction.toString().padStart(EXPONENT[currency], '0')}` : '');
  return `${value < 0n ? '-' : ''}${text} ${CURRENCY_SYMBOL[currency]}`;
}

/** Minor units of `currency` → USD cents at `rate` (units per 1 USD), exactly: no floats. */
export function toUsdCents(minor: string, currency: Currency, rate: string): string {
  const [whole = '0', fraction = ''] = rate.split('.');
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  if (micros === 0n) return '0';
  const n = BigInt(minor) * 100n * 1_000_000n;
  const d = 10n ** BigInt(EXPONENT[currency]) * micros;
  const magnitude = ((n < 0n ? -n : n) * 2n + d) / (2n * d);
  return (n < 0n ? -magnitude : magnitude).toString();
}

/**
 * Minor units of a drawer currency → SYP minor units, through the dollar rates (units per
 * 1 USD). The same rule as the server (retail/pos-money.ts), so the screen shows what it will
 * charge.
 */
export function toSypMinor(
  amount: bigint,
  currency: Currency,
  rates: Partial<Record<Currency, string>>,
): bigint | null {
  if (currency === 'SYP') return amount;
  const micros = (rate: string | undefined) => {
    if (!rate) return null;
    const [whole = '0', fraction = ''] = rate.split('.');
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6));
  };
  const syp = micros(rates.SYP);
  const own = currency === 'USD' ? 1_000_000n : micros(rates[currency]);
  if (!syp || !own) return null;
  const n = amount * syp * 10n ** BigInt(EXPONENT.SYP);
  const d = own * 10n ** BigInt(EXPONENT[currency]);
  return (n * 2n + d) / (2n * d);
}

/** A selling price, or a clear "no price yet". */
export function formatPrice(price: Money | null): string {
  return price ? formatMoney(price.amount, price.currency) : 'بدون سعر';
}

/** Both retail prices on one line: "350,000 ل.س · 125.5 د.ل". */
export function formatRetail(prices: Prices): string {
  const both = [prices.retailSyp, prices.retailLyd].filter((p) => p !== null);
  return both.length ? both.map(formatPrice).join(' · ') : 'بدون سعر';
}

/** "250000" or "1.5" as typed → minor units of `currency`, without ever using a float. */
export function toMinorUnits(text: string, currency: Currency = 'USD'): string | null {
  const digits = EXPONENT[currency];
  const clean = text.replace(/[,\s]/g, '');
  const match = new RegExp(`^(\\d{1,15})(?:\\.(\\d{1,${digits}}))?$`).exec(clean);
  if (!match) return null;
  const scale = 10n ** BigInt(digits);
  return (BigInt(match[1]!) * scale + BigInt((match[2] ?? '').padEnd(digits, '0'))).toString();
}

/** Minor units → the text a person would type ("25000000" → "250000", "150" → "1.50"). Exact. */
export function fromMinorUnits(minor: string, currency: Currency = 'USD'): string {
  const digits = EXPONENT[currency];
  const scale = 10n ** BigInt(digits);
  const value = BigInt(minor);
  const fraction = value % scale;
  return fraction === 0n
    ? (value / scale).toString()
    : `${value / scale}.${fraction.toString().padStart(digits, '0')}`;
}

/** "قطني، كتان , صوف" → ['قطني', 'كتان', 'صوف'] — Arabic and Latin commas both work. */
export const splitList = (text: string) =>
  text
    .split(/[,،]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** "ثوب عربي · سعودية · ملكي · 56" — the product name plus every chosen option. */
export function variantName(v: Pick<Variant, 'title' | 'product'>): string {
  return v.title ? `${v.product.nameAr} · ${v.title}` : v.product.nameAr;
}

/** "جوخ هندي مشخط": a value read with what it details. */
export function valueLabel(group: OptionGroup, value: OptionValue): string {
  const parts = [value.valueAr];
  for (let p = value.parentId; p;) {
    const parent = group.values.find((v) => v.id === p);
    if (!parent) break;
    parts.unshift(parent.valueAr);
    p = parent.parentId;
  }
  return parts.join(' ');
}

/**
 * What a piece can be made of: active values without active details (a value with details is a
 * heading), whose headings are active too. In list order, details right after their heading.
 */
export function choosableValues(group: OptionGroup): OptionValue[] {
  const active = (v: OptionValue): boolean =>
    v.isActive && (!v.parentId || active(group.values.find((p) => p.id === v.parentId)!));
  const out: OptionValue[] = [];
  const walk = (parentId: string | null) => {
    for (const v of group.values.filter((x) => x.parentId === parentId && active(x))) {
      const details = group.values.filter((d) => d.parentId === v.id && d.isActive);
      if (details.length) walk(v.id);
      else out.push(v);
    }
  };
  walk(null);
  return out;
}
