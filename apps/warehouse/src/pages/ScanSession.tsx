import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmButton,
  Field,
  Input,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { newScanId, useScanInput } from '@althobe/ui/scanner';
import { sound } from '@althobe/ui/sound';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { isTransient, sendScan } from '../scan-retry';
import {
  api,
  ApiError,
  type Currency,
  type ReceiptSource,
  type ScanLine,
  type ScanSession,
} from '../api';
import {
  errorText,
  formatMoney,
  CURRENCY_SYMBOL,
  formatPrice,
  formatRetail,
  formatQuantity,
  fromMinorUnits,
  SESSION_KIND,
  toMinorUnits,
  toUsdCents,
} from '../format';
import { PhotoThumb } from '../photo';
import {
  balancesQuery,
  boxesQuery,
  can,
  locationsQuery,
  meQuery,
  partiesQuery,
  ratesQuery,
  sessionQuery,
} from '../queries';

const route = getRouteApi('/app/sessions/$sessionId');
// Keyed so the page can hold "confirm" while a typed quantity or cost is still saving.
const lineSaveKey = (id: string) => ['line-save', id];

/**
 * The terms a receipt or goods out is confirmed with (ADR-016). A receipt always says where the
 * goods came from (developer report F-01): a supplier on credit, a cash purchase, stock owned
 * before the system, or the owner's own goods. Goods out may go on a wholesale customer.
 */
interface Terms {
  source: ReceiptSource | '';
  partyId: string;
  invoiceNo: string;
  /** Part or all of it paid from a box now. */
  paidNow: boolean;
  boxId: string;
  /** Box currency (a receipt's cash) or the customer's minor units (goods out). */
  amount: string;
  /** The receiver looked at the costs that stand out (F-07). */
  costChecked: boolean;
}
const NO_TERMS: Terms = {
  source: '',
  partyId: '',
  invoiceNo: '',
  paidNow: false,
  boxId: '',
  amount: '',
  costChecked: false,
};

const SOURCES: { key: ReceiptSource; label: string; hint: string; money?: boolean }[] = [
  { key: 'SUPPLIER', label: 'من مورد', hint: 'بالدين، أو جزء كاش' },
  { key: 'CASH', label: 'شراء نقدي', hint: 'دفعت من صندوق', money: true },
  { key: 'OPENING', label: 'بضاعة موجودة من قبل', hint: 'رصيد افتتاحي — ما حدا إله شي' },
  { key: 'OWNER', label: 'من المالك / إنتاج داخلي', hint: 'على جاري المالك' },
];

/**
 * Lines whose cost is more than 15% away from the other sizes of the same product in this
 * receipt (F-07): a typo in a cost goes straight into the stock's value.
 */
function costOutliers(session: ScanSession): string[] {
  const usd = session.lines.map((l) =>
    l.unitCost
      ? BigInt(toUsdCents(l.unitCost.amount, l.unitCost.currency, l.unitCost.rateToBase))
      : null,
  );
  const out: string[] = [];
  session.lines.forEach((l, i) => {
    const mine = usd[i];
    if (mine === null || mine === undefined) return;
    const others = usd.filter(
      (c, j): c is bigint =>
        j !== i && c !== null && session.lines[j]!.variant.product.id === l.variant.product.id,
    );
    if (others.length === 0) return;
    const n = BigInt(others.length);
    const sum = others.reduce((a, b) => a + b, 0n);
    const gap = mine * n - sum;
    // |mine − average| > 15% of the average, without dividing.
    if (sum > 0n && (gap < 0n ? -gap : gap) * 100n > 15n * sum) {
      out.push(
        `${l.variant.title}: ${formatMoney(mine.toString())} والباقي حوالي ${formatMoney((sum / n).toString())}`,
      );
    }
  });
  return out;
}

type LastScan =
  { status: 'ok' | 'dup'; line: ScanLine } | { status: 'bad'; code: string; message: string };

/**
 * docs/inventory.md → "Barcode workflow — scan sessions". A draft: scanning changes nothing in
 * stock until the session is confirmed, and then everything posts at once.
 */
export function ScanSessionPage() {
  const { sessionId } = route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: session, error: loadError } = useQuery(sessionQuery(sessionId));
  const { data: locations = [] } = useQuery(locationsQuery);

  const [last, setLast] = useState<LastScan | null>(null);
  const [pending, setPending] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const open = session?.status === 'OPEN';
  const savingLines = useIsMutating({ mutationKey: lineSaveKey(sessionId) });
  const costed = session?.kind === 'OPENING' || session?.kind === 'RECEIVE';
  // Outgoing sessions take stock away from the source: show what is available there, so an
  // over-scan is visible before confirming rather than refused after.
  const outgoing =
    session?.kind === 'TRANSFER' || session?.kind === 'DAMAGE' || session?.kind === 'SALE';
  const { data: sourceBalances } = useQuery({
    ...balancesQuery(session?.locationId ?? ''),
    enabled: Boolean(open && outgoing && session?.locationId),
  });

  const updateLine = (line: ScanLine) =>
    queryClient.setQueryData<ScanSession>(sessionQuery(sessionId).queryKey, (old) => {
      if (!old) return old;
      const exists = old.lines.some((l) => l.variant.id === line.variant.id);
      const lines = exists
        ? old.lines.map((l) => (l.variant.id === line.variant.id ? line : l))
        : [...old.lines, line];
      return { ...old, lines, totalQuantity: lines.reduce((sum, l) => sum + l.quantity, 0) };
    });

  // Scans are queued, never awaited by the input: the next scan is accepted immediately.
  const handleScan = (code: string) => {
    const scanId = newScanId();
    setPending((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        // Resent while the connection fails; the scanId makes a resend count once.
        const { result, resent } = await sendScan(async () => api.scan(sessionId, code, scanId));
        // A resend that finds its own first attempt already counted is not a double scan.
        const duplicate = result.duplicate && !resent;
        updateLine(result.line);
        if (duplicate) sound.dup();
        else sound.ok();
        setLast({ status: duplicate ? 'dup' : 'ok', line: result.line });
      } catch (error) {
        sound.bad();
        setLast({
          status: 'bad',
          code,
          // Still no connection after every resend: say so, so the piece is scanned again.
          message: isTransient(error)
            ? 'لم تُرسل هذه المسحة (لا اتصال) — امسح القطعة مرة أخرى'
            : errorText(error),
        });
      } finally {
        setPending((n) => n - 1);
      }
    });
  };

  const scanner = useScanInput(handleScan, { enabled: open });

  const toast = useToast();
  const [terms, setTerms] = useState<Terms>(NO_TERMS);
  const { data: boxes = [] } = useQuery({
    ...boxesQuery,
    enabled: Boolean(open && session?.kind === 'RECEIVE' && terms.paidNow),
  });
  const termsCurrency: Currency | null =
    session?.kind === 'RECEIVE'
      ? (boxes.find((b) => b.account.id === terms.boxId)?.account.currency ?? null)
      : null;
  const commit = useMutation({
    mutationFn: async () => {
      if (session?.kind === 'RECEIVE') {
        const paid =
          terms.paidNow && termsCurrency
            ? { boxId: terms.boxId, amount: toMinorUnits(terms.amount, termsCurrency)! }
            : undefined;
        return api.commitReceipt(sessionId, {
          source: terms.source as ReceiptSource,
          ...(terms.partyId && terms.source !== 'OPENING' && terms.source !== 'OWNER'
            ? { partyId: terms.partyId }
            : {}),
          ...(terms.invoiceNo.trim() ? { invoiceNo: terms.invoiceNo.trim() } : {}),
          ...(paid ? { paid } : {}),
        });
      }
      if (session?.kind === 'SALE' && terms.partyId) {
        return api.commitGoodsOut(sessionId, { partyId: terms.partyId, amount: terms.amount });
      }
      return api.commit(sessionId);
    },
    onSuccess: async () => {
      toast('تم الحفظ في المخزون — الأرصدة محدّثة');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['session', sessionId] }),
        queryClient.invalidateQueries({ queryKey: ['balances'] }),
        queryClient.invalidateQueries({ queryKey: ['open-sessions'] }),
      ]);
    },
  });

  const cancel = useMutation({
    mutationFn: async () => api.cancel(sessionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['open-sessions'] });
      await navigate({ to: '/stock' });
    },
  });

  if (loadError) return <Alert>{errorText(loadError)}</Alert>;
  if (!session) return <p className="text-ink-muted">جارٍ التحميل…</p>;

  const locationName = (id: string | null) => locations.find((l) => l.id === id)?.nameAr ?? '';
  const missingCost =
    commit.error instanceof ApiError && commit.error.code === 'SCAN_SESSION_MISSING_COST'
      ? new Set(commit.error.details.variantIds as string[])
      : new Set<string>();
  const refusedVariant =
    commit.error instanceof ApiError && typeof commit.error.details.variantId === 'string'
      ? commit.error.details.variantId
      : null;
  const available = new Map(
    (sourceBalances ?? []).map((r) => [r.variant.id, r.balance.availableQuantity]),
  );
  const availableOf = (variantId: string) =>
    outgoing && open ? (available.get(variantId) ?? 0) : undefined;
  const overScanned =
    outgoing && open && sourceBalances
      ? session.lines.filter((l) => l.quantity > (available.get(l.variant.id) ?? 0))
      : [];

  return (
    <>
      <PageTitle>
        {SESSION_KIND[session.kind]} — {locationName(session.locationId)}
        {session.toLocationId && ` ← ${locationName(session.toLocationId)}`}
      </PageTitle>
      {session.reason && <p className="-mt-2 mb-4 text-ink-muted">السبب: {session.reason}</p>}
      {session.note && <p className="-mt-2 mb-4 text-ink-muted">العميل / ملاحظة: {session.note}</p>}
      {open && session.kind === 'SALE' && (
        <div className="mb-4">
          <Alert tone="warn">أكّد بعد كل زبون أو فاتورة ليبقى الرصيد صحيحاً طوال اليوم.</Alert>
        </div>
      )}

      {session.status === 'COMMITTED' && (
        <div className="mb-4">
          <Alert tone="ok">
            تم الحفظ في المخزون: {formatQuantity(session.totalQuantity)} قطعة في{' '}
            {session.lines.length} صنف.{' '}
            <Link to="/stock" className="underline">
              العودة لعمل المخزون
            </Link>
          </Alert>
        </div>
      )}
      {session.status === 'COMMITTED' && session.kind === 'RECEIVE' && session.received && (
        <CorrectReceipt session={session} />
      )}
      {session.status === 'CANCELLED' && (
        <div className="mb-4">
          <Alert tone="warn">هذه الجلسة ملغاة ولم تؤثر على المخزون.</Alert>
        </div>
      )}

      {open && (
        <Card className="mb-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">
              امسح الباركود (أو اكتبه ثم Enter)
            </span>
            <input
              {...scanner.inputProps}
              className="tabular min-h-14 rounded-lg border-2 border-brand bg-white px-4 text-2xl outline-none focus:ring-4 focus:ring-blush"
              placeholder="2000000000015"
            />
          </label>
          <LastScanPanel last={last} pending={pending} />
        </Card>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-3 text-start">الصنف</th>
              <th className="p-3 text-start">SKU</th>
              <th className="w-28 p-3 text-start">الكمية</th>
              {outgoing && open && <th className="w-24 p-3 text-start">المتوفر</th>}
              {costed && <th className="p-3 text-start">تكلفة القطعة</th>}
              {open && <th className="w-12 p-3" />}
            </tr>
          </thead>
          <tbody>
            {session.lines.map((line) => (
              <LineRow
                key={line.variant.id}
                sessionId={sessionId}
                line={line}
                editable={open}
                costed={costed}
                available={availableOf(line.variant.id)}
                highlight={
                  missingCost.has(line.variant.id) ||
                  refusedVariant === line.variant.id ||
                  overScanned.some((l) => l.variant.id === line.variant.id)
                }
                onChange={updateLine}
                onRemoved={async () =>
                  queryClient.invalidateQueries({ queryKey: ['session', sessionId] })
                }
              />
            ))}
            {session.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-ink-muted">
                  ابدأ المسح — كل مسحة تضيف قطعة واحدة. عند الانتهاء اضغط «تأكيد» بالأسفل ليُحفظ في
                  المخزون؛ قبل التأكيد لا يتغير شيء.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {open && (session.kind === 'RECEIVE' || session.kind === 'SALE') && (
        <TermsCard session={session} terms={terms} onChange={setTerms} />
      )}

      {open && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <span className="tabular text-lg font-bold">
            المجموع: {formatQuantity(session.totalQuantity)} قطعة · {session.lines.length} صنف
          </span>
          <div className="ms-auto flex gap-2">
            <ConfirmButton
              variant="danger"
              onConfirm={() => cancel.mutate()}
              disabled={cancel.isPending}
            >
              إلغاء الجلسة
            </ConfirmButton>
            <ConfirmButton
              size="lg"
              onConfirm={() => commit.mutate()}
              disabled={
                commit.isPending ||
                pending > 0 ||
                savingLines > 0 ||
                session.totalQuantity === 0 ||
                overScanned.length > 0 ||
                !termsReady(session, terms, termsCurrency)
              }
            >
              تأكيد وحفظ في المخزون
            </ConfirmButton>
          </div>
        </div>
      )}
      {overScanned.length > 0 && (
        <div className="mt-3">
          <Alert tone="warn">
            {overScanned.length} صنف بكمية أكبر من المتوفر في {locationName(session.locationId)} —
            عدّل الكمية أو احذف السطر قبل التأكيد.
          </Alert>
        </div>
      )}
      {(commit.isError || cancel.isError) && (
        <div className="mt-3">
          <Alert>{errorText(commit.error ?? cancel.error)}</Alert>
        </div>
      )}
    </>
  );
}

/** Terms can be sent: a receipt has its source and what that source needs. */
function termsReady(session: ScanSession, t: Terms, cashCurrency: Currency | null): boolean {
  if (session.kind === 'RECEIVE') {
    if (!t.source) return false;
    if (t.source === 'SUPPLIER' && !t.partyId) return false;
    if (t.paidNow && !(t.boxId && cashCurrency && toMinorUnits(t.amount, cashCurrency)))
      return false;
    if (costOutliers(session).length > 0 && !t.costChecked) return false;
    return true;
  }
  if (session.kind === 'SALE' && t.partyId) return /^\d+$/.test(t.amount) && t.amount !== '0';
  return true;
}

/**
 * Where the goods came from and whether they were paid in cash (a receipt), or to which
 * wholesale customer they went and at what total (goods out).
 */
function TermsCard({
  session,
  terms,
  onChange,
}: {
  session: ScanSession;
  terms: Terms;
  onChange: (t: Terms) => void;
}) {
  const { data: user } = useQuery(meQuery);
  const receipt = session.kind === 'RECEIVE';
  const manage = can(user, 'parties.manage');
  const { data: parties = [] } = useQuery(partiesQuery(receipt ? 'SUPPLIER' : 'CUSTOMER'));
  const { data: boxes = [] } = useQuery({ ...boxesQuery, enabled: receipt && terms.paidNow });
  const set = (patch: Partial<Terms>) => onChange({ ...terms, ...patch });
  const party = parties.find((p) => p.id === terms.partyId);
  const costs = session.lines.map((l) => l.unitCost);
  const one =
    costs.length > 0 && costs.every((c) => c && c.currency === costs[0]?.currency)
      ? costs[0]!.currency
      : null;
  const goods = one
    ? session.lines.reduce((s, l) => s + BigInt(l.unitCost!.amount) * BigInt(l.quantity), 0n)
    : null;
  const outliers = receipt ? costOutliers(session) : [];
  // Goods out on account is a sale with money in it: only whoever keeps the accounts.
  if (!receipt && (!manage || parties.length === 0)) return null;

  return (
    <Card className="mt-4 flex flex-col gap-3">
      <h2 className="font-bold">
        {receipt ? 'من وين إجت هالبضاعة؟ (لازم تختار)' : 'لتاجر جملة على الحساب؟'}
      </h2>
      {receipt && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {SOURCES.filter((o) => !o.money || manage).map((o) => (
            <button
              key={o.key}
              type="button"
              aria-pressed={terms.source === o.key}
              onClick={() =>
                onChange({
                  ...terms,
                  source: o.key,
                  paidNow: o.key === 'CASH',
                  ...(o.key === 'OPENING' || o.key === 'OWNER'
                    ? { partyId: '', paidNow: false }
                    : {}),
                })
              }
              className={`min-h-16 rounded-xl border-2 px-3 py-2 text-start ${terms.source === o.key ? 'border-brand bg-blush' : 'border-stone bg-white'}`}
            >
              <div className="font-bold">{o.label}</div>
              <div className="text-xs text-ink-muted">{o.hint}</div>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        {(!receipt || terms.source === 'SUPPLIER' || terms.source === 'CASH') && (
          <div className="w-64">
            <Field
              label={
                receipt
                  ? terms.source === 'SUPPLIER'
                    ? 'المورد (إجباري)'
                    : 'المورد (اختياري)'
                  : 'الزبون'
              }
            >
              <Select
                value={terms.partyId}
                onChange={(e) =>
                  onChange({
                    ...terms,
                    partyId: e.target.value,
                    ...(receipt ? {} : { amount: '' }),
                  })
                }
              >
                <option value="">{receipt ? '— اختر —' : '— بدون فاتورة —'}</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nameAr} ({CURRENCY_SYMBOL[p.currency]})
                  </option>
                ))}
              </Select>
            </Field>
            {receipt && parties.length === 0 && (
              <p className="mt-1 text-xs text-ink-muted">
                ما في موردين بعد — أضفهم من «المالية ← الموردون والزبائن».
              </p>
            )}
          </div>
        )}
        {receipt && terms.source === 'SUPPLIER' && (
          <div className="w-40">
            <Field label="رقم فاتورة المورد">
              <Input
                dir="ltr"
                value={terms.invoiceNo}
                onChange={(e) => set({ invoiceNo: e.target.value })}
              />
            </Field>
          </div>
        )}
        {receipt && terms.source === 'SUPPLIER' && manage && (
          <label className="flex min-h-10 items-center gap-2">
            <input
              type="checkbox"
              checked={terms.paidNow}
              onChange={(e) => set({ paidNow: e.target.checked })}
            />
            دفعت جزء كاش هلق
          </label>
        )}
        {receipt && terms.paidNow && (
          <>
            <div className="w-64">
              <Field label="من صندوق">
                <Select value={terms.boxId} onChange={(e) => set({ boxId: e.target.value })}>
                  <option value="">— اختر —</option>
                  {boxes
                    .filter((b) => b.account.isActive)
                    .map((b) => (
                      <option key={b.account.id} value={b.account.id}>
                        {b.account.nameAr}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div className="w-44">
              <Field label="المبلغ المدفوع">
                <Input
                  dir="ltr"
                  inputMode="decimal"
                  value={terms.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {!receipt && party && (
          <div className="w-44">
            <Field label={`قيمة الفاتورة (${CURRENCY_SYMBOL[party.currency]})`}>
              <Input
                dir="ltr"
                inputMode="decimal"
                value={terms.amount ? fromMinorUnits(terms.amount, party.currency) : ''}
                onChange={(e) =>
                  set({ amount: toMinorUnits(e.target.value, party.currency) ?? '' })
                }
              />
            </Field>
          </div>
        )}
      </div>
      {receipt && goods !== null && one && (
        <p className="text-sm text-ink-muted">
          قيمة البضاعة: <span className="tabular">{formatMoney(goods.toString(), one)}</span>
          {party && party.currency !== one && ' — المورد بعملة أخرى: اكتب التكلفة بعملته'}
        </p>
      )}
      {outliers.length > 0 && (
        <Alert tone="warn">
          <div className="font-bold">
            تكلفة بعض المقاسات بتختلف أكتر من 15% عن باقي مقاسات نفس المنتج:
          </div>
          <ul className="list-disc ps-5">
            {outliers.map((o) => (
              <li key={o}>{o}</li>
            ))}
          </ul>
          <label className="mt-2 flex items-center gap-2 font-medium">
            <input
              type="checkbox"
              checked={terms.costChecked}
              onChange={(e) => set({ costChecked: e.target.checked })}
            />
            تأكدت، التكلفة صحيحة
          </label>
        </Alert>
      )}
      <p className="text-sm text-ink-muted">
        {receipt
          ? terms.source === 'SUPPLIER'
            ? terms.paidNow
              ? 'ما دفعته ينقص من حساب المورد؛ الباقي يبقى عليك له.'
              : 'قيمة البضاعة تُكتب عليك للمورد حتى تدفعها.'
            : terms.source === 'CASH'
              ? terms.partyId
                ? 'تُسجّل عند المورد ومدفوعة.'
                : 'بدون مورد: الكاش لازم يغطي كامل البضاعة.'
              : terms.source === 'OPENING'
                ? 'بتدخل المخزون كرصيد افتتاحي، وما بتنكتب دين على حدا.'
                : terms.source === 'OWNER'
                  ? 'بتنكتب لصالح المالك (جاري المالك)، مو دين على مورد.'
                  : 'اختر مصدر البضاعة قبل التأكيد.'
          : terms.partyId
            ? 'القيمة تُكتب على الزبون.'
            : 'بدون زبون: إخراج بضاعة فقط، بدون فاتورة.'}
      </p>
    </Card>
  );
}

/**
 * تصحيح الاستلام (developer report F-02): a mistake in a confirmed receipt is put right on the
 * receipt itself — the right quantity (0 takes the line back), or part of it moved to the right
 * size — at the line's own cost. Nothing of it reaches the profit, unlike an adjustment.
 */
function CorrectReceipt({ session }: { session: ScanSession }) {
  const { data: user } = useQuery(meQuery);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const received = session.received ?? [];
  const [qty, setQty] = useState<Record<string, string>>({});
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const products = [...new Set(received.map((r) => r.variant.product.id))];
  const { data: sizes = [] } = useQuery({
    queryKey: ['variants', 'receipt-sizes', ...products],
    queryFn: async () =>
      (await Promise.all(products.map(async (productId) => api.variants({ productId })))).flat(),
    enabled: open,
  });

  const changes = received.flatMap((r) => {
    const text = qty[r.variant.id];
    const target = moveTo[r.variant.id];
    const n = text === undefined || text.trim() === '' ? r.quantity : Number(text);
    if (!Number.isInteger(n) || n < 0) return [];
    if (target)
      return n < r.quantity ? [{ variantId: r.variant.id, quantity: n, toVariantId: target }] : [];
    return n !== r.quantity ? [{ variantId: r.variant.id, quantity: n }] : [];
  });
  const correct = useMutation({
    mutationFn: async () => api.correctReceipt(session.id, { changes, reason: reason.trim() }, key),
    onSuccess: async () => {
      setKey(crypto.randomUUID());
      setQty({});
      setMoveTo({});
      setReason('');
      setOpen(false);
      toast('تم تصحيح الاستلام — بالتكلفة الأصلية وعلى نفس الحساب');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['session', session.id] }),
        queryClient.invalidateQueries({ queryKey: ['balances'] }),
      ]);
    },
  });
  if (!can(user, 'inventory.receive')) return null;
  if (!open) {
    return (
      <div className="mb-4">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          ✏️ تصحيح الاستلام (غلطة بالكمية أو المقاس)
        </Button>
      </div>
    );
  }
  return (
    <Card className="mb-4 flex flex-col gap-3">
      <h2 className="font-bold">تصحيح الاستلام</h2>
      <p className="text-sm text-ink-muted">
        اكتب الكمية الصحيحة لكل صنف (0 = ما وصل أبداً)، أو انقل الزيادة لمقاسها الصح. التصحيح بيمشي
        بتكلفة الاستلام نفسها وعلى نفس الحساب (المورد أو الرصيد الافتتاحي)، وما بيأثر على الأرباح.
        ما بيمشي إذا القطع انباعت أو انتقلت.
      </p>
      <table className="w-full">
        <thead className="text-sm text-ink-muted">
          <tr>
            <th className="p-2 text-start">الصنف</th>
            <th className="p-2 text-start">بالاستلام هلق</th>
            <th className="p-2 text-start">الكمية الصحيحة</th>
            <th className="p-2 text-start">الفرق لمقاس تاني؟</th>
          </tr>
        </thead>
        <tbody>
          {received.map((r) => (
            <tr key={r.variant.id} className="border-t border-stone">
              <td className="p-2">
                <div className="font-medium">{r.variant.product.nameAr}</div>
                <div className="text-sm text-ink-muted">{r.variant.title}</div>
              </td>
              <td className="tabular p-2 text-lg font-bold">{r.quantity}</td>
              <td className="p-2">
                <Input
                  dir="ltr"
                  inputMode="numeric"
                  className="w-24"
                  aria-label={`الكمية الصحيحة — ${r.variant.title}`}
                  value={qty[r.variant.id] ?? String(r.quantity)}
                  onChange={(e) => setQty({ ...qty, [r.variant.id]: e.target.value })}
                />
              </td>
              <td className="p-2">
                <Select
                  value={moveTo[r.variant.id] ?? ''}
                  onChange={(e) => setMoveTo({ ...moveTo, [r.variant.id]: e.target.value })}
                >
                  <option value="">— لا، ما وصل —</option>
                  {sizes
                    .filter(
                      (v) =>
                        v.product.id === r.variant.product.id &&
                        v.id !== r.variant.id &&
                        v.isActive,
                    )
                    .map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.title}
                      </option>
                    ))}
                </Select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Field label="سبب التصحيح (إلزامي)">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="خطأ إدخال بالمقاس…"
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <ConfirmButton
          disabled={changes.length === 0 || reason.trim().length < 3 || correct.isPending}
          onConfirm={() => correct.mutate()}
        >
          حفظ التصحيح
        </ConfirmButton>
        <Button
          variant="danger"
          onClick={() => {
            setMoveTo({});
            setQty(Object.fromEntries(received.map((r) => [r.variant.id, '0'])));
          }}
        >
          إلغاء الاستلام كله
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          رجوع
        </Button>
      </div>
      {correct.isError && <Alert>{errorText(correct.error)}</Alert>}
    </Card>
  );
}

function LastScanPanel({ last, pending }: { last: LastScan | null; pending: number }) {
  if (!last) {
    return <p className="text-ink-muted">بانتظار أول مسحة…</p>;
  }
  if (last.status === 'bad') {
    return (
      <div className="rounded-xl bg-bad-soft p-4 text-bad">
        <div className="text-xl font-bold">✗ {last.message}</div>
        <Code>{last.code}</Code>
      </div>
    );
  }
  const { variant, quantity } = last.line;
  return (
    <div
      className={`flex items-center justify-between rounded-xl p-4 ${last.status === 'ok' ? 'bg-ok-soft' : 'bg-warn-soft'}`}
    >
      <div className="flex items-center gap-4">
        {/* The piece in hand should look like this: a quick check before counting it. */}
        {variant.photoId && <PhotoThumb id={variant.photoId} size={96} />}
        <div>
          <div className="text-xl font-bold">{variant.product.nameAr}</div>
          <div className="text-lg">{variant.title}</div>
          <div className="tabular text-sm text-ink-muted">
            مفرق {formatRetail(variant.prices)} · جملة {formatPrice(variant.prices.wholesale)}
          </div>
          {last.status === 'dup' && (
            <div className="text-sm text-warn">مسحة مكررة — لم تُحتسب مرتين</div>
          )}
          {pending > 0 && <div className="text-sm text-ink-muted">جارٍ إرسال {pending}…</div>}
        </div>
      </div>
      <div className="text-end">
        <div className="tabular text-5xl font-bold">{formatQuantity(quantity)}</div>
        <div className="text-sm text-ink-muted">قطعة</div>
      </div>
    </div>
  );
}

function LineRow({
  sessionId,
  line,
  editable,
  costed,
  available,
  highlight,
  onChange,
  onRemoved,
}: {
  sessionId: string;
  line: ScanLine;
  editable: boolean;
  costed: boolean;
  /** Available at the source, for outgoing sessions; undefined otherwise. */
  available: number | undefined;
  highlight: boolean;
  onChange: (line: ScanLine) => void;
  onRemoved: () => Promise<unknown>;
}) {
  const [quantity, setQuantity] = useState(String(line.quantity));
  const [editingQuantity, setEditingQuantity] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationKey: lineSaveKey(sessionId),
    mutationFn: async (patch: Parameters<typeof api.setLine>[2]) =>
      api.setLine(sessionId, line.variant.id, patch),
    onSuccess: (updated) => {
      onChange(updated);
      setError(null);
    },
    onError: (e) => setError(errorText(e)),
  });

  const remove = useMutation({
    mutationFn: async () => api.removeLine(sessionId, line.variant.id),
    onSuccess: onRemoved,
  });

  const commitQuantity = () => {
    setEditingQuantity(false);
    const n = Number(quantity);
    if (Number.isInteger(n) && n >= 1 && n !== line.quantity) save.mutate({ quantity: n });
    else setQuantity(String(line.quantity));
  };

  const { variant } = line;
  return (
    <tr className={`border-t border-stone ${highlight ? 'bg-bad-soft' : ''}`}>
      <td className="p-3">
        <div className="font-medium">{variant.product.nameAr}</div>
        <div className="text-sm text-ink-muted">{variant.title}</div>
        {error && <div className="text-sm text-bad">{error}</div>}
      </td>
      <td className="p-3">
        <Code>{variant.sku}</Code>
      </td>
      <td className="p-2">
        {editable ? (
          <Input
            type="number"
            min={1}
            dir="ltr"
            className="tabular text-lg font-bold"
            value={editingQuantity ? quantity : String(line.quantity)}
            onFocus={() => {
              setQuantity(String(line.quantity));
              setEditingQuantity(true);
            }}
            onChange={(e) => setQuantity(e.target.value)}
            onBlur={commitQuantity}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        ) : (
          <span className="tabular text-lg font-bold">{formatQuantity(line.quantity)}</span>
        )}
      </td>
      {available !== undefined && (
        <td
          className={`tabular p-3 ${line.quantity > available ? 'font-bold text-bad' : 'text-ink-muted'}`}
        >
          {formatQuantity(available)}
        </td>
      )}
      {costed && (
        <td className="p-2">
          {editable ? (
            <CostEditor
              line={line}
              onSave={(unitCost) => save.mutate({ unitCost })}
              busy={save.isPending}
            />
          ) : (
            <span className="tabular">
              {line.unitCost ? formatMoney(line.unitCost.amount, line.unitCost.currency) : '—'}
            </span>
          )}
        </td>
      )}
      {editable && (
        <td className="p-2">
          <Button
            variant="ghost"
            aria-label="حذف"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            ✕
          </Button>
        </td>
      )}
    </tr>
  );
}

/**
 * Unit cost in USD, SYP or LYD (ADR-012). SYP and LYD need the rate in force (units per 1 USD):
 * it starts at the owner's rate from settings and may be changed for this delivery.
 */
function CostEditor({
  line,
  onSave,
  busy,
}: {
  line: ScanLine;
  onSave: (cost: { amount: string; currency: Currency; rateToBase: string }) => void;
  busy: boolean;
}) {
  const { data: rates = [] } = useQuery(ratesQuery);
  const saved = line.unitCost;
  const [amount, setAmount] = useState(saved ? fromMinorUnits(saved.amount, saved.currency) : '');
  const [currency, setCurrency] = useState<Currency>(saved?.currency ?? 'USD');
  const [typedRate, setRate] = useState<string | null>(
    saved && saved.currency !== 'USD' ? saved.rateToBase : null,
  );
  const ownerRate = rates.find((r) => r.currency === currency)?.rate ?? '';
  // Until a rate is typed, the owner's rate for the chosen currency is used.
  const rate = currency === 'USD' ? '1' : (typedRate ?? ownerRate);

  const minor = toMinorUnits(amount, currency);
  const rateOk = currency === 'USD' || /^\d{1,12}(\.\d{1,6})?$/.test(rate.trim());
  const dirty =
    !saved ||
    saved.amount !== minor ||
    saved.currency !== currency ||
    (currency !== 'USD' && Number(saved.rateToBase) !== Number(rate.trim()));

  const valid = minor !== null && rateOk;
  // A typed cost saves itself when focus leaves the cost fields (or on Enter): a cost that was
  // typed but never saved left "confirm" refused with "missing cost".
  const save = () => {
    if (dirty && valid && !busy && minor)
      onSave({ amount: minor, currency, rateToBase: rate.trim() });
  };

  return (
    // Inputs are full-width by design; the wrappers set their width in this compact row.
    <div
      className="flex flex-wrap items-center gap-1"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) save();
      }}
      onKeyDown={(e) => e.key === 'Enter' && save()}
    >
      <div className="w-28">
        <Input
          dir="ltr"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={CURRENCY_SYMBOL[currency]}
        />
      </div>
      <div className="w-20">
        <Select
          value={currency}
          onChange={(e) => {
            setCurrency(e.target.value as Currency);
            setRate(null);
          }}
        >
          <option value="USD">$</option>
          <option value="SYP">ل.س</option>
          <option value="LYD">د.ل</option>
          <option value="TRY">ل.ت</option>
        </Select>
      </div>
      {currency !== 'USD' && (
        <div className="w-32">
          <Input
            dir="ltr"
            aria-label="سعر الصرف"
            title={`كم ${CURRENCY_SYMBOL[currency]} مقابل 1 $`}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder={`${CURRENCY_SYMBOL[currency]} لكل 1 $`}
          />
        </div>
      )}
      {dirty && (
        <Button variant="secondary" disabled={busy || !valid} onClick={save}>
          حفظ
        </Button>
      )}
    </div>
  );
}
