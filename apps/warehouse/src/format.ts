import {
  ApiError,
  type Currency,
  type LocationKind,
  type Money,
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
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return ERRORS[error.code] ?? `خطأ: ${error.code}`;
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

/** Minor units (string, 2 decimals for both SYP and USD — ADR-004) → display. */
export function formatMoney(minor: string | null, currency: Currency = 'SYP'): string {
  if (minor === null) return '—';
  const value = BigInt(minor);
  const whole = value / 100n;
  const cents = (value < 0n ? -value : value) % 100n;
  const text = numberFormat.format(whole) + (cents ? `.${cents.toString().padStart(2, '0')}` : '');
  return `${text} ${currency === 'SYP' ? 'ل.س' : '$'}`;
}

/** A selling price, or a clear "no price yet". */
export function formatPrice(price: Money | null): string {
  return price ? formatMoney(price.amount, price.currency) : 'بدون سعر';
}

/** "250000" or "1.5" as typed → minor units as a string, without ever using a float. */
export function toMinorUnits(text: string): string | null {
  const clean = text.replace(/[,\s]/g, '');
  const match = /^(\d{1,15})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!match) return null;
  return (BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))).toString();
}

/** Minor units → the text a person would type ("25000000" → "250000", "150" → "1.50"). Exact. */
export function fromMinorUnits(minor: string): string {
  const value = BigInt(minor);
  const cents = value % 100n;
  return cents === 0n
    ? (value / 100n).toString()
    : `${value / 100n}.${cents.toString().padStart(2, '0')}`;
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
