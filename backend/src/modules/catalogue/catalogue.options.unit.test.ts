import { describe, expect, it } from 'vitest';
import { cartesian, moved, optionKey } from './catalogue.service.js';

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
