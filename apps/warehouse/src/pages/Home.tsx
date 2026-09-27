import { Alert, Button, Card, Input, PageTitle, Select } from '@althobe/ui/components';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Location, type SessionKind, type User } from '../api';
import { errorText, formatQuantity, LOCATION_KIND, SESSION_KIND } from '../format';
import { balancesQuery, can, locationsQuery, meQuery, openSessionsQuery } from '../queries';

type StartInput = { kind: SessionKind; locationId: string; toLocationId?: string; reason?: string };

export function HomePage() {
  const { data: user } = useQuery(meQuery);
  const { data: locations = [], isLoading } = useQuery(locationsQuery);
  const { data: openSessions = [] } = useQuery(openSessionsQuery);
  const balances = useQueries({ queries: locations.map((l) => balancesQuery(l.id)) });
  const navigate = useNavigate();

  const start = useMutation({
    mutationFn: async (input: StartInput) => api.openSession(input),
    onSuccess: async (session) =>
      navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } }),
  });

  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.nameAr ?? '';

  return (
    <>
      <PageTitle>المواقع</PageTitle>
      {start.isError && (
        <div className="mb-4">
          <Alert>{errorText(start.error)}</Alert>
        </div>
      )}

      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      <div className="grid gap-4 md:grid-cols-3">
        {locations.map((location, i) => {
          const rows = balances[i]?.data ?? [];
          const pieces = rows.reduce((sum, r) => sum + r.balance.quantity, 0);
          return (
            <Card key={location.id} className="flex flex-col gap-4">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-xl font-bold">{location.nameAr}</h2>
                  <span className="text-sm text-ink-muted">
                    {LOCATION_KIND[location.kind]} · <span dir="ltr">{location.code}</span>
                  </span>
                </div>
                <Link
                  to="/balances"
                  search={{ locationId: location.id }}
                  className="text-end text-sm text-ink-muted hover:text-brand"
                >
                  <div className="tabular text-2xl font-bold text-ink">
                    {formatQuantity(pieces)}
                  </div>
                  قطعة
                </Link>
              </div>
              <StartActions
                user={user}
                location={location}
                others={locations.filter((l) => l.id !== location.id && l.isActive)}
                onStart={(input) => start.mutate(input)}
                busy={start.isPending}
              />
            </Card>
          );
        })}
      </div>

      {openSessions.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-bold">جلسات مفتوحة</h2>
          <div className="flex flex-col gap-2">
            {openSessions.map((s) => (
              <Link key={s.id} to="/sessions/$sessionId" params={{ sessionId: s.id }}>
                <Card className="flex items-center justify-between hover:border-brand">
                  <span className="font-medium">
                    {SESSION_KIND[s.kind]} — {locationName(s.locationId)}
                    {s.toLocationId && ` ← ${locationName(s.toLocationId)}`}
                  </span>
                  <span className="tabular text-sm text-ink-muted">
                    {s.lineCount} صنف · {formatQuantity(s.totalQuantity)} قطعة
                  </span>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

/** What can be started at a location, filtered by the user's permissions (the server re-checks). */
function StartActions({
  user,
  location,
  others,
  onStart,
  busy,
}: {
  user: User | undefined;
  location: Location;
  others: Location[];
  onStart: (input: StartInput) => void;
  busy: boolean;
}) {
  const [mode, setMode] = useState<'transfer' | 'damage' | null>(null);
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const base = { locationId: location.id };

  if (mode === 'transfer') {
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-blush p-3">
        <span className="text-sm font-medium">نقل إلى:</span>
        <Select value={destination} onChange={(e) => setDestination(e.target.value)}>
          <option value="">اختر الموقع…</option>
          {others.map((l) => (
            <option key={l.id} value={l.id}>
              {l.nameAr}
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <Button
            disabled={busy || !destination}
            onClick={() => onStart({ ...base, kind: 'TRANSFER', toLocationId: destination })}
          >
            ابدأ النقل
          </Button>
          <Button variant="ghost" onClick={() => setMode(null)}>
            رجوع
          </Button>
        </div>
      </div>
    );
  }

  if (mode === 'damage') {
    return (
      <div className="flex flex-col gap-2 rounded-lg bg-blush p-3">
        <span className="text-sm font-medium">سبب التلف (إلزامي):</span>
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="مثال: بلل، تمزق، عيب خياطة"
        />
        <div className="flex gap-2">
          <Button
            variant="danger"
            disabled={busy || reason.trim().length < 3}
            onClick={() => onStart({ ...base, kind: 'DAMAGE', reason: reason.trim() })}
          >
            ابدأ تسجيل التالف
          </Button>
          <Button variant="ghost" onClick={() => setMode(null)}>
            رجوع
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {can(user, 'inventory.receive') && (
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => onStart({ ...base, kind: 'OPENING' })}
        >
          {SESSION_KIND.OPENING}
        </Button>
      )}
      {/* The store is stocked by transfer, never straight from a supplier (inventory.policy.ts). */}
      {can(user, 'inventory.receive') && location.kind === 'WAREHOUSE' && (
        <Button disabled={busy} onClick={() => onStart({ ...base, kind: 'RECEIVE' })}>
          {SESSION_KIND.RECEIVE}
        </Button>
      )}
      {can(user, 'inventory.transfer') && others.length > 0 && (
        <Button variant="secondary" disabled={busy} onClick={() => setMode('transfer')}>
          {SESSION_KIND.TRANSFER}
        </Button>
      )}
      {can(user, 'inventory.damage') && (
        <Button variant="ghost" disabled={busy} onClick={() => setMode('damage')}>
          {SESSION_KIND.DAMAGE}
        </Button>
      )}
    </div>
  );
}
