import { Card, PageTitle } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { api } from '../api';
import { formatMoney, formatQuantity } from '../format';
import { PAGES } from '../help';
import {
  balancesQuery,
  booksCheckQuery,
  boxesQuery,
  can,
  doesStockWork,
  meQuery,
  openSessionsQuery,
  partiesSummaryQuery,
  payrollSummaryQuery,
  posTodayQuery,
  ratesQuery,
} from '../queries';
import { currentShiftQuery, useStore } from './Pos';
import { StockHomePage } from './Home';

/**
 * The home of each job: the owner (and whoever reads the books) gets «اليوم»; a cashier goes
 * straight to the till; warehouse staff get their stock work.
 */
export function HomePage() {
  const { data: user } = useQuery(meQuery);
  if (!user) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  if (can(user, 'accounting.view')) return <TodayPage />;
  if (can(user, 'retail.sell') && !doesStockWork(user)) return <Navigate to="/pos" />;
  return <StockHomePage />;
}

/** اليوم: three questions — what did we sell, how much money is there, what needs me. */
function TodayPage() {
  const { data: user } = useQuery(meQuery);
  const sells = can(user, 'retail.sell');
  const { data: today } = useQuery({ ...posTodayQuery, enabled: sells });
  const { data: boxes = [] } = useQuery(boxesQuery);

  return (
    <>
      <PageTitle intro={PAGES.today}>اليوم</PageTitle>
      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <h2 className="mb-2 font-bold text-ink-muted">كم بعنا اليوم؟</h2>
          {today ? (
            <>
              <div className="tabular text-3xl font-bold">{formatMoney(today.total, 'SYP')}</div>
              <div className="text-ink-muted">
                {today.receipts} فاتورة · {formatQuantity(today.pieces)} قطعة
                {today.refunds > 0 && ` · ${today.refunds} مرتجع`}
              </div>
              <div className="mt-2 font-medium">
                الربح ≈ <span className="tabular">{formatMoney(today.profitBase)}</span>
              </div>
              <Link to="/pos/shifts" className="mt-2 inline-block text-sm text-brand">
                الفواتير ←
              </Link>
            </>
          ) : (
            <p className="text-ink-muted">{sells ? 'جارٍ التحميل…' : '—'}</p>
          )}
        </Card>

        <Card>
          <h2 className="mb-2 font-bold text-ink-muted">كم معنا؟</h2>
          <ul className="flex flex-col gap-1">
            {boxes
              .filter((b) => b.account.isActive)
              .map((b) => (
                <li key={b.account.id} className="flex justify-between gap-2">
                  <span className="text-sm">{b.account.nameAr}</span>
                  <span className="tabular font-bold">
                    {formatMoney(b.balance, b.account.currency ?? 'USD')}
                  </span>
                </li>
              ))}
          </ul>
          <Link to="/finance" className="mt-2 inline-block text-sm text-brand">
            الصناديق ←
          </Link>
        </Card>

        <Attention />
      </div>

      <h2 className="mb-3 text-lg font-bold">ماذا تريد أن تعمل؟</h2>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        {sells && <Tile to="/pos" title="بيع" hint="نقطة البيع في المتجر" />}
        {doesStockWork(user) && <Tile to="/stock" title="استلام ونقل" hint="بضاعة داخلة وخارجة" />}
        {can(user, 'accounting.post') && (
          <Tile to="/finance/new" kind="PAYMENT" title="مصروف" hint="إيجار، كهرباء، نقل…" />
        )}
        {can(user, 'accounting.post') && (
          <Tile to="/finance/new" kind="RECEIPT" title="مصاري دخلت" hint="إلى أحد الصناديق" />
        )}
        {can(user, 'inventory.view') && (
          <Tile to="/balances" title="الأرصدة" hint="كم قطعة في كل مكان" />
        )}
        {can(user, 'parties.read') && (
          <Tile
            to="/finance/parties"
            title="الموردون والزبائن"
            hint="مين إلك عنده، ومين إله عليك"
          />
        )}
        {can(user, 'payroll.manage') && (
          <Tile to="/finance/payroll" title="الرواتب" hint="الموظفون والسلف والكشوف" />
        )}
        <Tile to="/finance/reports" title="الأرباح" hint="هذا الشهر بالدولار" />
      </div>
    </>
  );
}

function Tile({
  to,
  kind,
  title,
  hint,
}: {
  to:
    | '/pos'
    | '/stock'
    | '/finance/new'
    | '/balances'
    | '/finance/reports'
    | '/finance/payroll'
    | '/finance/parties';
  kind?: 'PAYMENT' | 'RECEIPT';
  title: string;
  hint: string;
}) {
  const body = (
    <Card className="flex min-h-24 flex-col justify-center hover:border-brand">
      <span className="text-xl font-bold">{title}</span>
      <span className="text-sm text-ink-muted">{hint}</span>
    </Card>
  );
  if (to === '/finance/new') {
    return (
      <Link to="/finance/new" search={{ kind: kind ?? 'PAYMENT' }}>
        {body}
      </Link>
    );
  }
  if (to === '/finance/reports') {
    return (
      <Link to="/finance/reports" search={{ tab: 'income' }}>
        {body}
      </Link>
    );
  }
  return <Link to={to}>{body}</Link>;
}

/** What needs the owner, worked out from what the app already knows; nothing = all is well. */
function Attention() {
  const { data: user } = useQuery(meQuery);
  const store = useStore();
  const { data: storeStock = [] } = useQuery({
    ...balancesQuery(store?.id ?? ''),
    enabled: Boolean(store) && can(user, 'inventory.view'),
  });
  const { data: shift } = useQuery({
    ...currentShiftQuery(store?.id ?? ''),
    enabled: Boolean(store) && can(user, 'retail.sell'),
  });
  const { data: rates = [] } = useQuery(ratesQuery);
  const { data: sessions = [] } = useQuery(openSessionsQuery);
  const { data: check } = useQuery(booksCheckQuery);
  const { data: parties } = useQuery({
    ...partiesSummaryQuery,
    enabled: can(user, 'parties.read'),
  });
  const { data: pendingAdjustments = [] } = useQuery({
    queryKey: ['adjustments', 'PENDING'],
    queryFn: async () => api.adjustmentRequests('PENDING'),
    enabled: can(user, 'inventory.adjust.approve'),
  });
  const { data: payroll } = useQuery({
    ...payrollSummaryQuery,
    enabled: can(user, 'payroll.manage'),
  });

  const items: ReactNode[] = [];
  const unpriced = storeStock.filter((r) => r.balance.quantity > 0 && !r.variant.prices.retailSyp);
  if (unpriced.length) {
    items.push(
      <Link key="price" to="/products" className="text-brand">
        {unpriced.length} صنف في المتجر بدون سعر مفرق — لا يُباع حتى يُسعَّر
      </Link>,
    );
  }
  const midnight = new Date(
    `${new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(new Date())}T00:00:00+03:00`,
  );
  if (shift && new Date(shift.openedAt) < midnight) {
    items.push(
      <Link
        key="shift"
        to="/pos/shifts/$shiftId"
        params={{ shiftId: shift.id }}
        className="text-brand"
      >
        وردية المتجر مفتوحة من يوم سابق — عُدّ الدرج وأغلقها
      </Link>,
    );
  }
  const missing = rates.filter((r) => !r.rate);
  if (missing.length && (can(user, 'admin.rates.write') || can(user, 'accounting.view'))) {
    items.push(
      <Link key="rates" to="/rates" className="text-brand">
        سعر الصرف غير محدد ({missing.map((r) => r.currency).join('، ')})
      </Link>,
    );
  }
  if (sessions.length) {
    items.push(
      <Link key="sessions" to="/stock" className="text-brand">
        {sessions.length} عملية مسح لم تُؤكَّد بعد
      </Link>,
    );
  }
  // Someone else's adjustments wait for this person (developer report F-03).
  const toDecide = pendingAdjustments.filter((r) => r.requestedById !== user?.id);
  if (toDecide.length) {
    items.push(
      <Link key="adjust" to="/adjustments" className="text-brand">
        {toDecide.length} طلب تعديل مخزون بانتظار موافقتك
      </Link>,
    );
  }
  if (parties && parties.books.payable.unassigned !== '0') {
    items.push(
      <Link key="unnamed" to="/finance/parties" className="text-brand">
        بضاعة مستلمة بدون مورد ({formatMoney(parties.books.payable.unassigned)}) — سكّرها أو اختر
        المورد في الاستلامات القادمة
      </Link>,
    );
  }
  if (payroll?.unpaidEmployees) {
    items.push(
      <Link key="unpaid" to="/finance/payroll" className="text-brand">
        رواتب معتمدة لم تُدفع بعد ({payroll.unpaidEmployees} موظف)
      </Link>,
    );
  }
  if (payroll?.missingMonth) {
    items.push(
      <Link key="sheet" to="/finance/payroll" className="text-brand">
        كشف رواتب شهر {payroll.missingMonth} لم يُعمل بعد
      </Link>,
    );
  }
  if (payroll && !payroll.books.ok) {
    items.push(
      <Link key="payroll-books" to="/finance/payroll" className="text-bad">
        السلف أو الرواتب في الدفاتر لا تطابق صفحات الموظفين
      </Link>,
    );
  }
  if (check && !check.ok) {
    items.push(
      <Link key="books" to="/finance" className="text-bad">
        قيمة المخزون في الدفاتر لا تطابق المستودع
      </Link>,
    );
  }

  return (
    <Card>
      <h2 className="mb-3 text-lg font-bold text-ink">ماذا يحتاج انتباهي؟</h2>
      {items.length === 0 ? (
        <p className="font-medium text-ok">✓ لا شيء — كل شيء على ما يرام</p>
      ) : (
        <ul className="flex list-disc flex-col gap-2 ps-5">
          {items.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
