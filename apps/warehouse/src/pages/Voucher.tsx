import {
  Alert,
  Button,
  Card,
  Chip,
  Field,
  Input,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, type Branch, type Currency, type GlAccount, type Voucher } from '../api';
import {
  BRANCH,
  CURRENCY_SYMBOL,
  errorText,
  formatMoney,
  toMinorUnits,
  toUsdCents,
  today,
  VOUCHER_TYPE,
  voucherNumber,
} from '../format';
import { PAGES } from '../help';
import { glAccountsQuery, ratesQuery } from '../queries';
import { AccountSelect, useRefreshBooks } from './finance-parts';

export type VoucherKind = 'RECEIPT' | 'PAYMENT' | 'TRANSFER' | 'EXCHANGE' | 'JOURNAL';
const KINDS: VoucherKind[] = ['RECEIPT', 'PAYMENT', 'TRANSFER', 'EXCHANGE', 'JOURNAL'];

const RATE_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;

/** New voucher. One page for the five kinds: the fields follow the kind. */
export function VoucherPage() {
  const { kind } = useSearch({ from: '/app/finance/new' });
  const navigate = useNavigate();
  const toast = useToast();
  const refresh = useRefreshBooks();
  const { data: accounts = [] } = useQuery(glAccountsQuery);
  const { data: rates = [] } = useQuery(ratesQuery);
  // One key per voucher: a double click or a retry posts it once.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState<FormState>(EMPTY);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  const usable = accounts.filter((a) => a.isPostable && a.isActive);
  const boxes = usable.filter((a) => a.kind === 'CASH');
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const ownerRate = (c: Currency | null | undefined) =>
    c && c !== 'USD' ? (rates.find((r) => r.currency === c)?.rate ?? '') : '1';

  const built = build(kind, form, byId, ownerRate);

  const post = useMutation({
    mutationFn: async () => api.postVoucher(built.voucher!, key),
    onSuccess: async (entry) => {
      toast(`تم تسجيل ${VOUCHER_TYPE[entry.voucherType]} رقم ${voucherNumber(entry)}`);
      setKey(crypto.randomUUID());
      setForm(EMPTY);
      // Open the new entry at once; the books refresh behind it.
      void refresh();
      await navigate({ to: '/finance/entries/$entryId', params: { entryId: entry.id } });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (built.voucher && !post.isPending) post.mutate();
  };

  const box = byId.get(form.boxId);
  const from = byId.get(form.fromBoxId);
  const to = byId.get(form.toBoxId);

  return (
    <>
      <PageTitle intro={PAGES.voucher}>{VOUCHER_TYPE[kind]}</PageTitle>
      <div className="mb-4 flex flex-wrap gap-2">
        {KINDS.map((k) => (
          <Chip
            key={k}
            selected={k === kind}
            onClick={() => void navigate({ to: '/finance/new', search: { kind: k } })}
          >
            {VOUCHER_TYPE[k]}
          </Chip>
        ))}
      </div>

      <Card>
        <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4">
          <div className="w-48">
            <Field label="التاريخ">
              <Input
                type="date"
                max={today()}
                value={form.date}
                onChange={(e) => set({ date: e.target.value })}
              />
            </Field>
          </div>

          {(kind === 'RECEIPT' || kind === 'PAYMENT') && (
            <>
              <BoxSelect
                label={kind === 'RECEIPT' ? 'إلى الصندوق' : 'من الصندوق'}
                boxes={boxes}
                value={form.boxId}
                onChange={(boxId) => set({ boxId, rate: '' })}
              />
              <AccountSelect
                label={
                  kind === 'RECEIPT' ? 'من أين؟ (الحساب المقابل)' : 'على ماذا؟ (الحساب المقابل)'
                }
                hint={
                  kind === 'RECEIPT'
                    ? 'مبيعات اليوم ← «مبيعات المفرق». مال وضعته أنت ← «جاري المالك». رصيد موجود قبل النظام ← «أرصدة افتتاحية».'
                    : 'إيجار، كهرباء، نقل… ← حسابه في المصاريف. مال سحبته أنت ← «جاري المالك». دفعة لمورد ← «الموردون».'
                }
                accounts={usable.filter(
                  (a) =>
                    a.kind === 'GENERAL' && (!a.currency || !box || a.currency === box.currency),
                )}
                value={form.counterAccountId}
                onChange={(counterAccountId) => set({ counterAccountId })}
              />
              <AmountField
                currency={box?.currency ?? null}
                value={form.amount}
                onChange={(amount) => set({ amount })}
              />
              <RateField
                currency={box?.currency ?? null}
                value={form.rate}
                fallback={ownerRate(box?.currency)}
                onChange={(rate) => set({ rate })}
              />
            </>
          )}

          {kind === 'TRANSFER' && (
            <>
              <BoxSelect
                label="من الصندوق"
                boxes={boxes}
                value={form.fromBoxId}
                onChange={(fromBoxId) => set({ fromBoxId, toBoxId: '', rate: '' })}
              />
              <BoxSelect
                label="إلى الصندوق (نفس العملة)"
                boxes={boxes.filter(
                  (b) => b.id !== form.fromBoxId && (!from || b.currency === from.currency),
                )}
                value={form.toBoxId}
                onChange={(toBoxId) => set({ toBoxId })}
              />
              <AmountField
                currency={from?.currency ?? null}
                value={form.amount}
                onChange={(amount) => set({ amount })}
              />
              <RateField
                currency={from?.currency ?? null}
                value={form.rate}
                fallback={ownerRate(from?.currency)}
                onChange={(rate) => set({ rate })}
              />
            </>
          )}

          {kind === 'EXCHANGE' && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <BoxSelect
                  label="أعطيت من الصندوق"
                  boxes={boxes}
                  value={form.fromBoxId}
                  onChange={(fromBoxId) => set({ fromBoxId, toBoxId: '' })}
                />
                <AmountField
                  label="المبلغ الذي أعطيته"
                  currency={from?.currency ?? null}
                  value={form.amount}
                  onChange={(amount) => set({ amount })}
                />
                <BoxSelect
                  label="أخذت إلى الصندوق (عملة أخرى)"
                  boxes={boxes.filter((b) => !from || b.currency !== from.currency)}
                  value={form.toBoxId}
                  onChange={(toBoxId) => set({ toBoxId })}
                />
                <AmountField
                  label="المبلغ الذي أخذته"
                  currency={to?.currency ?? null}
                  value={form.toAmount}
                  onChange={(toAmount) => set({ toAmount })}
                />
              </div>
              {from && to && from.currency !== 'USD' && to.currency !== 'USD' && (
                <RateField
                  currency={from.currency}
                  value={form.rate}
                  fallback={ownerRate(from.currency)}
                  onChange={(rate) => set({ rate })}
                />
              )}
              {built.dealRate && (
                <p className="text-ink-muted">
                  سعر هذه الصفقة: <span className="tabular font-bold">{built.dealRate}</span>
                </p>
              )}
            </>
          )}

          {kind === 'JOURNAL' && (
            <JournalLines
              accounts={usable.filter(
                (a) => a.kind !== 'INVENTORY' && (!a.currency || a.currency === 'USD'),
              )}
              form={form}
              set={set}
            />
          )}

          <Field
            label={
              kind === 'RECEIPT' || kind === 'PAYMENT' || kind === 'JOURNAL'
                ? 'البيان'
                : 'البيان (اختياري)'
            }
          >
            <Input value={form.memo} onChange={(e) => set({ memo: e.target.value })} />
          </Field>

          {built.preview && (
            <p className="rounded-lg bg-blush px-3 py-2 text-sm">
              القيمة في الدفاتر: <span className="tabular font-bold">{built.preview}</span>
            </p>
          )}
          {post.isError && <Alert>{errorText(post.error)}</Alert>}
          <div>
            <Button type="submit" size="lg" disabled={!built.voucher || post.isPending}>
              تسجيل {VOUCHER_TYPE[kind]}
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

interface FormState {
  date: string;
  boxId: string;
  counterAccountId: string;
  fromBoxId: string;
  toBoxId: string;
  amount: string;
  toAmount: string;
  rate: string;
  memo: string;
  branch: '' | Branch;
  lines: { accountId: string; debit: string; credit: string }[];
}

const EMPTY: FormState = {
  date: today(),
  boxId: '',
  counterAccountId: '',
  fromBoxId: '',
  toBoxId: '',
  amount: '',
  toAmount: '',
  rate: '',
  memo: '',
  branch: '',
  lines: [
    { accountId: '', debit: '', credit: '' },
    { accountId: '', debit: '', credit: '' },
  ],
};

/** The voucher to send, or null while something is missing; plus what it will be worth. */
function build(
  kind: VoucherKind,
  f: FormState,
  byId: Map<string, GlAccount>,
  ownerRate: (c: Currency | null | undefined) => string,
): { voucher: Voucher | null; preview?: string; dealRate?: string } {
  const date = f.date || undefined;
  const memo = f.memo.trim();
  const rateOf = (c: Currency | null | undefined) => (f.rate.trim() || ownerRate(c)).trim();
  const rateOk = (c: Currency | null | undefined) => c === 'USD' || RATE_PATTERN.test(rateOf(c));
  const preview = (minor: string, c: Currency) =>
    c === 'USD' ? undefined : formatMoney(toUsdCents(minor, c, rateOf(c)));

  if (kind === 'RECEIPT' || kind === 'PAYMENT') {
    const box = byId.get(f.boxId);
    const amount = box ? toMinorUnits(f.amount, box.currency!) : null;
    if (!box || !f.counterAccountId || !amount || amount === '0' || !memo || !rateOk(box.currency))
      return { voucher: null };
    return {
      voucher: {
        kind,
        date,
        boxId: box.id,
        counterAccountId: f.counterAccountId,
        amount,
        ...(box.currency !== 'USD' ? { rate: rateOf(box.currency) } : {}),
        memo,
      },
      preview: preview(amount, box.currency!),
    };
  }

  if (kind === 'TRANSFER') {
    const from = byId.get(f.fromBoxId);
    const amount = from ? toMinorUnits(f.amount, from.currency!) : null;
    if (!from || !f.toBoxId || !amount || amount === '0' || !rateOk(from.currency))
      return { voucher: null };
    return {
      voucher: {
        kind,
        date,
        fromBoxId: from.id,
        toBoxId: f.toBoxId,
        amount,
        ...(from.currency !== 'USD' ? { rate: rateOf(from.currency) } : {}),
        ...(memo ? { memo } : {}),
      },
      preview: preview(amount, from.currency!),
    };
  }

  if (kind === 'EXCHANGE') {
    const from = byId.get(f.fromBoxId);
    const to = byId.get(f.toBoxId);
    const fromAmount = from ? toMinorUnits(f.amount, from.currency!) : null;
    const toAmount = to ? toMinorUnits(f.toAmount, to.currency!) : null;
    if (!from || !to || !fromAmount || !toAmount || fromAmount === '0' || toAmount === '0')
      return { voucher: null };
    const crossRate = from.currency !== 'USD' && to.currency !== 'USD';
    if (crossRate && !rateOk(from.currency)) return { voucher: null };
    // Units of the non-dollar currency per 1 USD, as the deal priced it.
    const [foreign, usd] =
      to.currency === 'USD'
        ? [{ amount: fromAmount, currency: from.currency! }, toAmount]
        : from.currency === 'USD'
          ? [{ amount: toAmount, currency: to.currency! }, fromAmount]
          : [null, null];
    const dealRate =
      foreign && usd
        ? `1 $ = ${(Number(foreign.amount) / 10 ** (foreign.currency === 'LYD' ? 3 : 2) / (Number(usd) / 100)).toLocaleString('en', { maximumFractionDigits: 4 })} ${CURRENCY_SYMBOL[foreign.currency]}`
        : undefined;
    return {
      voucher: {
        kind,
        date,
        fromBoxId: from.id,
        fromAmount,
        toBoxId: to.id,
        toAmount,
        ...(crossRate ? { rate: rateOf(from.currency) } : {}),
        ...(memo ? { memo } : {}),
      },
      dealRate,
    };
  }

  // JOURNAL
  const lines = f.lines
    .filter((l) => l.accountId && (l.debit || l.credit))
    .map((l) => ({
      accountId: l.accountId,
      debit: l.debit ? toMinorUnits(l.debit, 'USD') : null,
      credit: l.credit ? toMinorUnits(l.credit, 'USD') : null,
    }));
  const valid = lines.every(
    (l) => (l.debit === null) !== (l.credit === null) && (l.debit ?? l.credit) !== null,
  );
  const total = lines.reduce((s, l) => s + BigInt(l.debit ?? '0') - BigInt(l.credit ?? '0'), 0n);
  if (!memo || lines.length < 2 || !valid || total !== 0n) return { voucher: null };
  return {
    voucher: {
      kind: 'JOURNAL',
      date,
      memo,
      ...(f.branch ? { branch: f.branch } : {}),
      lines: lines.map((l) => ({
        accountId: l.accountId,
        ...(l.debit ? { debit: l.debit } : {}),
        ...(l.credit ? { credit: l.credit } : {}),
      })),
    },
  };
}

function BoxSelect({
  label,
  boxes,
  value,
  onChange,
}: {
  label: string;
  boxes: GlAccount[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <Field label={label}>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— اختر الصندوق —</option>
        {boxes.map((b) => (
          <option key={b.id} value={b.id}>
            {b.nameAr} ({CURRENCY_SYMBOL[b.currency!]})
          </option>
        ))}
      </Select>
    </Field>
  );
}

function AmountField({
  label = 'المبلغ',
  currency,
  value,
  onChange,
}: {
  label?: string;
  currency: Currency | null;
  value: string;
  onChange: (value: string) => void;
}) {
  const bad = value !== '' && currency !== null && toMinorUnits(value, currency) === null;
  return (
    <Field label={currency ? `${label} (${CURRENCY_SYMBOL[currency]})` : label}>
      <Input
        dir="ltr"
        inputMode="decimal"
        value={value}
        disabled={!currency}
        placeholder={currency ? '0' : 'اختر الصندوق أولاً'}
        onChange={(e) => onChange(e.target.value)}
        className={bad ? 'border-bad' : ''}
      />
    </Field>
  );
}

function RateField({
  currency,
  value,
  fallback,
  onChange,
}: {
  currency: Currency | null;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}) {
  if (!currency || currency === 'USD') return null;
  return (
    <div className="w-64">
      <Field
        label={`سعر الصرف: كم ${CURRENCY_SYMBOL[currency]} مقابل 1 $`}
        hint={
          fallback
            ? `اتركه فارغاً لاستخدام سعرك (${Number(fallback)})`
            : 'لم يُحدَّد سعر بعد — اكتبه هنا'
        }
      >
        <Input
          dir="ltr"
          inputMode="decimal"
          value={value}
          placeholder={fallback ? String(Number(fallback)) : ''}
          onChange={(e) => onChange(e.target.value.replace(/[,\s]/g, ''))}
        />
      </Field>
    </div>
  );
}

function JournalLines({
  accounts,
  form,
  set,
}: {
  accounts: GlAccount[];
  form: FormState;
  set: (patch: Partial<FormState>) => void;
}) {
  const update = (i: number, patch: Partial<FormState['lines'][number]>) =>
    set({ lines: form.lines.map((l, n) => (n === i ? { ...l, ...patch } : l)) });
  const sum = (k: 'debit' | 'credit') =>
    form.lines.reduce((s, l) => s + BigInt(toMinorUnits(l[k], 'USD') ?? '0'), 0n);
  const debit = sum('debit');
  const credit = sum('credit');
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-muted">
        بالدولار. كل سطر إما مدين أو دائن، ومجموع المدين يساوي مجموع الدائن.
      </p>
      {form.lines.map((l, i) => (
        <div key={i} className="grid grid-cols-[1fr_7rem_7rem_auto] items-end gap-2">
          <AccountSelect
            label={i === 0 ? 'الحساب' : ''}
            accounts={accounts}
            value={l.accountId}
            onChange={(accountId) => update(i, { accountId })}
          />
          <Field label={i === 0 ? 'مدين $' : ''}>
            <Input
              dir="ltr"
              value={l.debit}
              onChange={(e) => update(i, { debit: e.target.value, credit: '' })}
            />
          </Field>
          <Field label={i === 0 ? 'دائن $' : ''}>
            <Input
              dir="ltr"
              value={l.credit}
              onChange={(e) => update(i, { credit: e.target.value, debit: '' })}
            />
          </Field>
          <Button
            variant="ghost"
            aria-label="حذف السطر"
            disabled={form.lines.length <= 2}
            onClick={() => set({ lines: form.lines.filter((_, n) => n !== i) })}
          >
            ✕
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-4">
        <Button
          variant="secondary"
          onClick={() => set({ lines: [...form.lines, { accountId: '', debit: '', credit: '' }] })}
        >
          + سطر
        </Button>
        <span className={`tabular ${debit === credit ? 'text-ok' : 'text-bad'}`}>
          مدين {formatMoney(debit.toString())} · دائن {formatMoney(credit.toString())}
        </span>
        <div className="w-36">
          <Select
            aria-label="البلد"
            value={form.branch}
            onChange={(e) => set({ branch: e.target.value as FormState['branch'] })}
          >
            <option value="">البلد: غير محدد</option>
            <option value="SY">{BRANCH.SY}</option>
            <option value="LY">{BRANCH.LY}</option>
          </Select>
        </div>
      </div>
    </div>
  );
}
