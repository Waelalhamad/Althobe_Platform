import {
  Alert,
  Button,
  Card,
  Chip,
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
import { api, ApiError, type Currency, type ScanLine, type ScanSession } from '../api';
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
 * The terms a receipt or goods out is confirmed with (ADR-016): from which supplier, and what
 * was paid on the spot; or to which wholesale customer, at what agreed total. None: as before.
 */
interface Terms {
  partyId: string;
  /** Paid in cash at the receipt. */
  cash: boolean;
  boxId: string;
  /** Box currency (a receipt's cash) or the customer's (goods out). */
  amount: string;
}
const NO_TERMS: Terms = { partyId: '', cash: false, boxId: '', amount: '' };

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
    enabled: Boolean(open && session?.kind === 'RECEIVE' && terms.cash),
  });
  const termsCurrency: Currency | null =
    session?.kind === 'RECEIVE'
      ? (boxes.find((b) => b.account.id === terms.boxId)?.account.currency ?? null)
      : null;
  const commit = useMutation({
    mutationFn: async () => {
      if (session?.kind === 'RECEIVE' && (terms.partyId || terms.cash)) {
        const paid =
          terms.cash && termsCurrency
            ? { boxId: terms.boxId, amount: toMinorUnits(terms.amount, termsCurrency)! }
            : undefined;
        return api.commitReceipt(sessionId, {
          ...(terms.partyId ? { partyId: terms.partyId } : {}),
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
                !termsReady(session.kind, terms, termsCurrency)
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

/** Terms can be sent: a cash payment needs its box and amount; goods out on account its total. */
function termsReady(kind: string, t: Terms, cashCurrency: Currency | null): boolean {
  if (kind === 'RECEIVE' && t.cash) {
    return Boolean(t.boxId && cashCurrency && toMinorUnits(t.amount, cashCurrency));
  }
  if (kind === 'SALE' && t.partyId) return /^\d+$/.test(t.amount) && t.amount !== '0';
  return true;
}

/**
 * From whom the goods came and whether they were paid in cash (a receipt), or to which
 * wholesale customer they went and at what total (goods out). Optional: with nothing chosen the
 * session is confirmed as before.
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
  const { data: boxes = [] } = useQuery({ ...boxesQuery, enabled: receipt && terms.cash });
  const set = (patch: Partial<Terms>) => onChange({ ...terms, ...patch });
  const party = parties.find((p) => p.id === terms.partyId);
  // What the goods cost, when every line is costed in one currency.
  const costs = session.lines.map((l) => l.unitCost);
  const one =
    costs.length > 0 && costs.every((c) => c && c.currency === costs[0]?.currency)
      ? costs[0]!.currency
      : null;
  const goods = one
    ? session.lines.reduce((s, l) => s + BigInt(l.unitCost!.amount) * BigInt(l.quantity), 0n)
    : null;
  // Goods out on account is a sale with money in it: only whoever keeps the accounts.
  if (!receipt && !manage) return null;
  if (parties.length === 0 && !(receipt && manage)) return null;

  const customerAmount = party ? (toMinorUnits(terms.amount, party.currency) ?? '') : '';
  return (
    <Card className="mt-4 flex flex-col gap-3">
      <h2 className="font-bold">{receipt ? 'من أي مورد؟' : 'لتاجر جملة على الحساب؟'}</h2>
      <div className="flex flex-wrap items-end gap-3">
        {parties.length > 0 && (
          <div className="w-64">
            <Field label={receipt ? 'المورد' : 'الزبون'}>
              <Select
                value={terms.partyId}
                onChange={(e) => onChange({ ...terms, partyId: e.target.value, amount: '' })}
              >
                <option value="">{receipt ? '— بدون مورد —' : '— بدون فاتورة —'}</option>
                {parties.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nameAr} ({CURRENCY_SYMBOL[p.currency]})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {receipt && manage && (
          <div className="flex gap-2">
            <Chip selected={!terms.cash} onClick={() => set({ cash: false })}>
              بالدين
            </Chip>
            <Chip selected={terms.cash} onClick={() => set({ cash: true })}>
              دفعت كاش
            </Chip>
          </div>
        )}
        {receipt && terms.cash && (
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
      <p className="text-sm text-ink-muted">
        {receipt
          ? terms.cash
            ? terms.partyId
              ? 'ما دفعته ينقص من حساب المورد؛ الباقي يبقى عليك له.'
              : 'بدون مورد: الكاش لازم يغطي كامل البضاعة.'
            : terms.partyId
              ? 'قيمة البضاعة تُكتب عليك للمورد حتى تدفعها.'
              : 'بدون مورد: تُسجَّل كبضاعة مستلمة بدون مورد.'
          : terms.partyId
            ? `القيمة تُكتب على الزبون${customerAmount ? '' : ' — اكتبها أولاً'}.`
            : 'بدون زبون: إخراج بضاعة فقط، بدون فاتورة.'}
      </p>
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
