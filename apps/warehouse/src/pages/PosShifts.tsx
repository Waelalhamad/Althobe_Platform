import {
  Alert,
  Card,
  ConfirmButton,
  EmptyState,
  Field,
  Input,
  PageTitle,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, type Shift } from '../api';
import { CURRENCY_NAME, errorText, formatMoney } from '../format';
import { PAGES } from '../help';
import { CashInputs, EMPTY_COUNTS, parseCounts, useStore } from './Pos';

/** الورديات: every shift of the store, newest first, and a receipt by its number. */
export function PosShiftsPage() {
  const store = useStore();
  const navigate = useNavigate();
  const [receipt, setReceipt] = useState('');
  const [notFound, setNotFound] = useState(false);
  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['pos', 'shifts', store?.id],
    queryFn: async () => api.shifts(store!.id),
    enabled: Boolean(store),
  });

  const find = async (e: FormEvent) => {
    e.preventDefault();
    const [sale] = await api.posSales({ receipt: receipt.trim() }).catch(() => []);
    setNotFound(!sale);
    if (sale)
      await navigate({
        to: '/pos/receipts/$saleId',
        params: { saleId: sale.id },
        search: { print: false },
      });
  };

  return (
    <>
      <PageTitle intro={PAGES.posShifts}>الورديات والفواتير</PageTitle>
      <Card className="mb-4">
        <form onSubmit={(e) => void find(e)} className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="ابحث عن فاتورة برقمها" hint="مثل 2026/15 أو 15 لهذه السنة">
              <Input dir="ltr" value={receipt} onChange={(e) => setReceipt(e.target.value)} />
            </Field>
          </div>
          <button
            type="submit"
            className="min-h-10 rounded-lg bg-brand px-4 font-semibold text-white"
          >
            فتح الفاتورة
          </button>
        </form>
        {notFound && <p className="mt-2 text-bad">لا توجد فاتورة بهذا الرقم</p>}
      </Card>
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {!isLoading && shifts.length === 0 && (
        <EmptyState title="لا توجد ورديات بعد">افتح أول وردية من «نقطة البيع».</EmptyState>
      )}
      {shifts.length > 0 && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <thead className="bg-blush text-sm text-ink-muted">
              <tr>
                <th className="p-2 text-start">الوردية</th>
                <th className="p-2 text-start">الكاشير</th>
                <th className="p-2 text-start">الفواتير</th>
                <th className="p-2 text-start">المبيعات</th>
                <th className="p-2 text-start">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id} className="border-t border-stone">
                  <td className="p-2">
                    <Link
                      to="/pos/shifts/$shiftId"
                      params={{ shiftId: s.id }}
                      className="text-brand"
                    >
                      {new Date(s.openedAt).toLocaleString('ar-SY-u-nu-latn')}
                    </Link>
                  </td>
                  <td className="p-2">{s.openedBy.nameAr}</td>
                  <td className="tabular p-2">
                    {s.salesCount}
                    {s.refundsCount > 0 && ` (+${s.refundsCount} مرتجع)`}
                  </td>
                  <td className="tabular p-2">{formatMoney(s.salesTotal, 'SYP')}</td>
                  <td className="p-2">{s.status === 'OPEN' ? 'مفتوحة' : 'مغلقة'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

/** One shift: its drawer per currency, its receipts, and closing it. */
export function PosShiftPage() {
  const { shiftId } = useParams({ from: '/app/pos/shifts/$shiftId' });
  const { data: shift, error } = useQuery({
    queryKey: ['pos', 'shift', shiftId],
    queryFn: async () => api.shift(shiftId),
  });
  const { data: sales = [] } = useQuery({
    queryKey: ['pos', 'sales', shiftId],
    queryFn: async () => api.posSales({ shiftId }),
  });

  if (error) return <Alert>{errorText(error)}</Alert>;
  if (!shift) return <p className="text-ink-muted">جارٍ التحميل…</p>;

  return (
    <>
      <PageTitle
        actions={
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-10 rounded-lg border border-stone bg-white px-4 font-semibold"
          >
            طباعة التقرير
          </button>
        }
      >
        وردية {shift.openedBy.nameAr} — {new Date(shift.openedAt).toLocaleString('ar-SY-u-nu-latn')}
      </PageTitle>
      <p className="mb-4 text-ink-muted">
        {shift.status === 'OPEN'
          ? 'مفتوحة'
          : `أُغلقت ${new Date(shift.closedAt!).toLocaleString('ar-SY-u-nu-latn')} بواسطة ${shift.closedBy?.nameAr ?? ''}`}
        {' · '}
        {shift.salesCount} فاتورة بـ {formatMoney(shift.salesTotal, 'SYP')}
        {shift.refundsCount > 0 &&
          ` · ${shift.refundsCount} مرتجع بـ ${formatMoney(shift.refundsTotal, 'SYP')}`}
      </p>

      <Drawer shift={shift} />
      {shift.status === 'OPEN' && <CloseShift shift={shift} />}
      {shift.journalEntryId && (
        <p className="mb-4">
          <Link
            to="/finance/entries/$entryId"
            params={{ entryId: shift.journalEntryId }}
            className="text-brand"
          >
            قيد الوردية في الدفاتر ←
          </Link>
        </p>
      )}

      <h2 className="mb-2 text-lg font-bold">فواتير الوردية</h2>
      {sales.length === 0 ? (
        <p className="text-ink-muted">لا توجد فواتير بعد.</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <tbody>
              {sales.map((s) => (
                <tr key={s.id} className="border-t border-stone first:border-0">
                  <td className="tabular p-2 text-ink-muted">
                    {new Date(s.createdAt).toLocaleTimeString('ar-SY-u-nu-latn')}
                  </td>
                  <td className="p-2">
                    <Link
                      to="/pos/receipts/$saleId"
                      params={{ saleId: s.id }}
                      search={{ print: false }}
                      className="font-medium text-brand"
                    >
                      {s.kind === 'SALE' ? 'فاتورة' : 'مرتجع'} {s.receiptYear}/{s.receiptNo}
                    </Link>
                  </td>
                  <td className="p-2 text-sm">
                    {s.lines.reduce((n, l) => n + l.quantity, 0)} قطعة
                  </td>
                  <td className={`tabular p-2 font-bold ${s.kind === 'REFUND' ? 'text-bad' : ''}`}>
                    {s.kind === 'REFUND' ? '-' : ''}
                    {formatMoney(s.total, 'SYP')}
                  </td>
                  <td className="p-2 text-sm text-ink-muted">{s.createdBy.nameAr}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Drawer({ shift }: { shift: Shift }) {
  return (
    <Card className="mb-4 overflow-x-auto p-0">
      <table className="w-full">
        <thead className="bg-blush text-sm text-ink-muted">
          <tr>
            <th className="p-2 text-start">العملة</th>
            <th className="p-2 text-start">بداية الوردية</th>
            <th className="p-2 text-start">قبض</th>
            <th className="p-2 text-start">باقي مُعطى</th>
            <th className="p-2 text-start">مرتجعات</th>
            <th className="p-2 text-start">المفروض بالدرج</th>
            <th className="p-2 text-start">المعدود</th>
            <th className="p-2 text-start">الفرق</th>
          </tr>
        </thead>
        <tbody>
          {shift.cash.map((c) => (
            <tr key={c.currency} className="border-t border-stone">
              <td className="p-2 font-medium">{CURRENCY_NAME[c.currency]}</td>
              <td className="tabular p-2">{formatMoney(c.opening, c.currency)}</td>
              <td className="tabular p-2">{formatMoney(c.takings, c.currency)}</td>
              <td className="tabular p-2">
                {c.change === '0' ? '' : formatMoney(c.change, c.currency)}
              </td>
              <td className="tabular p-2">
                {c.refunds === '0' ? '' : formatMoney(c.refunds, c.currency)}
              </td>
              <td className="tabular p-2 font-bold">{formatMoney(c.expected, c.currency)}</td>
              <td className="tabular p-2">
                {c.counted === null ? '—' : formatMoney(c.counted, c.currency)}
              </td>
              <td
                className={`tabular p-2 font-bold ${c.difference && c.difference !== '0' ? (BigInt(c.difference) < 0n ? 'text-bad' : 'text-ok') : ''}`}
              >
                {c.difference === null
                  ? '—'
                  : c.difference === '0'
                    ? '✓'
                    : formatMoney(c.difference, c.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CloseShift({ shift }: { shift: Shift }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [texts, setTexts] = useState(EMPTY_COUNTS);
  const counts = parseCounts(texts);
  const close = useMutation({
    mutationFn: async () => api.closeShift(shift.id, counts!),
    onSuccess: async () => {
      toast('أُغلقت الوردية وسُجّلت في الدفاتر');
      await queryClient.invalidateQueries({ queryKey: ['pos'] });
      void queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
  return (
    <Card className="mb-4 print:hidden">
      <h2 className="mb-2 text-lg font-bold">إغلاق الوردية</h2>
      <p className="mb-3 text-ink-muted">
        عُدّ الدرج الآن واكتب ما فيه بكل عملة. الفرق عن «المفروض» يُسجَّل عجزاً أو زيادة.
      </p>
      <CashInputs texts={texts} onChange={setTexts} />
      {close.isError && (
        <div className="mt-2">
          <Alert>{errorText(close.error)}</Alert>
        </div>
      )}
      <div className="mt-3">
        <ConfirmButton onConfirm={() => close.mutate()} disabled={!counts || close.isPending}>
          إغلاق الوردية
        </ConfirmButton>
      </div>
    </Card>
  );
}
