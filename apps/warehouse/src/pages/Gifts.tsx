import { Card, EmptyState, Field, Input, PageTitle, Select } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Gift, type RecipientKind } from '../api';
import { formatMoney, formatQuantity, RECIPIENT_KIND } from '../format';
import { PAGES } from '../help';
import { locationsQuery } from '../queries';

/**
 * تقرير الهدايا (developer report F-06): every gift on a line, with who got it, why, and what it
 * cost; totals per recipient and per month. Its total is what 5212 holds for gifts.
 */
export function GiftsPage() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recipientId, setRecipientId] = useState('');
  const [kind, setKind] = useState<RecipientKind | ''>('');
  const [locationId, setLocationId] = useState('');
  const params = { from, to, recipientId, kind, locationId };
  const { data: gifts = [], isLoading } = useQuery({
    queryKey: ['gifts', params],
    queryFn: async () => api.gifts(params),
  });
  const { data: recipients = [] } = useQuery({
    queryKey: ['gift-recipients'],
    queryFn: api.giftRecipients,
  });
  const { data: locations = [] } = useQuery(locationsQuery);
  const locationName = (id: string) => locations.find((l) => l.id === id)?.nameAr ?? '';

  const shown = gifts.filter((g) => !g.undone);
  const total = shown.reduce((s, g) => s + BigInt(g.valueBaseAmount), 0n);
  const pieces = shown.reduce((s, g) => s + g.quantity, 0);

  return (
    <>
      <PageTitle intro={PAGES.gifts}>الهدايا والإكراميات</PageTitle>
      <Card className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-40">
          <Field label="من">
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        </div>
        <div className="w-40">
          <Field label="لـ">
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="min-w-48">
          <Field label="المستلم">
            <Select value={recipientId} onChange={(e) => setRecipientId(e.target.value)}>
              <option value="">الكل</option>
              {recipients.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="min-w-40">
          <Field label="النوع">
            <Select value={kind} onChange={(e) => setKind(e.target.value as RecipientKind | '')}>
              <option value="">الكل</option>
              {(Object.keys(RECIPIENT_KIND) as RecipientKind[]).map((k) => (
                <option key={k} value={k}>
                  {RECIPIENT_KIND[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="min-w-40">
          <Field label="الموقع">
            <Select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">الكل</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.nameAr}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Card>

      {shown.length > 0 && (
        <div className="mb-4 grid gap-4 md:grid-cols-3">
          <Card>
            <div className="text-sm font-semibold text-ink-muted">المجموع</div>
            <div className="tabular text-2xl font-bold">{formatMoney(total.toString())}</div>
            <div className="text-ink-muted">{formatQuantity(pieces)} قطعة</div>
          </Card>
          <Totals title="لكل مستلم" rows={groupBy(shown, (g) => g.recipient.name)} />
          <Totals title="لكل شهر" rows={groupBy(shown, (g) => g.date.slice(0, 7))} />
        </div>
      )}

      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {!isLoading && gifts.length === 0 && (
        <EmptyState title="ما في هدايا هون">
          الهدية بتنسجّل من «المخزون» ← الموقع ← «🎁 هدية / إكرامية»: بتمسح القطع، وبتكتب لمين وليش.
        </EmptyState>
      )}
      <div className="flex flex-col gap-3">
        {gifts.map((g) => (
          <GiftRow key={g.sessionId} gift={g} location={locationName(g.locationId)} />
        ))}
      </div>
    </>
  );
}

function GiftRow({ gift: g, location }: { gift: Gift; location: string }) {
  return (
    <Card className={`flex flex-wrap items-start gap-4 ${g.undone ? 'opacity-70' : ''}`}>
      <div className="min-w-56 flex-1">
        <div className="text-lg font-bold">
          {g.recipient.name}{' '}
          <span className="text-sm font-medium text-ink-muted">
            · {RECIPIENT_KIND[g.recipient.kind]}
            {g.recipient.phone && <span dir="ltr"> · {g.recipient.phone}</span>}
          </span>
        </div>
        <div>
          {g.occasion}
          {g.reference && <span className="text-ink-muted"> · {g.reference}</span>}
        </div>
        <ul className="mt-1 text-sm text-ink-muted">
          {g.lines.map((l, i) => (
            <li key={i} className={l.quantity === 0 ? 'line-through' : ''}>
              {l.variant ? `${l.variant.product.nameAr} · ${l.variant.title}` : '—'} ×{' '}
              <span className="tabular">{l.quantity || '↩'}</span>
            </li>
          ))}
        </ul>
        <div className="mt-1 text-sm text-ink-muted">
          <span className="tabular" dir="ltr">
            {g.date}
          </span>{' '}
          · {location} · سجّلها {g.createdBy}
          {g.undone && <b className="text-warn"> · ↩ متراجَع عنها</b>}
        </div>
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: g.sessionId }}
          className="text-sm font-medium text-brand underline"
        >
          التفاصيل والصورة
        </Link>
      </div>
      <div className="text-end">
        <div className="tabular text-xl font-bold">{formatMoney(g.valueBaseAmount)}</div>
        <div className="text-sm text-ink-muted">{formatQuantity(g.quantity)} قطعة</div>
      </div>
      {g.hasPhoto && (
        <a href={`/api/v1/gifts/${g.sessionId}/photo`} target="_blank" rel="noreferrer">
          <img
            src={`/api/v1/gifts/${g.sessionId}/photo`}
            alt="إيصال التسليم"
            loading="lazy"
            className="h-20 w-20 rounded-lg border border-stone object-cover"
          />
        </a>
      )}
    </Card>
  );
}

function Totals({ title, rows }: { title: string; rows: [string, bigint, number][] }) {
  return (
    <Card>
      <div className="mb-1 text-sm font-semibold text-ink-muted">{title}</div>
      <ul className="flex flex-col gap-1">
        {rows.slice(0, 6).map(([key, value, count]) => (
          <li key={key} className="flex justify-between gap-2">
            <span>{key}</span>
            <span className="tabular">
              {formatQuantity(count)} قطعة · {formatMoney(value.toString())}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function groupBy(gifts: Gift[], key: (g: Gift) => string): [string, bigint, number][] {
  const map = new Map<string, [bigint, number]>();
  for (const g of gifts) {
    const [v, n] = map.get(key(g)) ?? [0n, 0];
    map.set(key(g), [v + BigInt(g.valueBaseAmount), n + g.quantity]);
  }
  return [...map]
    .map(([k, [v, n]]) => [k, v, n] as [string, bigint, number])
    .sort((a, b) => (a[1] === b[1] ? 0 : a[1] < b[1] ? 1 : -1));
}
