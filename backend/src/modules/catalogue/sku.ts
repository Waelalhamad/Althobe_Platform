// Readable SKUs (owner, 2026-10-09): the product code plus the short code of each chosen value,
// in type order — THB-SA-RY-MD-SN-JH-WH-56. The barcode stays a plain sequence (ADR-003).

export const CODE_PATTERN = /^[A-Z0-9]{1,6}$/;

const LETTERS: Record<string, string> = {
  ا: 'A',
  أ: 'A',
  إ: 'A',
  آ: 'A',
  ى: 'A',
  ع: 'A',
  ب: 'B',
  ت: 'T',
  ث: 'TH',
  ج: 'J',
  ح: 'H',
  خ: 'KH',
  د: 'D',
  ذ: 'DH',
  ر: 'R',
  ز: 'Z',
  س: 'S',
  ش: 'SH',
  ص: 'S',
  ض: 'D',
  ط: 'T',
  ظ: 'Z',
  غ: 'GH',
  ف: 'F',
  ق: 'Q',
  ك: 'K',
  ل: 'L',
  م: 'M',
  ن: 'N',
  ه: 'H',
  ة: 'H',
  و: 'W',
  ي: 'Y',
  ئ: 'Y',
  ؤ: 'W',
  ء: '',
};

const latin = (word: string) =>
  [...word].map((ch) => LETTERS[ch] ?? (/[A-Za-z0-9]/.test(ch) ? ch.toUpperCase() : '')).join('');

/**
 * A first suggestion for a value's code, from its Arabic name; the owner can change it.
 * Numbers stay numbers (56 → 56); several words give their initials (جوخ هندي → JH, 3 قطع → 3Q);
 * one word gives its first three letters (كحلي → KHL).
 */
export function suggestCode(valueAr: string): string {
  const text = valueAr.trim();
  if (/^[0-9]{1,6}$/.test(text)) return text;
  const words = text.split(/[\s/\-–,،]+/).filter(Boolean);
  const code =
    words.length > 1
      ? words.map((w) => (/^[0-9]+$/.test(w) ? w : latin(w).charAt(0))).join('')
      : latin(text).slice(0, 3);
  return code.slice(0, 6) || 'V';
}

/** `code`, or `code` with 2, 3, … appended until it is not in `taken` (≤ 6 characters). */
export function freeCode(code: string, taken: ReadonlySet<string>): string {
  if (!taken.has(code)) return code;
  for (let n = 2; ; n++) {
    const candidate = code.slice(0, 6 - String(n).length) + n;
    if (!taken.has(candidate)) return candidate;
  }
}

export function buildSku(productCode: string, valueCodes: readonly string[]): string {
  return [productCode, ...valueCodes].join('-');
}
