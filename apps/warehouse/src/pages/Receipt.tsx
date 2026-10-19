import { Alert, Button, Card, Field, Input, PageTitle, useToast } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, type PosSale } from '../api';
import { CURRENCY_SYMBOL, errorText, formatMoney } from '../format';
import { can, meQuery } from '../queries';
import { currentShiftQuery, useStore } from './Pos';

// The 80 mm thermal roll (ADR-014): the page is the paper, no margins, the app's frame hidden.
const PRINT_CSS = `@media print { @page { size: 80mm auto; margin: 3mm; } body { background: #fff; } }`;

/** إيصال: what the customer takes home. Prints on the 80 mm roll; a manager refunds from here. */
export function ReceiptPage() {
  const { saleId } = useParams({ from: '/app/pos/receipts/$saleId' });
  const { print } = useSearch({ from: '/app/pos/receipts/$saleId' });
  const { data: sale, error } = useQuery({
    queryKey: ['pos', 'sale', saleId],
    queryFn: async () => api.posSale(saleId),
  });
  const { data: user } = useQuery(meQuery);
  const store = useStore();

  // Straight from the till: print at once, the way a cash register does.
  useEffect(() => {
    if (sale && print) setTimeout(() => window.print(), 300);
  }, [sale, print]);

  if (error) return <Alert>{errorText(error)}</Alert>;
  if (!sale) return <p className="text-ink-muted">جارٍ التحميل…</p>;

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div className="mb-4 flex flex-wrap gap-2 print:hidden">
        <Link to="/pos">
          <Button size="lg">بيع جديد</Button>
        </Link>
        <Button variant="secondary" onClick={() => window.print()}>
          طباعة مرة أخرى
        </Button>
        <Link to="/pos/shifts/$shiftId" params={{ shiftId: sale.shiftId }}>
          <Button variant="ghost">فواتير الوردية</Button>
        </Link>
      </div>

      <Paper sale={sale} storeName={store?.nameAr ?? ''} />

      {sale.kind === 'SALE' && can(user, 'retail.manage') && store && (
        <Refund sale={sale} storeId={store.id} />
      )}
    </>
  );
}

function Paper({ sale, storeName }: { sale: PosSale; storeName: string }) {
  const refund = sale.kind === 'REFUND';
  return (
    <div className="mx-auto w-[72mm] bg-white p-3 text-sm text-black shadow print:w-full print:shadow-none">
      <div className="text-center">
        <img src="/logo-mark.svg" alt="" className="mx-auto size-12" />
        <div className="text-lg font-bold">الثوب العربي</div>
        <div>{storeName}</div>
        <div className="mt-1 font-bold">{refund ? 'إيصال مرتجع' : 'فاتورة بيع'}</div>
        <div className="tabular">
          رقم {sale.receiptYear}/{sale.receiptNo}
        </div>
        <div className="tabular text-xs">
          {new Date(sale.createdAt).toLocaleString('ar-SY-u-nu-latn')} · {sale.createdBy.nameAr}
        </div>
      </div>
      <hr className="my-2 border-dashed border-black" />
      {sale.lines.map((l) => (
        <div key={l.lineNo} className="mb-1">
          <div>
            {l.variant.productName} · {l.variant.title}
          </div>
          <div className="tabular flex justify-between">
            <span>
              {l.quantity} × {formatMoney(l.unitPrice, 'SYP')}
            </span>
            <span>{formatMoney((BigInt(l.unitPrice) * BigInt(l.quantity)).toString(), 'SYP')}</span>
          </div>
        </div>
      ))}
      <hr className="my-2 border-dashed border-black" />
      <Row label="المجموع" value={formatMoney(sale.subtotal, 'SYP')} />
      {sale.discount !== '0' && (
        <Row
          label={refund ? 'بعد الخصم' : 'الخصم'}
          value={`- ${formatMoney(sale.discount, 'SYP')}`}
        />
      )}
      <Row label={refund ? 'المُرجَع' : 'الإجمالي'} value={formatMoney(sale.total, 'SYP')} strong />
      {!refund && (
        <>
          <hr className="my-2 border-dashed border-black" />
          {sale.payments.map((p) => (
            <Row
              key={p.currency}
              label={`مدفوع ${CURRENCY_SYMBOL[p.currency]}${p.currency !== 'SYP' ? ` (سعر ${Number(p.rate)})` : ''}`}
              value={formatMoney(p.amount, p.currency)}
            />
          ))}
          {sale.change !== '0' && (
            <Row label="الباقي" value={formatMoney(sale.change, 'SYP')} strong />
          )}
        </>
      )}
      {sale.note && <div className="mt-2 text-xs">{sale.note}</div>}
      <div className="mt-3 text-center text-xs">شكراً لزيارتكم</div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`tabular flex justify-between ${strong ? 'text-base font-bold' : ''}`}>
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** مرتجع: the manager picks how many of each piece come back, and why. */
function Refund({ sale, storeId }: { sale: PosSale; storeId: string }) {
  const { data: shift } = useQuery(currentShiftQuery(storeId));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [counts, setCounts] = useState<Record<number, number>>({});
  const [reason, setReason] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const lines = Object.entries(counts)
    .filter(([, q]) => q > 0)
    .map(([lineNo, quantity]) => ({ lineNo: Number(lineNo), quantity }));
  const open = sale.lines.some((l) => l.quantity > l.refunded);

  const refund = useMutation({
    mutationFn: async () =>
      api.refund(sale.id, { shiftId: shift!.id, lines, reason: reason.trim() }, key),
    onSuccess: async (r) => {
      toast(`تم المرتجع — إيصال ${r.receiptYear}/${r.receiptNo}`);
      void queryClient.invalidateQueries({ queryKey: ['pos'] });
      await navigate({
        to: '/pos/receipts/$saleId',
        params: { saleId: r.id },
        search: { print: true },
      });
    },
  });

  if (!open) return null;
  return (
    <Card className="mx-auto mt-6 max-w-xl print:hidden">
      <PageTitle>مرتجع من هذه الفاتورة</PageTitle>
      {!shift && <Alert tone="warn">افتح وردية في المتجر أولاً: المبلغ يُرجَع من درجها.</Alert>}
      <div className="flex flex-col gap-2">
        {sale.lines.map((l) => {
          const left = l.quantity - l.refunded;
          if (left === 0) return null;
          return (
            <div key={l.lineNo} className="flex items-center justify-between gap-2">
              <span>
                {l.variant.productName} · {l.variant.title}{' '}
                <span className="text-sm text-ink-muted">(بقي {left})</span>
              </span>
              <div className="w-20">
                <Input
                  type="number"
                  min={0}
                  max={left}
                  value={counts[l.lineNo] ?? 0}
                  onChange={(e) =>
                    setCounts({
                      ...counts,
                      [l.lineNo]: Math.max(0, Math.min(left, Number(e.target.value) || 0)),
                    })
                  }
                />
              </div>
            </div>
          );
        })}
        <Field label="السبب">
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مقاس غير مناسب، عيب…"
          />
        </Field>
        {refund.isError && <Alert>{errorText(refund.error)}</Alert>}
        <div>
          <Button
            variant="danger"
            disabled={!shift || lines.length === 0 || !reason.trim() || refund.isPending}
            onClick={() => refund.mutate()}
          >
            تسجيل المرتجع وإرجاع المبلغ بالليرة
          </Button>
        </div>
      </div>
    </Card>
  );
}
