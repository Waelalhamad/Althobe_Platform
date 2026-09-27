import {
  Alert,
  Button,
  Card,
  Code,
  ConfirmButton,
  Input,
  PageTitle,
  Select,
} from '@althobe/ui/components';
import { newScanId, useScanInput } from '@althobe/ui/scanner';
import { sound } from '@althobe/ui/sound';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { api, ApiError, type Currency, type ScanLine, type ScanSession } from '../api';
import {
  errorText,
  formatMoney,
  formatQuantity,
  fromMinorUnits,
  SESSION_KIND,
  toMinorUnits,
} from '../format';
import { balancesQuery, locationsQuery, sessionQuery } from '../queries';

const route = getRouteApi('/app/sessions/$sessionId');
// Keyed so the page can hold "confirm" while a typed quantity or cost is still saving.
const lineSaveKey = (id: string) => ['line-save', id];

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
  const outgoing = session?.kind === 'TRANSFER' || session?.kind === 'DAMAGE';
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
        const result = await api.scan(sessionId, code, scanId);
        updateLine(result.line);
        if (result.duplicate) sound.dup();
        else sound.ok();
        setLast({ status: result.duplicate ? 'dup' : 'ok', line: result.line });
      } catch (error) {
        sound.bad();
        setLast({ status: 'bad', code, message: errorText(error) });
      } finally {
        setPending((n) => n - 1);
      }
    });
  };

  const scanner = useScanInput(handleScan, { enabled: open });

  const commit = useMutation({
    mutationFn: async () => api.commit(sessionId),
    onSuccess: async () => {
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
      await navigate({ to: '/' });
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

      {session.status === 'COMMITTED' && (
        <div className="mb-4">
          <Alert tone="ok">
            تم الحفظ في المخزون: {formatQuantity(session.totalQuantity)} قطعة في{' '}
            {session.lines.length} صنف.{' '}
            <Link to="/" className="underline">
              العودة للرئيسية
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
                  ابدأ المسح — كل مسحة تضيف قطعة واحدة
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

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
                overScanned.length > 0
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
      <div>
        <div className="text-xl font-bold">{variant.product.nameAr}</div>
        <div className="text-lg">
          {variant.fabric} · {variant.colour} · مقاس {variant.size}
        </div>
        {last.status === 'dup' && (
          <div className="text-sm text-warn">مسحة مكررة — لم تُحتسب مرتين</div>
        )}
        {pending > 0 && <div className="text-sm text-ink-muted">جارٍ إرسال {pending}…</div>}
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
        <div className="text-sm text-ink-muted">
          {variant.fabric} · {variant.colour} · مقاس {variant.size}
        </div>
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

/** Unit cost in SYP or USD; USD needs the exchange rate in force (ADR-004). */
function CostEditor({
  line,
  onSave,
  busy,
}: {
  line: ScanLine;
  onSave: (cost: { amount: string; currency: Currency; rateToBase: string }) => void;
  busy: boolean;
}) {
  const saved = line.unitCost;
  const [amount, setAmount] = useState(saved ? fromMinorUnits(saved.amount) : '');
  const [currency, setCurrency] = useState<Currency>(saved?.currency ?? 'SYP');
  const [rate, setRate] = useState(saved && saved.currency === 'USD' ? saved.rateToBase : '');

  const minor = toMinorUnits(amount);
  const rateOk = currency === 'SYP' || /^\d{1,12}(\.\d{1,6})?$/.test(rate.trim());
  const dirty =
    !saved ||
    saved.amount !== minor ||
    saved.currency !== currency ||
    (currency === 'USD' && saved.rateToBase !== rate.trim());

  return (
    // Inputs are full-width by design; the wrappers set their width in this compact row.
    <div className="flex flex-wrap items-center gap-1">
      <div className="w-28">
        <Input
          dir="ltr"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="250000"
        />
      </div>
      <div className="w-20">
        <Select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
          <option value="SYP">ل.س</option>
          <option value="USD">$</option>
        </Select>
      </div>
      {currency === 'USD' && (
        <div className="w-28">
          <Input
            dir="ltr"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="سعر الصرف"
          />
        </div>
      )}
      {dirty && (
        <Button
          variant="secondary"
          disabled={busy || minor === null || !rateOk}
          onClick={() =>
            minor &&
            onSave({ amount: minor, currency, rateToBase: currency === 'SYP' ? '1' : rate.trim() })
          }
        >
          حفظ
        </Button>
      )}
    </div>
  );
}
