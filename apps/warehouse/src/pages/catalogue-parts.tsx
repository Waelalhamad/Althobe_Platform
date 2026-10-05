import { Button, Chip, Field, Input } from '@althobe/ui/components';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type OptionGroup } from '../api';
import { choosableValues, errorText, toMinorUnits, valueLabel } from '../format';
import { optionGroupsQuery } from '../queries';

// Pieces shared by the category and product pages (ADR-011).

/** At most this many sizes per click; the server enforces the same limit. */
export const MAX_COMBINATIONS = 500;

/** Refreshes everything that shows categories, products, sizes or photos. */
export function useCatalogueRefresh() {
  const queryClient = useQueryClient();
  return async () => {
    for (const key of ['categories', 'products', 'product', 'variants', 'photos']) {
      await queryClient.invalidateQueries({ queryKey: [key] });
    }
  };
}

/** The values of one option type as tappable chips; a missing value can be added on the spot. */
export function GroupPicker({
  group,
  chosen,
  onToggle,
  onSetAll,
}: {
  group: OptionGroup;
  chosen: string[];
  onToggle: (valueId: string) => void;
  onSetAll: (valueIds: string[]) => void;
}) {
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
      onToggle(value.id);
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
            onClick={() => onSetAll(allChosen ? [] : active.map((v) => v.id))}
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
        {active.map((v) => (
          <Chip
            key={v.id}
            selected={chosen.includes(v.id)}
            disabled={!group.isActive}
            onClick={() => onToggle(v.id)}
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

/**
 * The typed prices as minor units: undefined for an empty field, or null when either field is
 * not a valid amount (so nothing is sent).
 */
export function parsePrices(retail: string, wholesale: string) {
  const one = (text: string) => (text.trim() ? toMinorUnits(text) : undefined);
  const [r, w] = [one(retail), one(wholesale)];
  return r === null || w === null ? null : { retail: r, wholesale: w };
}

/** Only the prices that were typed, ready to send. */
export function typedPrices(prices: ReturnType<typeof parsePrices>) {
  if (!prices || (!prices.retail && !prices.wholesale)) return undefined;
  return {
    ...(prices.retail ? { retail: prices.retail } : {}),
    ...(prices.wholesale ? { wholesale: prices.wholesale } : {}),
  };
}

export function PriceField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const invalid = value.trim() !== '' && toMinorUnits(value) === null;
  return (
    <div className="w-48">
      <Field label={`${label} ($)`}>
        <Input
          dir="ltr"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="25.00"
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
  editable,
  muted = false,
  onSave,
}: {
  text: string;
  initial: string;
  label: string;
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
  const amount = value.trim() ? toMinorUnits(value) : null;
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
