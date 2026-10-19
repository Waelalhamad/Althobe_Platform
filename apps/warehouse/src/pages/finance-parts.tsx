import { Field, Input, Select } from '@althobe/ui/components';
import { useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { Branch, Currency, GlAccount, Range } from '../api';
import { BRANCH, formatMoney } from '../format';

// Pieces shared by the accounting pages (ADR-013).

export const CLASS_NAME: Record<number, string> = {
  1: 'الأصول',
  2: 'الخصوم',
  3: 'حقوق الملكية',
  4: 'الإيرادات',
  5: 'المصاريف',
};

/** Every accounting query key starts with 'books': one call refreshes them all. */
export function useRefreshBooks() {
  const queryClient = useQueryClient();
  return async () => queryClient.invalidateQueries({ queryKey: ['books'] });
}

/** A postable account, picked from the chart grouped by class. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  label,
  hint,
}: {
  accounts: GlAccount[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  hint?: string;
}) {
  const classes = [...new Set(accounts.map((a) => a.class))].sort();
  return (
    <Field label={label} hint={hint}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— اختر —</option>
        {classes.map((c) => (
          <optgroup key={c} label={CLASS_NAME[c]}>
            {accounts
              .filter((a) => a.class === c)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} · {a.nameAr}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
    </Field>
  );
}

/** From / to / country, the filter on every report. */
export function RangeFilter({
  range,
  onChange,
  children,
}: {
  range: Range;
  onChange: (range: Range) => void;
  children?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
      <div className="w-40">
        <Field label="من تاريخ">
          <Input
            type="date"
            value={range.from ?? ''}
            onChange={(e) => onChange({ ...range, from: e.target.value || undefined })}
          />
        </Field>
      </div>
      <div className="w-40">
        <Field label="إلى تاريخ">
          <Input
            type="date"
            value={range.to ?? ''}
            onChange={(e) => onChange({ ...range, to: e.target.value || undefined })}
          />
        </Field>
      </div>
      <BranchSelect value={range.branch} onChange={(branch) => onChange({ ...range, branch })} />
      {children}
    </div>
  );
}

export function BranchSelect({
  value,
  onChange,
}: {
  value: Branch | undefined;
  onChange: (branch: Branch | undefined) => void;
}) {
  return (
    <div className="w-36">
      <Field label="البلد">
        <Select
          value={value ?? ''}
          onChange={(e) => onChange((e.target.value || undefined) as Branch | undefined)}
        >
          <option value="">الكل</option>
          <option value="SY">{BRANCH.SY}</option>
          <option value="LY">{BRANCH.LY}</option>
        </Select>
      </Field>
    </div>
  );
}

/** A signed USD amount split into debit and credit cells. */
export function DebitCredit({ base }: { base: string }) {
  const value = BigInt(base);
  return (
    <>
      <td className="tabular p-2">{value > 0n ? formatMoney(base) : ''}</td>
      <td className="tabular p-2">{value < 0n ? formatMoney((-value).toString()) : ''}</td>
    </>
  );
}

/** The amount in its own currency, when that is not USD: "1,220,000 ل.س @ 122". */
export function OwnCurrency({
  amount,
  currency,
  rate,
}: {
  amount: string;
  currency: Currency;
  rate: string;
}) {
  if (currency === 'USD' || amount === '0') return null;
  return (
    <span className="tabular text-sm text-ink-muted">
      {formatMoney(amount, currency)} @ {Number(rate)}
    </span>
  );
}

/** The first day of the month of a YYYY-MM-DD date. */
export const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
