import { Alert, Card, Chip, Field, Input, Select, useToast } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type RecipientKind, type ScanSession } from '../api';
import { errorText, formatMoney, RECIPIENT_KIND } from '../format';
import { shrinkPhoto } from '../photo';

/** Who received a gift and why (developer report F-06), asked before it is confirmed. */
export interface GiftDraft {
  /** One from the list; empty for a new name. */
  recipientId: string;
  name: string;
  kind: RecipientKind | '';
  phone: string;
  occasion: string;
  reference: string;
}
export const NO_GIFT: GiftDraft = {
  recipientId: '',
  name: '',
  kind: '',
  phone: '',
  occasion: '',
  reference: '',
};

export const giftReady = (g: GiftDraft) =>
  g.occasion.trim().length > 0 && (g.recipientId !== '' || (g.name.trim() !== '' && g.kind !== ''));

export function giftBody(g: GiftDraft) {
  return {
    ...(g.recipientId
      ? { recipientId: g.recipientId }
      : {
          recipient: {
            name: g.name.trim(),
            kind: g.kind as RecipientKind,
            ...(g.phone.trim() ? { phone: g.phone.trim() } : {}),
          },
        }),
    occasion: g.occasion.trim(),
    ...(g.reference.trim() ? { reference: g.reference.trim() } : {}),
  };
}

const recipientsQuery = { queryKey: ['gift-recipients'], queryFn: api.giftRecipients };

/**
 * The gift's card on an open GIFT session: who, what kind of recipient, the occasion, and what
 * it is worth — at cost (what goes to 5212) and, for information, at the selling price.
 */
export function GiftCard({
  session,
  draft,
  onChange,
  costOf,
}: {
  session: ScanSession;
  draft: GiftDraft;
  onChange: (d: GiftDraft) => void;
  /** Average cost per piece, USD cents, at the session's location; undefined while loading. */
  costOf: (variantId: string) => string | null | undefined;
}) {
  const { data: recipients = [] } = useQuery(recipientsQuery);
  const set = (patch: Partial<GiftDraft>) => onChange({ ...draft, ...patch });
  const isNew = draft.recipientId === '';

  const atCost = session.lines.reduce((s, l) => {
    const unit = costOf(l.variant.id);
    return unit ? s + BigInt(unit) * BigInt(l.quantity) : s;
  }, 0n);
  const atPrice = session.lines.reduce(
    (s, l) =>
      l.variant.prices.retailSyp
        ? s + BigInt(l.variant.prices.retailSyp.amount) * BigInt(l.quantity)
        : s,
    0n,
  );

  return (
    <Card className="mt-4 flex flex-col gap-4">
      <h2 className="text-lg font-bold">🎁 لمين الهدية؟</h2>
      {recipients.length > 0 && (
        <Field label="من القائمة">
          <Select value={draft.recipientId} onChange={(e) => set({ recipientId: e.target.value })}>
            <option value="">— شخص أو جهة جديدة —</option>
            {recipients.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {RECIPIENT_KIND[r.kind]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {isNew && (
        <>
          <div className="flex flex-wrap gap-3">
            <div className="min-w-56 flex-1">
              <Field label="الاسم (إلزامي)" hint="بينحفظ، والمرة الجاية بتختارو من القائمة">
                <Input
                  value={draft.name}
                  onChange={(e) => set({ name: e.target.value })}
                  placeholder="مثلاً: شركة الأمين للشحن"
                />
              </Field>
            </div>
            <div className="w-48">
              <Field label="الهاتف (اختياري)">
                <Input
                  dir="ltr"
                  value={draft.phone}
                  onChange={(e) => set({ phone: e.target.value })}
                />
              </Field>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold">نوعو (إلزامي)</span>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(RECIPIENT_KIND) as RecipientKind[]).map((k) => (
                <Chip key={k} selected={draft.kind === k} onClick={() => set({ kind: k })}>
                  {RECIPIENT_KIND[k]}
                </Chip>
              ))}
            </div>
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-3">
        <div className="min-w-64 flex-[2]">
          <Field label="المناسبة / السبب (إلزامي)">
            <Input
              value={draft.occasion}
              onChange={(e) => set({ occasion: e.target.value })}
              placeholder="مثلاً: إكرامية شحنة ليبيا"
            />
          </Field>
        </div>
        <div className="min-w-48 flex-1">
          <Field label="رقم الشحنة أو الطلب (اختياري)">
            <Input value={draft.reference} onChange={(e) => set({ reference: e.target.value })} />
          </Field>
        </div>
      </div>
      {session.totalQuantity > 0 && (
        <p className="text-ink-muted">
          قيمتها بالتكلفة: <b className="tabular text-ink">{formatMoney(atCost.toString())}</b>
          {atPrice > 0n && (
            <>
              {' '}
              · لو انباعت: <b className="tabular">{formatMoney(atPrice.toString(), 'SYP')}</b>{' '}
              (للمعلومة بس)
            </>
          )}
        </p>
      )}
      <p className="text-sm text-ink-muted">
        بعد التأكيد بتطلع القطع من المخزون فوراً، وبتنحسب «هدايا وإكراميات» مو تالف. وبعدها فيك تضيف
        صورة إيصال التسليم.
      </p>
    </Card>
  );
}

/** A confirmed gift: who received it, and the delivery receipt photo. */
export function GiftDone({ sessionId }: { sessionId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: gift } = useQuery({
    queryKey: ['gift', sessionId],
    queryFn: async () => api.gift(sessionId),
  });
  const [stamp, setStamp] = useState(0);
  const upload = useMutation({
    mutationFn: async (file: File) => api.giftPhoto(sessionId, (await shrinkPhoto(file)).image),
    onSuccess: async (updated) => {
      queryClient.setQueryData(['gift', sessionId], updated);
      setStamp(Date.now());
      toast('انحفظت صورة الإيصال');
      await queryClient.invalidateQueries({ queryKey: ['gifts'] });
    },
  });
  if (!gift) return null;
  return (
    <Card className="mb-4 flex flex-wrap items-center gap-4">
      <div className="min-w-56 flex-1">
        <div className="text-lg font-bold">
          🎁 {gift.recipient.name}{' '}
          <span className="text-sm font-medium text-ink-muted">
            ({RECIPIENT_KIND[gift.recipient.kind]})
          </span>
        </div>
        <div className="text-ink-muted">
          {gift.occasion}
          {gift.reference && ` · ${gift.reference}`} ·{' '}
          <span className="tabular">{formatMoney(gift.valueBaseAmount)}</span>
        </div>
        <Link to="/gifts" className="text-sm font-medium text-brand underline">
          كل الهدايا ←
        </Link>
      </div>
      {gift.hasPhoto && (
        <a href={`/api/v1/gifts/${sessionId}/photo`} target="_blank" rel="noreferrer">
          <img
            src={`/api/v1/gifts/${sessionId}/photo?v=${stamp}`}
            alt="إيصال التسليم"
            className="h-24 rounded-lg border border-stone object-cover"
          />
        </a>
      )}
      <label className="cursor-pointer">
        <input
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
            e.target.value = '';
          }}
        />
        <span className="inline-flex min-h-11 items-center rounded-lg border border-stone bg-white px-4 font-medium hover:bg-blush">
          {upload.isPending
            ? 'جارٍ الرفع…'
            : gift.hasPhoto
              ? '📷 غيّر صورة الإيصال'
              : '📷 أضف صورة إيصال التسليم'}
        </span>
      </label>
      {upload.isError && (
        <div className="w-full">
          <Alert>{errorText(upload.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
