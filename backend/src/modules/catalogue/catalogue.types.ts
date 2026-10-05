import type { UnitOfMeasure } from '@prisma/client';

/** One chosen option of a variant, e.g. القصة: سعودية. */
export interface VariantOption {
  groupId: string;
  /** Built-in types only (CUT, BUTTON, ZIPPER, SLEEVE, FABRIC, COLOUR, SIZE); null for added types. */
  groupKey: string | null;
  group: string;
  valueId: string;
  value: string;
}

/** A selling price: minor units of `currency` (ADR-004). Crosses the wire as a string. */
export interface PriceView {
  amount: bigint;
  currency: string;
}

/** Everything a scan screen needs to show about a variant. */
export interface VariantView {
  id: string;
  sku: string;
  barcode: string;
  isActive: boolean;
  /** In the order of the option types: القصة, الزر, … القياس. */
  options: VariantOption[];
  /** The option values joined: "سعودية · ملكي · جوخ هندي · أبيض · 56". */
  title: string;
  /** The SIZE value, printed large on labels; null if the product has no size type. */
  size: string | null;
  /** Selling prices (ADR-009); null = not priced yet. */
  prices: { retail: PriceView | null; wholesale: PriceView | null };
  /** The product photo that shows this variant best (ADR-010); null if the product has none. */
  photoId: string | null;
  product: {
    id: string;
    code: string;
    nameAr: string;
    nameEn: string | null;
    unitOfMeasure: UnitOfMeasure;
    isActive: boolean;
  };
}

export interface ProductView {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  unitOfMeasure: UnitOfMeasure;
  isActive: boolean;
  /** The option types this product is made with, in type order. */
  groupIds: string[];
  /** The first photo, shown in product lists; null if none. */
  mainPhotoId: string | null;
}

export interface OptionValueView {
  id: string;
  valueAr: string;
  /** Short Latin code the SKU is built from. */
  code: string;
  sortOrder: number;
  isActive: boolean;
}

export interface OptionGroupView {
  id: string;
  key: string | null;
  nameAr: string;
  sortOrder: number;
  isActive: boolean;
  values: OptionValueView[];
}
