import {
  Alert,
  Button,
  Card,
  Code,
  EmptyState,
  Field,
  Input,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type AdjustmentReason, type Balance, type Variant } from '../api';
import {
  ADJUSTMENT_REASON,
  errorText,
  formatMoney,
  formatQuantity,
  formatRetail,
  normalizeDigits,
} from '../format';
import { PAGES } from '../help';
import { balancesQuery, can, locationsQuery, meQuery } from '../queries';

const route = getRouteApi('/app/balances');

export function BalancesPage() {
  const { locationId: selected } = route.useSearch();
  const navigate = useNavigate();
  const { data: user } = useQuery(meQuery);
  const { data: locations = [] } = useQuery(locationsQuery);
  const locationId = selected ?? locations[0]?.id;
  const { data: rows = [], isLoading } = useQuery({
    ...balancesQuery(locationId ?? ''),
    enabled: Boolean(locationId),
  });
  const [filter, setFilter] = useState('');
  const showCost = can(user, 'inventory.cost.view');
  const canAdjust = can(user, 'inventory.adjust');

  const needle = filter.trim().toLowerCase();
  const visible = needle
    ? rows.filter(({ variant: v }) =>
        [v.product.nameAr, v.product.code, v.sku, v.barcode, v.title].some((f) =>
          f.toLowerCase().includes(needle),
        ),
      )
    : rows;
  const total = visible.reduce((sum, r) => sum + r.balance.quantity, 0);

  return (
    <>
      <PageTitle intro={PAGES.balances}>الأرصدة</PageTitle>
      <Card className="mb-4 grid gap-3 md:grid-cols-2">
        <Field label="الموقع">
          <Select
            value={locationId ?? ''}
            onChange={(e) =>
              void navigate({ to: '/balances', search: { locationId: e.target.value } })
            }
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.nameAr}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="بحث" hint="بالاسم أو الباركود أو SKU أو القماش أو اللون أو القياس">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} />
        </Field>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-3 text-start">المنتج</th>
              <th className="p-3 text-start">الصنف</th>
              <th className="p-3 text-start">الباركود</th>
              <th className="p-3 text-start">الكمية</th>
              <th className="p-3 text-start">المتاح</th>
              <th className="p-3 text-start">سعر المفرق</th>
              {showCost && <th className="p-3 text-start">متوسط التكلفة</th>}
              {showCost && <th className="p-3 text-start">القيمة</th>}
              <th className="p-3" />
            </tr>
          </thead>
          <tbody>
            {visible.map(({ variant: v, balance: b }) => (
              <BalanceRow
                key={v.id}
                variant={v}
                balance={b}
                locationId={locationId ?? ''}
                showCost={showCost}
                canAdjust={canAdjust}
              />
            ))}
            {isLoading && (
              <tr>
                <td colSpan={8} className="p-6 text-center text-ink-muted">
                  جارٍ التحميل…
                </td>
              </tr>
            )}
            {!isLoading && visible.length === 0 && (
              <tr>
                <td colSpan={8} className="p-3">
                  {needle ? (
                    <p className="p-3 text-center text-ink-muted">لا نتائج لهذا البحث</p>
                  ) : (
                    <EmptyState title="لا توجد قطع في هذا الموقع بعد">
                      الرصيد يزيد عندما تُدخل القطع بالمسح: «جرد افتتاحي» للبضاعة الموجودة أصلاً، أو
                      «استلام» للبضاعة الجديدة — من الصفحة الرئيسية.
                    </EmptyState>
                  )}
                </td>
              </tr>
            )}
          </tbody>
          {visible.length > 0 && (
            <tfoot className="border-t-2 border-stone bg-surface">
              <tr>
                <td colSpan={3} className="p-3 font-bold">
                  المجموع
                </td>
                <td className="tabular p-3 font-bold">{formatQuantity(total)}</td>
                <td colSpan={showCost ? 5 : 3} />
              </tr>
            </tfoot>
          )}
        </table>
      </Card>
    </>
  );
}

function BalanceRow({
  variant: v,
  balance: b,
  locationId,
  showCost,
  canAdjust,
}: {
  variant: Variant;
  balance: Balance;
  locationId: string;
  showCost: boolean;
  canAdjust: boolean;
}) {
  const [adjusting, setAdjusting] = useState(false);
  const columns = showCost ? 9 : 7;
  return (
    <>
      <tr className="border-t border-stone">
        <td className="p-3 font-medium">{v.product.nameAr}</td>
        <td className="p-3">{v.title}</td>
        <td className="p-3">
          <Code>{v.barcode}</Code>
        </td>
        <td className="tabular p-3 font-bold">{formatQuantity(b.quantity)}</td>
        <td className="tabular p-3">{formatQuantity(b.availableQuantity)}</td>
        <td className="tabular p-3">{formatRetail(v.prices)}</td>
        {showCost && <td className="tabular p-3">{formatMoney(b.averageCostBaseAmount)}</td>}
        {showCost && <td className="tabular p-3">{formatMoney(b.valueBaseAmount)}</td>}
        <td className="p-2">
          <div className="flex justify-end gap-1">
            <Link
              to="/movements"
              search={{ variantId: v.id, locationId }}
              className="rounded-lg px-2 py-1 text-sm text-ink-muted hover:bg-blush"
            >
              السجل
            </Link>
            {canAdjust && !adjusting && (
              <Button variant="ghost" onClick={() => setAdjusting(true)}>
                تعديل
              </Button>
            )}
          </div>
        </td>
      </tr>
      {adjusting && (
        <tr className="bg-blush">
          <td colSpan={columns} className="p-3">
            <AdjustForm
              variantId={v.id}
              locationId={locationId}
              onDone={() => setAdjusting(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * A correction that is not a count, with a required reason (docs/inventory.md). Counting goes
 * through a stocktake so its evidence is kept. One idempotency key per form: a double click or a
 * retried request cannot adjust twice.
 */
function AdjustForm({
  variantId,
  locationId,
  onDone,
}: {
  variantId: string;
  locationId: string;
  onDone: () => void;
}) {
  const [delta, setDelta] = useState('');
  const [reasonCode, setReasonCode] = useState<AdjustmentReason | ''>('');
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const queryClient = useQueryClient();
  const toast = useToast();

  const n = Number(normalizeDigits(delta));
  // Only a count difference adds stock; a gift says who got it (developer report F-03).
  const valid =
    Number.isInteger(n) &&
    n !== 0 &&
    reasonCode !== '' &&
    (n < 0 || reasonCode === 'COUNT_DIFFERENCE') &&
    (reasonCode !== 'GIFT' || note.trim().length > 0);

  const adjust = useMutation({
    mutationFn: async () =>
      api.adjust(
        {
          variantId,
          locationId,
          delta: n,
          reasonCode: reasonCode as AdjustmentReason,
          ...(note.trim() ? { note: note.trim() } : {}),
        },
        key,
      ),
    onSuccess: async (r) => {
      toast(
        r.status === 'PENDING'
          ? 'انبعت الطلب — ما بيتغير المخزون لحتى يوافق عليه شخص تاني'
          : 'تم التعديل',
      );
      await queryClient.invalidateQueries({ queryKey: ['balances'] });
      onDone();
    },
  });

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink-muted">
        لعدّ البضاعة استخدم «الجرد». غلطة بالاستلام بتنصلّح من صفحة الاستلام نفسه («تصحيح
        الاستلام»)، مش من هون. الزيادة، أو أكتر من 3 قطع أو 50 $، بتستنى موافقة شخص تاني.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-32">
          <Field label="التغيير (+ أو −)">
            <Input
              dir="ltr"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="-2"
            />
          </Field>
        </div>
        <div className="w-56">
          <Field label="السبب (إلزامي)">
            <Select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value as AdjustmentReason)}
            >
              <option value="">— اختر —</option>
              {Object.entries(ADJUSTMENT_REASON)
                .filter(([k]) => (n < 0 || k === 'COUNT_DIFFERENCE') && k !== 'GIFT')
                .map(([k, r]) => (
                  <option key={k} value={k}>
                    {r.label}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
        <div className="min-w-48 flex-1">
          <Field label={reasonCode === 'GIFT' ? 'لمين؟ (إلزامي)' : 'ملاحظة'}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <Button disabled={!valid || adjust.isPending} onClick={() => adjust.mutate()}>
          حفظ التعديل
        </Button>
        <Button variant="ghost" onClick={onDone}>
          رجوع
        </Button>
      </div>
      {adjust.isError && <Alert>{errorText(adjust.error)}</Alert>}
    </div>
  );
}
