import { Alert, Button, Card, EmptyState, PageTitle } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { formatMoney, today, toUsdCents, VOUCHER_TYPE, voucherNumber } from '../format';
import { PAGES } from '../help';
import { booksCheckQuery, boxesQuery, can, entriesQuery, incomeQuery, meQuery } from '../queries';
import { monthStart } from './finance-parts';

const ACTIONS = [
  { kind: 'RECEIPT', label: 'سند قبض', hint: 'مصاري داخلة' },
  { kind: 'PAYMENT', label: 'سند صرف', hint: 'مصروف أو دفعة' },
  { kind: 'TRANSFER', label: 'تحويل', hint: 'من صندوق لصندوق' },
  { kind: 'EXCHANGE', label: 'صرافة', hint: 'تبديل عملة' },
  { kind: 'JOURNAL', label: 'قيد يومية', hint: 'للمحاسب' },
] as const;

/** المالية: what is in each box, what to record, and this month at a glance. */
export function FinancePage() {
  const { data: user } = useQuery(meQuery);
  const { data: boxes = [], isLoading } = useQuery(boxesQuery);
  const { data: check } = useQuery(booksCheckQuery);
  const thisMonth = { from: monthStart(today()), to: today() };
  const { data: income } = useQuery(incomeQuery(thisMonth));
  const { data: recent = [] } = useQuery(entriesQuery({}));

  const section = (key: string) => income?.sections.find((s) => s.key === key)?.total ?? '0';

  return (
    <>
      <PageTitle intro={PAGES.finance}>المالية</PageTitle>

      {check && !check.ok && (
        <div className="mb-4">
          <Alert tone="warn">
            قيمة المخزون في الدفاتر لا تطابق المستودع:{' '}
            {check.locations
              .filter((l) => l.difference !== '0')
              .map((l) => `${l.nameAr} (فرق ${formatMoney(l.difference)})`)
              .join('، ')}
            {check.transit !== '0' && ` · بضاعة في الطريق ${formatMoney(check.transit)}`}. أخبر
            المطوّر — هذا لا يحدث إلا بخطأ برمجي.
          </Alert>
        </div>
      )}

      {can(user, 'accounting.post') && (
        <div className="mb-6 flex flex-wrap gap-2">
          {ACTIONS.map((a) => (
            <Link key={a.kind} to="/finance/new" search={{ kind: a.kind }}>
              <Button variant={a.kind === 'JOURNAL' ? 'secondary' : 'primary'}>
                {a.label}
                <span className="text-xs font-normal opacity-80">({a.hint})</span>
              </Button>
            </Link>
          ))}
        </div>
      )}

      <h2 className="mb-2 text-lg font-bold">الصناديق</h2>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {boxes
          .filter((b) => b.account.isActive)
          .map((b) => (
            <Link
              key={b.account.id}
              to="/finance/accounts/$accountId"
              params={{ accountId: b.account.id }}
            >
              <Card className="h-full hover:border-brand">
                <div className="text-sm text-ink-muted">{b.account.nameAr}</div>
                <div className="tabular text-2xl font-bold">
                  {formatMoney(b.balance, b.account.currency ?? 'USD')}
                </div>
                {b.account.currency !== 'USD' && (
                  <div className="tabular text-sm text-ink-muted">
                    في الدفاتر {formatMoney(b.bookValue)}
                    {b.rate &&
                      ` · بسعر اليوم ${formatMoney(toUsdCents(b.balance, b.account.currency!, b.rate))}`}
                  </div>
                )}
              </Card>
            </Link>
          ))}
      </div>
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}

      {income && (
        <>
          <h2 className="mb-2 text-lg font-bold">هذا الشهر (بالدولار)</h2>
          <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="المبيعات" value={section('revenue')} />
            <Stat label="تكلفة البضاعة المباعة" value={section('costOfSales')} />
            <Stat label="المصاريف" value={section('expenses')} />
            <Stat label="صافي الربح" value={income.netProfit} strong />
          </div>
        </>
      )}

      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-bold">آخر القيود</h2>
        <Link to="/finance/entries" className="text-brand">
          كل القيود ←
        </Link>
      </div>
      {recent.length === 0 ? (
        <EmptyState title="لا توجد قيود بعد">
          كل استلام أو بيع أو نقل في المستودع يُسجَّل هنا تلقائياً. ابدأ بتسجيل ما في الصناديق الآن:
          «سند قبض» إلى كل صندوق، والحساب المقابل «أرصدة افتتاحية».
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <tbody>
              {recent.slice(0, 10).map((e) => (
                <tr key={e.id} className="border-t border-stone first:border-0">
                  <td className="tabular p-3 text-ink-muted">{e.entryDate}</td>
                  <td className="p-3">
                    <Link
                      to="/finance/entries/$entryId"
                      params={{ entryId: e.id }}
                      className="font-medium text-brand"
                    >
                      {VOUCHER_TYPE[e.voucherType]} {voucherNumber(e)}
                    </Link>
                  </td>
                  <td className="p-3">{e.memo}</td>
                  <td className="tabular p-3">
                    {formatMoney(
                      e.lines
                        .filter((l) => BigInt(l.amountBase) > 0n)
                        .reduce((s, l) => s + BigInt(l.amountBase), 0n)
                        .toString(),
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <Card className={strong ? 'border-brand' : undefined}>
      <div className="text-sm text-ink-muted">{label}</div>
      <div
        className={`tabular text-2xl font-bold ${strong && BigInt(value) < 0n ? 'text-bad' : ''}`}
      >
        {formatMoney(value)}
      </div>
    </Card>
  );
}
