import { describe, expect, it } from 'vitest';
import { cartesian, moved, optionKey } from './catalogue.service.js';
import { buildSku, freeCode, suggestCode } from './sku.js';

describe('option helpers', () => {
  it('builds every combination, one entry per list, in list order', () => {
    expect(cartesian([['a', 'b'], ['x'], ['1', '2']])).toEqual([
      ['a', 'x', '1'],
      ['a', 'x', '2'],
      ['b', 'x', '1'],
      ['b', 'x', '2'],
    ]);
    expect(cartesian([['a'], []])).toEqual([]);
  });

  it('gives the same key whatever order the values were chosen in', () => {
    const a = '0199a7c4-0000-7000-8000-00000000000a';
    const b = '0199a7c4-0000-7000-8000-00000000000B'.toLowerCase();
    expect(optionKey([b, a])).toBe(optionKey([a, b]));
    // Code-point order, matching COLLATE "C" in the migration: '-' (0x2d) sorts before digits.
    expect(optionKey(['1-b', '1a'])).toBe('1-b,1a');
  });

  it('moves one place up or down and stays put at the ends', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(moved(items, 'b', 'up')).toEqual(['b', 'a', 'c']);
    expect(moved(items, 'b', 'down')).toEqual(['a', 'c', 'b']);
    expect(moved(items, 'a', 'up')).toEqual(['a', 'b', 'c']);
    expect(moved(items, 'c', 'down')).toEqual(['a', 'b', 'c']);
  });
});

describe('value codes for SKUs', () => {
  it('suggests a code from the Arabic name', () => {
    expect(suggestCode('كحلي')).toBe('KHL');
    expect(suggestCode('جوخ هندي')).toBe('JH');
    expect(suggestCode('3 قطع')).toBe('3Q');
    expect(suggestCode('فلت/كويتي')).toBe('FK');
    expect(suggestCode('56')).toBe('56');
    expect(suggestCode('Navy')).toBe('NAV');
  });

  it('makes a code unique within its type, staying within 6 characters', () => {
    expect(freeCode('KHL', new Set())).toBe('KHL');
    expect(freeCode('KHL', new Set(['KHL', 'KHL2']))).toBe('KHL3');
    expect(freeCode('ABCDEF', new Set(['ABCDEF']))).toBe('ABCDE2');
  });

  it('joins the product code and the value codes', () => {
    expect(buildSku('THB', ['SA', 'RY', 'MD', 'SN', 'JH', 'WH', '56'])).toBe(
      'THB-SA-RY-MD-SN-JH-WH-56',
    );
  });
});
