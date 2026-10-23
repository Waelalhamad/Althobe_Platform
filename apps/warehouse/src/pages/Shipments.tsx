import { Alert, Button, Card, Chip, EmptyState, PageTitle } from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type ScanSession, type Shipment } from '../api';
import { errorText, formatMoney, formatQuantity, variantName } from '../format';
import { PAGES } from '../help';
import { can, locationsQuery, meQuery } from '../queries';

/**
 * الشحنات (developer report F-04): goods sent between branches. On the road until the receiving
 * end scans what arrived; what did not arrive is lost in shipping.
 */
export function ShipmentsPage() {
  const [status, setStatus] = useState<'IN_TRANSIT' | 'RECEIVED'>('IN_TRANSIT');
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['shipments', status],
    queryFn: async () => api.shipments(status),
  });
  return (
    <>
      <PageTitle intro={PAGES.shipments}>الشحنات بين الفروع</PageTitle>
      <div className="mb-4 flex gap-2">
        <Chip selected={status === 'IN_TRANSIT'} onClick={() => setStatus('IN_TRANSIT')}>
          بالطريق
        </Chip>
        <Chip selected={status === 'RECEIVED'} onClick={() => setStatus('RECEIVED')}>
          وصلت
        </Chip>
      </div>
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {!isLoading && rows.length === 0 && (
        <EmptyState title={status === 'IN_TRANSIT' ? 'ما في شي بالطريق' : 'ما في شحنات واصلة بعد'}>
          الشحنة بتنبعت من «المخزون» ← الموقع ← «نقل بضاعة»، وبتختار مستودع الفرع التاني.
        </EmptyState>
      )}
      <div className="flex flex-col gap-3">
        {rows.map((s) => (
          <ShipmentCard key={s.id} shipment={s} />
        ))}
      </div>
    </>
  );
}

function ShipmentCard({ shipment: s }: { shipment: Shipment }) {
  const { data: user } = useQuery(meQuery);
  const { data: locations = [] } = useQuery(locationsQuery);
  const navigate = useNavigate();
  const name = (id: string) => locations.find((l) => l.id === id)?.nameAr ?? '';
  const canReceive =
    s.status === 'IN_TRANSIT' &&
    can(user, 'inventory.receive') &&
    (locations.find((l) => l.id === s.toLocationId)?.mine ?? false);
  const receive = useMutation({
    mutationFn: async () => api.receiveShipment(s.id),
    onSuccess: async ({ sessionId }) =>
      navigate({ to: '/sessions/$sessionId', params: { sessionId } }),
  });
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-56 flex-1">
          <div className="text-lg font-bold">
            شحنة رقم <span className="tabular">{s.number}</span>: {name(s.fromLocationId)} ←{' '}
            {name(s.toLocationId)}
          </div>
          <div className="text-sm text-ink-muted">
            انبعتت{' '}
            <span className="tabular" dir="ltr">
              {new Date(s.sentAt).toLocaleDateString('en-GB')}
            </span>{' '}
            · {s.sentBy}
            {s.receivedAt && (
              <>
                {' '}
                · وصلت{' '}
                <span className="tabular" dir="ltr">
                  {new Date(s.receivedAt).toLocaleDateString('en-GB')}
                </span>{' '}
                · استلمها {s.receivedBy}
              </>
            )}
          </div>
        </div>
        <div className="text-end">
          <div className="tabular text-xl font-bold">{formatQuantity(s.sent)} قطعة</div>
          {s.valueBaseAmount !== null && (
            <div className="tabular text-ink-muted">{formatMoney(s.valueBaseAmount)}</div>
          )}
        </div>
        {canReceive && (
          <Button size="lg" disabled={receive.isPending} onClick={() => receive.mutate()}>
            📦 استلام الشحنة
          </Button>
        )}
      </div>
      {s.lost !== null && s.lost > 0 && (
        <Alert tone="warn">
          وصل {formatQuantity(s.received ?? 0)} من {formatQuantity(s.sent)} —{' '}
          {formatQuantity(s.lost)} قطعة انحسبت «فقد بالشحن».
        </Alert>
      )}
      <ul className="text-sm text-ink-muted">
        {s.lines.map((l, i) => (
          <li key={i}>
            {l.variant ? variantName(l.variant) : '—'} × <span className="tabular">{l.sent}</span>
            {l.received !== null && l.received !== l.sent && (
              <b className="text-warn"> (وصل {l.received})</b>
            )}
          </li>
        ))}
      </ul>
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: s.sendSessionId }}
        className="text-sm font-medium text-brand underline"
      >
        تفاصيل الإرسال
      </Link>
      {receive.isError && <Alert>{errorText(receive.error)}</Alert>}
    </Card>
  );
}

/** On a transfer to the other branch, before it is sent: what a shipment means. */
export function ShipmentSendNote({ destination }: { destination: string }) {
  return (
    <div className="mb-4">
      <Alert tone="warn">
        هي <b>شحنة لـ {destination}</b>: القطع بتطلع من هون أول ما تأكّد، وبتضل «بالطريق» لحتى{' '}
        {destination} يمسحوا شو وصل. يلي ما بيوصل بينحسب «فقد بالشحن».
      </Alert>
    </div>
  );
}

/**
 * The receiving end of a shipment: what was sent next to what has been scanned, so a shortage or
 * a piece that was not sent is seen before confirming.
 */
export function ShipmentExpected({ session }: { session: ScanSession }) {
  const shipment = session.shipment;
  if (!shipment) return null;
  const scanned = new Map(session.lines.map((l) => [l.variant.id, l.quantity]));
  const missing = shipment.sent.reduce(
    (s, l) => s + Math.max(0, l.quantity - (scanned.get(l.variant.id) ?? 0)),
    0,
  );
  const extra = session.lines.filter((l) => {
    const sent = shipment.sent.find((s) => s.variant.id === l.variant.id);
    return !sent || l.quantity > sent.quantity;
  });
  return (
    <Card className="mt-4 flex flex-col gap-3">
      <h2 className="text-lg font-bold">
        📦 شو انبعت بالشحنة رقم <span className="tabular">{shipment.number}</span>
      </h2>
      <table className="w-full">
        <thead className="text-sm text-ink-muted">
          <tr>
            <th className="p-2 text-start">الصنف</th>
            <th className="p-2 text-start">انبعت</th>
            <th className="p-2 text-start">وصل (ممسوح)</th>
          </tr>
        </thead>
        <tbody>
          {shipment.sent.map((l) => {
            const got = scanned.get(l.variant.id) ?? 0;
            return (
              <tr key={l.variant.id} className="border-t border-stone">
                <td className="p-2">{variantName(l.variant)}</td>
                <td className="tabular p-2">{l.quantity}</td>
                <td
                  className={`tabular p-2 font-bold ${got === l.quantity ? 'text-ok' : got > l.quantity ? 'text-bad' : 'text-warn'}`}
                >
                  {got}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {extra.length > 0 && (
        <Alert>
          في {extra.length} صنف ما انبعت بهالشحنة أو أكتر من يلي انبعت — شيلو قبل التأكيد.
        </Alert>
      )}
      {missing > 0 && extra.length === 0 && (
        <Alert tone="warn">
          ناقص {formatQuantity(missing)} قطعة. إذا أكّدت هيك، بتنحسب «فقد بالشحن». إذا لسا عم تمسح،
          كمّل.
        </Alert>
      )}
      {missing === 0 && extra.length === 0 && <Alert tone="ok">وصل كل شي ✓</Alert>}
    </Card>
  );
}
