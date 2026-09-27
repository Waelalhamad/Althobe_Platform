import type { UnitOfMeasure } from '@prisma/client';

/** Everything a scan screen needs to show about a variant. */
export interface VariantView {
  id: string;
  sku: string;
  barcode: string;
  fabric: string;
  colour: string;
  size: string;
  isActive: boolean;
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
}
