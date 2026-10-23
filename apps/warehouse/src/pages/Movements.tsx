import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmButton,
  EmptyState,
  Field,
  Input,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type HistoryRow } from '../api';
import { errorText, formatQuantity, MOVEMENT_TYPE, variantName } from '../format';
import { PAGES } from '../help';
import { can, locationsQuery, meQuery, movementsQuery } from '../queries';

const route = getRouteApi('/app/movements');

/** Who did what, where, when, and why — straight from the append-only ledger. */
export function MovementsPage() {
  const { variantId, locationId } = route.useSearch();
  const navigate = useNavigate();
  const { data: locations = [] } = useQuery(locationsQuery);
  const { data: rows = [], isLoading } = useQuery(movementsQuery({ variantId, locationId }));
  const { data: user } = useQuery(meQuery);
  const canUndo = can(user, 'admin.undo');
  const locationName = (id: string) => locations.find((l) => l.id === id)?.nameAr ?? '';
  const filteredVariant = variantId ? rows[0]?.variant : undefined;

  return (
    <>
      <PageTitle intro={PAGES.movements}>سجل الحركات</PageTitle>
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
            {filteredVariant ? `الصنف: ${variantName(filteredVariant)}` : 'صنف محدد'} — عرض الكل
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
              {canUndo && <th className="p-3" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const { movement: m, variant: v, createdByName } = row;
              return (
                <tr
                  key={m.id}
                  className={`border-t border-stone ${row.undoneById ? 'bg-surface' : ''}`}
                >
                  <td className="tabular p-3 text-sm text-ink-muted" dir="ltr">
                    {new Date(m.createdAt).toLocaleString('en-GB')}
                  </td>
                  <td className="p-3">{MOVEMENT_TYPE[m.type] ?? m.type}</td>
                  <td className="p-3">
                    {v ? (
                      <>
                        <div className="font-medium">{v.product.nameAr}</div>
                        <div className="text-sm text-ink-muted">
                          {v.title} · <Code>{v.sku}</Code>
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
                  <td className="p-3 text-sm">
                    {m.reversesId && <span className="font-bold text-warn">تراجع: </span>}
                    {m.reason ?? m.note ?? ''}
                    {row.undoneById && (
                      <div className="font-bold text-warn">↩ متراجَع عنها — ما إلها أثر</div>
                    )}
                  </td>
                  {canUndo && (
                    <td className="p-3">
                      <UndoButton row={row} />
                    </td>
                  )}
                </tr>
              );
            })}
            {isLoading && (
              <tr>
                <td colSpan={canUndo ? 9 : 8} className="p-6 text-center text-ink-muted">
                  جارٍ التحميل…
                </td>
              </tr>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={canUndo ? 9 : 8} className="p-3">
                  <EmptyState title="لا توجد حركات بعد">
                    كل إدخال أو إخراج أو نقل أو جرد يُسجَّل هنا تلقائياً عند تأكيده.
                  </EmptyState>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

/**
 * «تراجع» (owner only): a manual adjustment or damage made by mistake goes back exactly, at the
 * value it moved, so it leaves neither profit nor loss. Both stay in the history.
 */
function UndoButton({ row }: { row: HistoryRow }) {
  const m = row.movement;
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const undo = useMutation({
    mutationFn: async () => api.undoMovement(m.id, reason.trim(), key),
    onSuccess: async () => {
      setKey(crypto.randomUUID());
      setOpen(false);
      toast('تم التراجع — رجع المخزون والحسابات متل ما كانوا');
      await Promise.all(
        ['movements', 'balances', 'summary'].map(async (k) =>
          queryClient.invalidateQueries({ queryKey: [k] }),
        ),
      );
    },
  });
  const undoable =
    ((m.referenceType === 'MANUAL' && (m.type === 'ADJUSTMENT' || m.type === 'DAMAGE')) ||
      m.type === 'GIFT') &&
    !m.reversesId &&
    !row.undoneById;
  if (!undoable) return null;
  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        ↩ تراجع
      </Button>
    );
  }
  return (
    <div className="flex min-w-64 flex-col gap-2">
      <Input
        autoFocus
        aria-label="سبب التراجع"
        placeholder="ليش؟ مثلاً: انعملت بالغلط"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="flex gap-2">
        <ConfirmButton
          disabled={reason.trim().length < 3 || undo.isPending}
          onConfirm={() => undo.mutate()}
        >
          تراجع
        </ConfirmButton>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          إلغاء
        </Button>
      </div>
      {undo.isError && <Alert>{errorText(undo.error)}</Alert>}
    </div>
  );
}
