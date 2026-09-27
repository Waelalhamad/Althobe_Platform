import { Card, Code, PageTitle } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { formatMoney, formatQuantity } from '../format';
import { can, locationsQuery, meQuery, summaryQuery } from '../queries';

/** Stock on hand per location and product. Value (SYP, moving average) only for cost viewers. */
export function ReportsPage() {
  const { data: user } = useQuery(meQuery);
  const { data: locations = [] } = useQuery(locationsQuery);
  const { data: rows = [], isLoading } = useQuery(summaryQuery);
  const showCost = can(user, 'inventory.cost.view');

  const sum = (items: typeof rows) => ({
    quantity: items.reduce((s, r) => s + r.quantity, 0),
    value: items.reduce((s, r) => s + BigInt(r.valueBaseAmount ?? '0'), 0n).toString(),
  });
  const grand = sum(rows);

  return (
    <>
      <PageTitle>تقرير المخزون</PageTitle>

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        {locations.map((l) => {
          const total = sum(rows.filter((r) => r.locationId === l.id));
          return (
            <Card key={l.id}>
              <div className="text-sm text-ink-muted">{l.nameAr}</div>
              <div className="tabular text-2xl font-bold">
                {formatQuantity(total.quantity)} قطعة
              </div>
              {showCost && <div className="tabular text-ink-muted">{formatMoney(total.value)}</div>}
            </Card>
          );
        })}
        <Card className="border-brand">
          <div className="text-sm text-ink-muted">الإجمالي</div>
          <div className="tabular text-2xl font-bold">{formatQuantity(grand.quantity)} قطعة</div>
          {showCost && <div className="tabular text-ink-muted">{formatMoney(grand.value)}</div>}
        </Card>
      </div>

      {locations.map((l) => {
        const items = rows.filter((r) => r.locationId === l.id);
        if (items.length === 0) return null;
        return (
          <Card key={l.id} className="mb-4 overflow-x-auto p-0">
            <h2 className="p-3 font-bold">{l.nameAr}</h2>
            <table className="w-full">
              <thead className="bg-blush text-sm text-ink-muted">
                <tr>
                  <th className="p-3 text-start">المنتج</th>
                  <th className="p-3 text-start">الرمز</th>
                  <th className="p-3 text-start">أصناف متوفرة</th>
                  <th className="p-3 text-start">القطع</th>
                  {showCost && <th className="p-3 text-start">القيمة</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.productId} className="border-t border-stone">
                    <td className="p-3 font-medium">{r.productNameAr}</td>
                    <td className="p-3">
                      <Code>{r.productCode}</Code>
                    </td>
                    <td className="tabular p-3">{r.variants}</td>
                    <td className="tabular p-3 font-bold">{formatQuantity(r.quantity)}</td>
                    {showCost && <td className="tabular p-3">{formatMoney(r.valueBaseAmount)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        );
      })}
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {!isLoading && rows.length === 0 && <p className="text-ink-muted">لا يوجد مخزون بعد.</p>}
    </>
  );
}
