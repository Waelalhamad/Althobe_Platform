import {
  Alert,
  Card,
  ConfirmButton,
  EmptyState,
  PageTitle,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api } from '../api';
import { CURRENCY_SYMBOL, errorText, formatMoney } from '../format';
import { PAGES } from '../help';
import { can, closingQuery, glAccountsQuery, meQuery, payrollRunsQuery } from '../queries';
import { useRefreshBooks } from './finance-parts';

/** إقفال الشهر: revalue SYP and LYD at today's rates, then lock the month for good. */
export function ClosePage() {
  const { data: status, isLoading } = useQuery(closingQuery);
  const { data: accounts = [] } = useQuery(glAccountsQuery);
  const name = (id: string) => accounts.find((a) => a.id === id)?.nameAr ?? id;
  const { data: user } = useQuery(meQuery);
  const { data: runs } = useQuery({ ...payrollRunsQuery, enabled: can(user, 'payroll.manage') });
  // Salaries are expensed when a sheet is approved: close the month after its sheet (ADR-015).
  const sheet = (period: string) =>
    runs?.find(
      (r) =>
        r.frequency === 'MONTHLY' && r.status !== 'CANCELLED' && r.periodStart.startsWith(period),
    );
  const refresh = useRefreshBooks();
  const toast = useToast();

  const close = useMutation({
    mutationFn: async (period: string) => api.closeMonth(period),
    onSuccess: async (r) => {
      toast(`أُقفل شهر ${r.period}`);
      await refresh();
    },
  });

  return (
    <>
      <PageTitle intro={PAGES.close}>إقفال الشهر</PageTitle>
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {status && (
        <>
          <p className="mb-4">
            آخر شهر مُقفل:{' '}
            <span className="font-bold">
              {status.closedThrough ? status.closedThrough.slice(0, 7) : 'لا يوجد بعد'}
            </span>
          </p>

          {!status.next ? (
            <EmptyState title="لا يوجد شهر جاهز للإقفال">
              يُقفل الشهر بعد انتهائه. الشهر الحالي يُقفل في أول الشهر القادم.
            </EmptyState>
          ) : (
            <Card className="mb-6">
              <h2 className="mb-2 text-lg font-bold">الشهر التالي للإقفال: {status.next}</h2>
              <p className="mb-3 text-ink-muted">
                قبل الإقفال حدّث{' '}
                <Link to="/rates" className="text-brand">
                  أسعار الصرف
                </Link>{' '}
                لسعر آخر يوم في الشهر. تُعاد قيمة الليرة والدينار الموجودة في الصناديق بهذا السعر،
                ويُسجَّل الفرق «فروقات صرف».
              </p>
              <p className="mb-3">
                الأسعار المستخدمة:{' '}
                {Object.entries(status.rates).map(([c, r]) => (
                  <span key={c} className="tabular me-3 font-bold">
                    1 $ = {Number(r)} {CURRENCY_SYMBOL[c as 'SYP']}
                  </span>
                ))}
              </p>
              {runs && runs.length > 0 && sheet(status.next)?.status !== 'APPROVED' && (
                <div className="mb-3">
                  <Alert tone="warn">
                    كشف رواتب شهر {status.next}{' '}
                    {sheet(status.next) ? 'لم يُعتمد بعد' : 'لم يُعمل بعد'} — اعتمده من{' '}
                    <Link to="/finance/payroll" className="font-bold underline">
                      الرواتب
                    </Link>{' '}
                    قبل الإقفال، حتى تدخل رواتب الشهر في أرباحه.
                  </Alert>
                </div>
              )}
              {status.missingRates.length > 0 && (
                <div className="mb-3">
                  <Alert tone="warn">
                    أدخل سعر الصرف أولاً لـ: {status.missingRates.join('، ')}
                  </Alert>
                </div>
              )}
              {status.preview.length > 0 ? (
                <table className="mb-4 w-full text-sm">
                  <thead className="text-ink-muted">
                    <tr>
                      <th className="p-1 text-start">الحساب</th>
                      <th className="p-1 text-start">التعديل بالدولار</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.preview.map((l, i) => (
                      <tr key={i} className="border-t border-stone">
                        <td className="p-1">{name(l.accountId)}</td>
                        <td className="tabular p-1">{formatMoney(l.amountBase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mb-4 text-ink-muted">لا توجد فروقات صرف لهذا الشهر.</p>
              )}
              <ConfirmButton
                onConfirm={() => close.mutate(status.next!)}
                disabled={close.isPending || status.missingRates.length > 0}
              >
                إقفال شهر {status.next}
              </ConfirmButton>
              <p className="mt-2 text-sm text-bad">
                الإقفال نهائي: بعده لا يمكن تسجيل أي قيد بتاريخ داخل هذا الشهر.
              </p>
              {close.isError && (
                <div className="mt-2">
                  <Alert>{errorText(close.error)}</Alert>
                </div>
              )}
            </Card>
          )}

          {status.closed.length > 0 && (
            <>
              <h2 className="mb-2 text-lg font-bold">الأشهر المُقفلة</h2>
              <Card className="p-0">
                <table className="w-full">
                  <tbody>
                    {status.closed.map((p) => (
                      <tr key={p.period} className="border-t border-stone first:border-0">
                        <td className="tabular p-3 font-bold">{p.period}</td>
                        <td className="p-3">{p.closedBy}</td>
                        <td className="p-3 text-sm text-ink-muted">
                          {new Date(p.closedAt).toLocaleString('ar-SY-u-nu-latn')}
                        </td>
                        <td className="p-3">
                          {p.revaluationEntryId && (
                            <Link
                              to="/finance/entries/$entryId"
                              params={{ entryId: p.revaluationEntryId }}
                              className="text-brand"
                            >
                              قيد إعادة التقييم
                            </Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
