import { describe, expect, it } from 'vitest';
import {
  BARCODE_ENTITY,
  buildInternalBarcode,
  ean13CheckDigit,
  isMisreadEan13,
  isValidEan13,
} from './barcode.js';

describe('EAN-13 barcodes (ADR-003)', () => {
  it('computes the check digit from docs/barcode.md: 200000000001 -> 5', () => {
    expect(ean13CheckDigit('200000000001')).toBe(5);
  });

  it('builds the first variant barcode as 2000000000015', () => {
    expect(buildInternalBarcode(BARCODE_ENTITY.variant, 1n)).toBe('2000000000015');
  });

  it('agrees with a real-world EAN-13', () => {
    expect(isValidEan13('4006381333931')).toBe(true);
  });

  it('rejects a wrong check digit and reports it as a misread', () => {
    expect(isValidEan13('2000000000016')).toBe(false);
    expect(isMisreadEan13('2000000000016')).toBe(true);
    expect(isMisreadEan13('2000000000015')).toBe(false);
  });

  it('does not treat non-EAN input as a misread', () => {
    expect(isMisreadEan13('THB-000001')).toBe(false);
    expect(isMisreadEan13('12345')).toBe(false);
  });

  it('keeps the sequence inside its 9 digits', () => {
    expect(buildInternalBarcode(BARCODE_ENTITY.variant, 999_999_999n)).toMatch(/^200999999999\d$/);
    expect(() => buildInternalBarcode(BARCODE_ENTITY.variant, 0n)).toThrow(RangeError);
    expect(() => buildInternalBarcode(BARCODE_ENTITY.variant, 1_000_000_000n)).toThrow(RangeError);
  });

  it('every generated barcode validates', () => {
    for (const seq of [1n, 2n, 99n, 12_345n, 987_654_321n]) {
      expect(isValidEan13(buildInternalBarcode(BARCODE_ENTITY.variant, seq))).toBe(true);
    }
  });
});
