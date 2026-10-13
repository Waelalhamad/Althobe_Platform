import { Button, Chip, Field, Input } from '@althobe/ui/components';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, PRICE_KEYS, type Currency, type OptionGroup, type PriceKey } from '../api';
import {
  choosableValues,
  CURRENCY_SYMBOL,
  errorText,
  PRICE_META,
  toMinorUnits,
  valueLabel,
} from '../format';
import { optionGroupsQuery } from '../queries';

// Pieces shared by the category and product pages (ADR-011).

/** At most this many sizes per click; the server enforces the same limit. */
export const MAX_COMBINATIONS = 500;

/** Refreshes everything that shows categories, products, sizes or photos. */
export function useCatalogueRefresh() {
  const queryClient = useQueryClient();
  // In parallel: one at a time cost a full round trip to the server each.
  return async () => {
    await Promise.all(
      ['categories', 'products', 'product', 'variants', 'photos'].map(async (key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
}

/**
 * The values of one option type as tappable chips; a missing value can be added on the spot.
 * With `onSkip`, a «بدون» chip leaves the type out of these designs (buttons or a zip, not both):
 * it clears the values, and tapping a value turns it off again.
 */
export function GroupPicker({
  group,
  chosen,
  onToggle,
  onSetAll,
  skipped = false,
  onSkip,
}: {
  group: OptionGroup;
  chosen: string[];
  onToggle: (valueId: string) => void;
  onSetAll: (valueIds: string[]) => void;
  skipped?: boolean;
  onSkip?: (skipped: boolean) => void;
}) {
  const pick = (valueId: string) => {
    if (skipped) onSkip?.(false);
    onToggle(valueId);
  };
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState('');
  // Details, not their headings: جوخ هندي مونس / مشخط / ساده rather than جوخ هندي.
  const active = choosableValues(group);
  const allChosen = active.length > 0 && active.every((v) => chosen.includes(v.id));

  const add = useMutation({
    mutationFn: async () => api.addOptionValue(group.id, adding.trim()),
    onSuccess: async (value) => {
      setAdding('');
      await queryClient.invalidateQueries({ queryKey: optionGroupsQuery.queryKey });
      pick(value.id);
    },
  });

  return (
    <div role="group" aria-label={group.nameAr}>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-bold">{group.nameAr}</span>
        {active.length > 1 && (
          <button
            type="button"
            className="text-sm text-brand underline"
            onClick={() => {
              if (skipped) onSkip?.(false);
              onSetAll(allChosen ? [] : active.map((v) => v.id));
            }}
          >
            {allChosen ? 'إلغاء الكل' : 'اختيار الكل'}
          </button>
        )}
        {!group.isActive && (
          <span className="text-sm text-warn">
            هذا النوع مخفي — أظهره من صفحة الخيارات أو أزله من التصنيف
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onSkip && group.isActive && (
          <Chip
            selected={skipped}
            onClick={() => {
              onSkip(!skipped);
              if (!skipped) onSetAll([]);
            }}
          >
            بدون {group.nameAr}
          </Chip>
        )}
        {active.map((v) => (
          <Chip
            key={v.id}
            selected={chosen.includes(v.id)}
            disabled={!group.isActive}
            onClick={() => pick(v.id)}
          >
            {valueLabel(group, v)}
          </Chip>
        ))}
        {group.isActive && (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (adding.trim()) add.mutate();
            }}
          >
            <Input
              className="w-36"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              placeholder="+ قيمة جديدة"
            />
            {adding.trim() && (
              <Button type="submit" variant="secondary" disabled={add.isPending}>
                إضافة
              </Button>
            )}
          </form>
        )}
      </div>
      {add.isError && <div className="mt-1 text-sm text-bad">{errorText(add.error)}</div>}
    </div>
  );
}

/** Chosen value ids per option type, toggled by chip taps. */
export function useChosen() {
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const toggle = (groupId: string, valueId: string) =>
    setChosen((c) => {
      const current = c[groupId] ?? [];
      return {
        ...c,
        [groupId]: current.includes(valueId)
          ? current.filter((id) => id !== valueId)
          : [...current, valueId],
      };
    });
  const setAll = (groupId: string, ids: string[]) => setChosen((c) => ({ ...c, [groupId]: ids }));
  return { chosen, toggle, setAll };
}

/** The three price fields as typed (ADR-012). */
export type PriceTexts = Record<PriceKey, string>;
export const EMPTY_PRICES: PriceTexts = { retailSyp: '', retailLyd: '', wholesale: '' };

/**
 * Only the prices that were typed, as minor units of each list's currency, ready to send;
 * undefined when nothing was typed or any field is not a valid amount (so nothing is sent).
 */
export function typedPrices(texts: PriceTexts): Partial<Record<PriceKey, string>> | undefined {
  const out: Partial<Record<PriceKey, string>> = {};
  for (const key of PRICE_KEYS) {
    const text = texts[key].trim();
    if (!text) continue;
    const minor = toMinorUnits(text, PRICE_META[key].currency);
    if (minor === null) return undefined;
    out[key] = minor;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Every typed price is a valid amount in its currency (empty fields are fine). */
export function pricesValid(texts: PriceTexts): boolean {
  return PRICE_KEYS.every(
    (key) => !texts[key].trim() || toMinorUnits(texts[key], PRICE_META[key].currency) !== null,
  );
}

/** One field per price list, each in its own currency. */
export function PriceFields({
  values,
  onChange,
  labelPrefix = '',
}: {
  values: PriceTexts;
  onChange: (values: PriceTexts) => void;
  labelPrefix?: string;
}) {
  return (
    <>
      {PRICE_KEYS.map((key) => (
        <PriceField
          key={key}
          label={`${labelPrefix}${PRICE_META[key].label}`}
          currency={PRICE_META[key].currency}
          value={values[key]}
          onChange={(value) => onChange({ ...values, [key]: value })}
        />
      ))}
    </>
  );
}

function PriceField({
  label,
  currency,
  value,
  onChange,
}: {
  label: string;
  currency: Currency;
  value: string;
  onChange: (value: string) => void;
}) {
  const invalid = value.trim() !== '' && toMinorUnits(value, currency) === null;
  return (
    <div className="w-48">
      <Field label={label}>
        <Input
          dir="ltr"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={CURRENCY_SYMBOL[currency]}
          className={invalid ? 'border-bad' : ''}
        />
      </Field>
    </div>
  );
}

/** An amount that edits in place: click, type, Enter. Empty saves as "no price". */
export function EditableAmount({
  text,
  initial,
  label,
  currency,
  editable,
  muted = false,
  onSave,
}: {
  text: string;
  initial: string;
  label: string;
  currency: Currency;
  editable: boolean;
  muted?: boolean;
  onSave: (amount: string | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const save = useMutation({
    mutationFn: onSave,
    onSuccess: () => setEditing(false),
  });

  if (!editing) {
    if (!editable) return <span className={muted ? 'text-ink-muted' : ''}>{text}</span>;
    return (
      <button
        type="button"
        className={`hover:text-brand hover:underline ${muted ? 'text-ink-muted' : ''}`}
        onClick={() => {
          setValue(initial);
          setEditing(true);
        }}
      >
        {text}
      </button>
    );
  }
  const amount = value.trim() ? toMinorUnits(value, currency) : null;
  const valid = !value.trim() || amount !== null;
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate(amount);
      }}
    >
      <Input
        autoFocus
        dir="ltr"
        inputMode="decimal"
        aria-label={label}
        className={`w-24 ${valid ? '' : 'border-bad'}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <Button type="submit" variant="secondary" disabled={!valid || save.isPending}>
        حفظ
      </Button>
      {save.isError && <span className="text-sm text-bad">{errorText(save.error)}</span>}
    </form>
  );
}
