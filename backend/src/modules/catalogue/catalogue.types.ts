import type { UnitOfMeasure } from '@prisma/client';

// ADR-011: category (ثوب) → product (one design) → variant (one size of it).

/** One chosen option of a product or variant, e.g. القصة: سعودية. */
export interface VariantOption {
  groupId: string;
  /** Built-in types only (CUT, BUTTON, ZIPPER, SLEEVE, FABRIC, COLOUR, SIZE); null for added types. */
  groupKey: string | null;
  group: string;
  valueId: string;
  /** With what it details: "جوخ هندي مشخط". */
  value: string;
}

/** A selling price: minor units of `currency` (ADR-004). Crosses the wire as a string. */
export interface PriceView {
  amount: bigint;
  currency: string;
}

export interface Prices {
  retail: PriceView | null;
  wholesale: PriceView | null;
}

/** Everything a scan screen needs to show about a variant (one size of a product). */
export interface VariantView {
  id: string;
  sku: string;
  barcode: string;
  isActive: boolean;
  /** The product's design options, then the size; in type order. */
  options: VariantOption[];
  /** The option values joined: "سعودية · ملكي · جوخ هندي مشخط · أبيض · 56". */
  title: string;
  /** The SIZE value, printed large on labels; null if the category has no size type. */
  size: string | null;
  /** Effective selling prices: this size's own price, else the product's (ADR-009). */
  prices: Prices;
  /** Which of `prices` are this size's own rather than the product's. */
  ownPrices: { retail: boolean; wholesale: boolean };
  /** The product's main photo (ADR-010); null if it has none. */
  photoId: string | null;
  product: {
    id: string;
    /** The product's SKU base, e.g. THB-SA-RY-MD-SN-JHST-WH. */
    code: string;
    /** The category's name, e.g. ثوب. */
    nameAr: string;
    nameEn: string | null;
    /** The design: "سعودية · ملكي · … · أبيض". */
    title: string;
    categoryId: string;
    unitOfMeasure: UnitOfMeasure;
    /** False when the product or its category is stopped. */
    isActive: boolean;
  };
}

export interface CategoryView {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string | null;
  parentId: string | null;
  sortOrder: number;
  isActive: boolean;
  unitOfMeasure: UnitOfMeasure;
  /** The option types its products are made with, in type order. */
  groupIds: string[];
  productCount: number;
}

export interface ProductView {
  id: string;
  code: string;
  isActive: boolean;
  category: { id: string; code: string; nameAr: string; isActive: boolean };
  /** One per non-size option type, in type order. */
  options: VariantOption[];
  /** "سعودية · ملكي · … · أبيض". */
  title: string;
  prices: Prices;
  mainPhotoId: string | null;
  /** Sizes (variants) not deleted. */
  variantCount: number;
}

export interface OptionValueView {
  id: string;
  /** The value this one details (جوخ هندي for مشخط); null at the top. */
  parentId: string | null;
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
