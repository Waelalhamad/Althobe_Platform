import { Field, Input, Select } from '@althobe/ui/components';
import { useState } from 'react';
import type { Variant } from './api';

/**
 * Narrowing a list of sizes: by text, by product, and by each option (القماش، اللون، القياس…).
 * The choices come from the sizes given, so no filter leads to an empty list. Used where stock
 * is shown (الأرصدة) and picked without scanning (a shipment).
 */
export function useVariantFilters(variants: readonly Variant[]) {
  const [text, setText] = useState('');
  const [category, setCategory] = useState('');
  // One chosen value per option group, by group id.
  const [picked, setPicked] = useState<Record<string, string>>({});

  const categories = [...new Set(variants.map((v) => v.product.nameAr))].sort();
  const groups = new Map<string, { name: string; values: Set<string> }>();
  for (const v of variants)
    for (const o of v.options) {
      const g = groups.get(o.groupId) ?? { name: o.group, values: new Set<string>() };
      g.values.add(o.value);
      groups.set(o.groupId, g);
    }

  const needle = text.trim().toLowerCase();
  const matches = (v: Variant) => {
    if (
      needle &&
      ![v.product.nameAr, v.product.code, v.sku, v.barcode, v.title].some((f) =>
        f.toLowerCase().includes(needle),
      )
    )
      return false;
    if (category && v.product.nameAr !== category) return false;
    for (const [groupId, value] of Object.entries(picked))
      if (value && !v.options.some((o) => o.groupId === groupId && o.value === value)) return false;
    return true;
  };

  const searchField = (
    <Field label="بحث" hint="بالاسم أو الباركود أو SKU أو القماش أو اللون أو القياس">
      <Input value={text} onChange={(e) => setText(e.target.value)} />
    </Field>
  );
  const selectFields = (
    <>
      <Field label="المنتج">
        <Select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">الكل</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      {[...groups].map(([groupId, g]) => (
        <Field key={groupId} label={g.name}>
          <Select
            value={picked[groupId] ?? ''}
            onChange={(e) => setPicked({ ...picked, [groupId]: e.target.value })}
          >
            <option value="">الكل</option>
            {[...g.values]
              .sort((x, y) => x.localeCompare(y, 'ar', { numeric: true }))
              .map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
          </Select>
        </Field>
      ))}
    </>
  );

  return {
    matches,
    filtering: Boolean(needle || category) || Object.values(picked).some(Boolean),
    clear: () => {
      setText('');
      setCategory('');
      setPicked({});
    },
    searchField,
    selectFields,
  };
}
