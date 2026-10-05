import { DomainError } from '../../shared/errors.js';

export class BarcodeNotFoundError extends DomainError {
  constructor(code: string) {
    super('BARCODE_NOT_FOUND', 'No variant carries this barcode', { barcode: code });
  }
}

export class InvalidBarcodeError extends DomainError {
  constructor(code: string) {
    super('INVALID_BARCODE', 'Barcode check digit is wrong — probably a misread', {
      barcode: code,
    });
  }
}

export class ProductCodeTakenError extends DomainError {
  constructor(code: string) {
    super('PRODUCT_CODE_TAKEN', 'A product with this code already exists', { code });
  }
}

export class ProductInactiveError extends DomainError {
  constructor(productId: string) {
    super('PRODUCT_INACTIVE', 'Product is inactive', { productId });
  }
}

export class BarcodeTakenError extends DomainError {
  constructor(code: string) {
    super('BARCODE_TAKEN', 'This barcode is already assigned', { barcode: code });
  }
}

export class OptionGroupTakenError extends DomainError {
  constructor(nameAr: string) {
    super('OPTION_GROUP_TAKEN', 'An option type with this name already exists', { nameAr });
  }
}

export class OptionValueTakenError extends DomainError {
  constructor(valueAr: string) {
    super('OPTION_VALUE_TAKEN', 'This value already exists in this option type', { valueAr });
  }
}

export class OptionCodeTakenError extends DomainError {
  constructor(code: string) {
    super('OPTION_CODE_TAKEN', 'Another value of this type already has this code', { code });
  }
}

export class OptionValueTooDeepError extends DomainError {
  constructor() {
    super('OPTION_VALUE_TOO_DEEP', 'Details go at most three levels deep');
  }
}

/** Option types that are unknown or inactive, given to a product. */
export class InvalidOptionGroupsError extends DomainError {
  constructor(groupIds: string[]) {
    super('INVALID_OPTION_GROUPS', 'Unknown or inactive option type', { groupIds });
  }
}

/** A type removed from a product while some of its variants still carry a value of it. */
export class OptionGroupInUseError extends DomainError {
  constructor(groupIds: string[]) {
    super('OPTION_GROUP_IN_USE', 'Variants of this product use this option type', { groupIds });
  }
}

/** The chosen values must give one list of active values per option type of the product. */
export class InvalidSelectionError extends DomainError {
  constructor(reason: string, details: Record<string, unknown> = {}) {
    super('INVALID_SELECTION', reason, details);
  }
}

export class TooManyCombinationsError extends DomainError {
  constructor(count: number, max: number) {
    super('TOO_MANY_COMBINATIONS', `${count} combinations requested; at most ${max} at once`, {
      count,
      max,
    });
  }
}

export class CategoryCodeTakenError extends DomainError {
  constructor(code: string) {
    super('CATEGORY_CODE_TAKEN', 'A category with this code already exists', { code });
  }
}

export class CategoryInactiveError extends DomainError {
  constructor(categoryId: string) {
    super('CATEGORY_INACTIVE', 'Category is stopped', { categoryId });
  }
}

export class CategoryTooDeepError extends DomainError {
  constructor() {
    super(
      'CATEGORY_TOO_DEEP',
      'Categories nest three levels deep at most, and never in themselves',
    );
  }
}

export class CategoryHasChildrenError extends DomainError {
  constructor() {
    super('CATEGORY_HAS_CHILDREN', 'Delete or move its sub-categories first');
  }
}

/** The ledger keeps every movement for good: what ever had stock is stopped, not deleted. */
export class HasStockError extends DomainError {
  constructor() {
    super('HAS_STOCK', 'It has stock movements: stop it instead of deleting it');
  }
}
