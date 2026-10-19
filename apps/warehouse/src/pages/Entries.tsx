import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmButton,
  EmptyState,
  Field,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type JournalEntry, type Range, type VoucherType } from '../api';
import { BRANCH, errorText, formatMoney, today, VOUCHER_TYPE, voucherNumber } from '../format';
import { PAGES } from '../help';
import { can, entriesQuery, entryQuery, meQuery } from '../queries';
import {
  DebitCredit,
  monthStart,
  OwnCurrency,
  RangeFilter,
  useRefreshBooks,
} from './finance-parts';

const total = (e: JournalEntry) =>
  e.lines
    .filter((l) => BigInt(l.amountBase) > 0n)
    .reduce((s, l) => s + BigInt(l.amountBase), 0n)
    .toString();

/** دفتر اليومية: every entry, newest first; prints with its lines. */
export function EntriesPage() {
  const [range, setRange] = useState<Range>({ from: monthStart(today()), to: today() });
  const [voucherType, setType] = useState<VoucherType | ''>('');
  const [details, setDetails] = useState(false);
  const { data: entries = [], isLoading } = useQuery(
    entriesQuery({ ...range, ...(voucherType ? { voucherType } : {}) }),
  );

  return (
    <>
      <PageTitle
        intro={PAGES.entries}
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            طباعة دفتر اليومية
          </Button>
        }
      >
        دفتر اليومية
      </PageTitle>
      <RangeFilter range={range} onChange={setRange}>
        <div className="w-44">
          <Field label="النوع">
            <Select
              value={voucherType}
              onChange={(e) => setType(e.target.value as VoucherType | '')}
            >
              <option value="">الكل</option>
              {Object.entries(VOUCHER_TYPE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <label className="flex min-h-10 items-center gap-2">
          <input type="checkbox" checked={details} onChange={(e) => setDetails(e.target.checked)} />
          عرض أسطر كل قيد
        </label>
      </RangeFilter>
      <p className="mb-2 hidden print:block">
        من {range.from ?? 'البداية'} إلى {range.to ?? 'اليوم'}
        {range.branch && ` · ${BRANCH[range.branch]}`}
      </p>

      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {!isLoading && entries.length === 0 && (
        <EmptyState title="لا توجد قيود في هذه الفترة">
          غيّر التاريخ، أو سجّل سنداً من صفحة «المالية».
        </EmptyState>
      )}
      {entries.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <thead className="bg-blush text-sm text-ink-muted">
              <tr>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">القيد</th>
                <th className="p-2 text-start">البيان</th>
                <th className="p-2 text-start">المبلغ</th>
                <th className="p-2 text-start print:hidden">بواسطة</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <EntryRows key={e.id} entry={e} details={details} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function EntryRows({ entry: e, details }: { entry: JournalEntry; details: boolean }) {
  return (
    <>
      <tr className="border-t border-stone">
        <td className="tabular p-2 text-ink-muted">{e.entryDate}</td>
        <td className="p-2">
          <Link
            to="/finance/entries/$entryId"
            params={{ entryId: e.id }}
            className="font-medium text-brand"
          >
            {VOUCHER_TYPE[e.voucherType]} {voucherNumber(e)}
          </Link>
          {e.reversedById && <span className="ms-2 text-xs text-bad">(معكوس)</span>}
        </td>
        <td className="p-2">{e.memo}</td>
        <td className="tabular p-2">{formatMoney(total(e))}</td>
        <td className="p-2 text-sm text-ink-muted print:hidden">{e.createdBy.nameAr}</td>
      </tr>
      {details &&
        e.lines.map((l) => (
          <tr key={l.lineNo} className="text-sm text-ink-muted">
            <td />
            <td className="p-1 ps-6" colSpan={2}>
              <Code>{l.account.code}</Code> {l.account.nameAr}{' '}
              <OwnCurrency amount={l.amountCurrency} currency={l.currency} rate={l.rate} />
            </td>
            <td className="tabular p-1" colSpan={2}>
              {BigInt(l.amountBase) >= 0n ? 'مدين ' : 'دائن '}
              {formatMoney(
                (BigInt(l.amountBase) < 0n
                  ? -BigInt(l.amountBase)
                  : BigInt(l.amountBase)
                ).toString(),
              )}
            </td>
          </tr>
        ))}
    </>
  );
}

/** One entry: its lines, who posted it, and its reversal. */
export function EntryPage() {
  const { entryId } = useParams({ from: '/app/finance/entries/$entryId' });
  const { data: user } = useQuery(meQuery);
  const { data: entry, error } = useQuery(entryQuery(entryId));
  const toast = useToast();
  const refresh = useRefreshBooks();
  const [key] = useState(() => crypto.randomUUID());

  const reverse = useMutation({
    mutationFn: async () => api.reverseEntry(entryId, key),
    onSuccess: async (r) => {
      toast(`تم تسجيل القيد العكسي ${voucherNumber(r)}`);
      await refresh();
    },
  });

  if (error) return <Alert>{errorText(error)}</Alert>;
  if (!entry) return <p className="text-ink-muted">جارٍ التحميل…</p>;

  const system = entry.sourceType !== null || entry.voucherType === 'REVALUATION';
  const reversible =
    can(user, 'accounting.post') &&
    !system &&
    entry.voucherType !== 'REVERSAL' &&
    !entry.reversedById;

  return (
    <>
      <PageTitle
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            طباعة
          </Button>
        }
      >
        {VOUCHER_TYPE[entry.voucherType]} رقم {voucherNumber(entry)}
      </PageTitle>
      <Card className="mb-4">
        <dl className="grid gap-2 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-ink-muted">التاريخ</dt>
            <dd className="tabular font-medium">{entry.entryDate}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">البيان</dt>
            <dd className="font-medium">{entry.memo ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-sm text-ink-muted">سجّله</dt>
            <dd className="font-medium">
              {entry.createdBy.nameAr}{' '}
              <span className="text-sm text-ink-muted">
                {new Date(entry.createdAt).toLocaleString('ar-SY-u-nu-latn')}
              </span>
            </dd>
          </div>
        </dl>
        {entry.sourceType === 'INVENTORY_MOVEMENT' && (
          <p className="mt-3 text-sm text-ink-muted">
            قيد تلقائي من حركة مخزون. يُصحَّح من المستودع (تعديل أو جرد)، لا من هنا.
          </p>
        )}
        {entry.reversesId && (
          <p className="mt-3">
            يعكس{' '}
            <Link
              to="/finance/entries/$entryId"
              params={{ entryId: entry.reversesId }}
              className="text-brand"
            >
              القيد الأصلي
            </Link>
          </p>
        )}
        {entry.reversedById && (
          <p className="mt-3 text-bad">
            هذا القيد معكوس ←{' '}
            <Link
              to="/finance/entries/$entryId"
              params={{ entryId: entry.reversedById }}
              className="text-brand"
            >
              القيد العكسي
            </Link>
          </p>
        )}
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-2 text-start">الحساب</th>
              <th className="p-2 text-start">مدين $</th>
              <th className="p-2 text-start">دائن $</th>
              <th className="p-2 text-start">بالعملة</th>
              <th className="p-2 text-start">البلد</th>
            </tr>
          </thead>
          <tbody>
            {entry.lines.map((l) => (
              <tr key={l.lineNo} className="border-t border-stone">
                <td className="p-2">
                  <Link
                    to="/finance/accounts/$accountId"
                    params={{ accountId: l.account.id }}
                    className="text-brand"
                  >
                    <Code>{l.account.code}</Code> {l.account.nameAr}
                  </Link>
                  {l.memo && <div className="text-sm text-ink-muted">{l.memo}</div>}
                </td>
                <DebitCredit base={l.amountBase} />
                <td className="p-2">
                  <OwnCurrency amount={l.amountCurrency} currency={l.currency} rate={l.rate} />
                </td>
                <td className="p-2 text-sm">{l.branch ? BRANCH[l.branch] : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {reversible && (
        <div className="mt-6 print:hidden">
          <p className="mb-2 text-sm text-ink-muted">
            خطأ في هذا القيد؟ القيود لا تُعدَّل ولا تُحذف: يُسجَّل قيد عكسي يلغيه، ثم سجّل الصحيح.
          </p>
          <ConfirmButton
            variant="danger"
            onConfirm={() => reverse.mutate()}
            disabled={reverse.isPending}
          >
            عكس هذا القيد
          </ConfirmButton>
          {reverse.isError && (
            <div className="mt-2">
              <Alert>{errorText(reverse.error)}</Alert>
            </div>
          )}
        </div>
      )}
    </>
  );
}
