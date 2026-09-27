// ADR-003 / docs/barcode.md: internal barcodes are EAN-13 in the GS1 restricted-distribution
// range (prefix 2), identifiers only.
//
//   2 00 000000001 5
//   | |  |         +-- check digit
//   | |  +------------ 9-digit sequence from variant_barcode_seq
//   | +--------------- entity type
//   +----------------- prefix 2

export const INTERNAL_PREFIX = '2';

export const BARCODE_ENTITY = {
  variant: '00',
  carton: '01',
  stocktakeTag: '02',
} as const;
export type BarcodeEntity = (typeof BARCODE_ENTITY)[keyof typeof BARCODE_ENTITY];

const MAX_SEQUENCE = 999_999_999n;

/** EAN-13 check digit over the first 12 digits: weights 1,3,1,3,… from the left. */
export function ean13CheckDigit(data12: string): number {
  if (!/^\d{12}$/.test(data12)) throw new RangeError('EAN-13 data must be exactly 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(data12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

export function buildInternalBarcode(entity: BarcodeEntity, sequence: bigint): string {
  if (sequence < 1n || sequence > MAX_SEQUENCE) {
    throw new RangeError(`Barcode sequence out of range: ${sequence}`);
  }
  const data = INTERNAL_PREFIX + entity + sequence.toString().padStart(9, '0');
  return data + String(ean13CheckDigit(data));
}

/** Looks like an EAN-13 (13 digits) but the check digit is wrong — almost always a misread. */
export function isMisreadEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && !isValidEan13(code);
}
