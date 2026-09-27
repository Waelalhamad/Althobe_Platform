import { Alert, Button, Card, Field, PageTitle, Select } from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api } from '../api';
import { errorText, STOCKTAKE_STATUS } from '../format';
import { can, locationsQuery, meQuery, stocktakesQuery } from '../queries';

export function StocktakesPage() {
  const { data: user } = useQuery(meQuery);
  const { data: locations = [] } = useQuery(locationsQuery);
  const { data: stocktakes = [], isLoading } = useQuery(stocktakesQuery);
  const [locationId, setLocationId] = useState('');
  const navigate = useNavigate();

  // Create and start counting in one step: the snapshot is taken the moment counting begins.
  const start = useMutation({
    mutationFn: async () => {
      const created = await api.createStocktake(locationId);
      return api.startStocktake(created.id);
    },
    onSuccess: async (st) =>
      navigate({ to: '/stocktakes/$stocktakeId', params: { stocktakeId: st.id } }),
  });

  const locationName = (id: string) => locations.find((l) => l.id === id)?.nameAr ?? '';

  return (
    <>
      <PageTitle>الجرد</PageTitle>

      {can(user, 'inventory.stocktake.count') && (
        <Card className="mb-4 flex flex-col gap-3">
          <p className="text-sm text-ink-muted">
            جرد كامل للموقع: يُحفظ رصيد النظام لحظة البدء، ثم تُعدّ البضاعة بالمسح دون رؤية الرصيد
            المتوقع. الفروقات تظهر عند المراجعة، ويعتمدها شخص آخر.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-60">
              <Field label="الموقع">
                <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">اختر الموقع…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.nameAr}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button disabled={!locationId || start.isPending} onClick={() => start.mutate()}>
              بدء جرد جديد
            </Button>
          </div>
          {start.isError && <Alert>{errorText(start.error)}</Alert>}
        </Card>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-3 text-start">الموقع</th>
              <th className="p-3 text-start">الحالة</th>
              <th className="p-3 text-start">الأصناف</th>
              <th className="p-3 text-start">التاريخ</th>
            </tr>
          </thead>
          <tbody>
            {stocktakes.map((st) => (
              <tr key={st.id} className="border-t border-stone hover:bg-surface">
                <td className="p-3">
                  <Link
                    to="/stocktakes/$stocktakeId"
                    params={{ stocktakeId: st.id }}
                    className="font-medium text-brand"
                  >
                    {locationName(st.locationId)}
                  </Link>
                </td>
                <td className="p-3">{STOCKTAKE_STATUS[st.status]}</td>
                <td className="tabular p-3">{st.lineCount}</td>
                <td className="tabular p-3 text-ink-muted" dir="ltr">
                  {new Date(st.createdAt).toLocaleString('en-GB')}
                </td>
              </tr>
            ))}
            {!isLoading && stocktakes.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-ink-muted">
                  لا يوجد جرد بعد
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
