import { Card, Code, Field, PageTitle, Select } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { formatQuantity, MOVEMENT_TYPE } from '../format';
import { locationsQuery, movementsQuery } from '../queries';

const route = getRouteApi('/app/movements');

/** Who did what, where, when, and why — straight from the append-only ledger. */
export function MovementsPage() {
  const { variantId, locationId } = route.useSearch();
  const navigate = useNavigate();
  const { data: locations = [] } = useQuery(locationsQuery);
  const { data: rows = [], isLoading } = useQuery(movementsQuery({ variantId, locationId }));
  const locationName = (id: string) => locations.find((l) => l.id === id)?.nameAr ?? '';
  const filteredVariant = variantId ? rows[0]?.variant : undefined;

  return (
    <>
      <PageTitle>سجل الحركات</PageTitle>
      <Card className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-60">
          <Field label="الموقع">
            <Select
              value={locationId ?? ''}
              onChange={(e) =>
                void navigate({
                  to: '/movements',
                  search: { variantId, locationId: e.target.value || undefined },
                })
              }
            >
              <option value="">كل المواقع</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nameAr}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {variantId && (
          <button
            type="button"
            className="text-sm text-brand underline"
            onClick={() =>
              void navigate({ to: '/movements', search: { variantId: undefined, locationId } })
            }
          >
            {filteredVariant
              ? `الصنف: ${filteredVariant.product.nameAr} · ${filteredVariant.fabric} · ${filteredVariant.colour} · ${filteredVariant.size}`
              : 'صنف محدد'}{' '}
            — عرض الكل
          </button>
        )}
        <span className="ms-auto text-sm text-ink-muted">آخر 50 حركة</span>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-3 text-start">الوقت</th>
              <th className="p-3 text-start">النوع</th>
              <th className="p-3 text-start">الصنف</th>
              <th className="p-3 text-start">الموقع</th>
              <th className="p-3 text-start">الكمية</th>
              <th className="p-3 text-start">الرصيد بعدها</th>
              <th className="p-3 text-start">بواسطة</th>
              <th className="p-3 text-start">السبب / ملاحظة</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ movement: m, variant: v, createdByName }) => (
              <tr key={m.id} className="border-t border-stone">
                <td className="tabular p-3 text-sm text-ink-muted" dir="ltr">
                  {new Date(m.createdAt).toLocaleString('en-GB')}
                </td>
                <td className="p-3">{MOVEMENT_TYPE[m.type] ?? m.type}</td>
                <td className="p-3">
                  {v ? (
                    <>
                      <div className="font-medium">{v.product.nameAr}</div>
                      <div className="text-sm text-ink-muted">
                        {v.fabric} · {v.colour} · {v.size} · <Code>{v.sku}</Code>
                      </div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="p-3">{locationName(m.locationId)}</td>
                <td
                  className={`tabular p-3 font-bold ${m.quantity < 0 ? 'text-bad' : 'text-ok'}`}
                  dir="ltr"
                >
                  {m.quantity > 0 ? `+${m.quantity}` : m.quantity}
                </td>
                <td className="tabular p-3">{formatQuantity(m.balanceAfter)}</td>
                <td className="p-3">{createdByName ?? '—'}</td>
                <td className="p-3 text-sm">{m.reason ?? m.note ?? ''}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-ink-muted">
                  جارٍ التحميل…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-ink-muted">
                  لا توجد حركات
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}
