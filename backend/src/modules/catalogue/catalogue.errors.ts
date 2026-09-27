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
