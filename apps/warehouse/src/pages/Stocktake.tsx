import { Alert, Button, Card, Code, ConfirmButton, Input, PageTitle } from '@althobe/ui/components';
import { newScanId, useScanInput } from '@althobe/ui/scanner';
import { sound } from '@althobe/ui/sound';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { isTransient, sendScan } from '../scan-retry';
import { api, ApiError, type Stocktake, type StocktakeLine } from '../api';
import { errorText, formatQuantity, STOCKTAKE_STATUS } from '../format';
import { can, locationsQuery, meQuery, stocktakeQuery } from '../queries';

const route = getRouteApi('/app/stocktakes/$stocktakeId');
const countSaveKey = (id: string) => ['count-save', id];

type LastScan =
  { status: 'ok' | 'dup'; line: StocktakeLine } | { status: 'bad'; code: string; message: string };

/**
 * docs/inventory.md → Stocktake. Counting is blind: expected quantities stay hidden until review,
 * so the count cannot be nudged toward what the system says. A different person approves.
 */
export function StocktakePage() {
  const { stocktakeId } = route.useParams();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: user } = useQuery(meQuery);
  const { data: locations = [] } = useQuery(locationsQuery);
  const { data: st, error: loadError } = useQuery(stocktakeQuery(stocktakeId));

  const [last, setLast] = useState<LastScan | null>(null);
  const [pending, setPending] = useState(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const counting = st?.status === 'COUNTING';
  const savingCounts = useIsMutating({ mutationKey: countSaveKey(stocktakeId) });
  const key = stocktakeQuery(stocktakeId).queryKey;
  const replace = (next: Stocktake) => queryClient.setQueryData(key, next);

  const upsertLine = (line: StocktakeLine) =>
    queryClient.setQueryData<Stocktake>(key, (old) => {
      if (!old) return old;
      const exists = old.lines.some((l) => l.variant.id === line.variant.id);
      return {
        ...old,
        lines: exists
          ? old.lines.map((l) => (l.variant.id === line.variant.id ? line : l))
          : [...old.lines, line],
      };
    });

  const handleScan = (code: string) => {
    const scanId = newScanId();
    setPending((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        // Resent while the connection fails; the scanId makes a resend count once.
        const { result, resent } = await sendScan(async () =>
          api.scanCount(stocktakeId, code, scanId),
        );
        // A resend that finds its own first attempt already counted is not a double scan.
        const duplicate = result.duplicate && !resent;
        upsertLine(result.line);
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
  const scanner = useScanInput(handleScan, { enabled: counting });

  const review = useMutation({
    mutationFn: async (confirmUncountedAsZero: boolean) =>
      api.reviewStocktake(stocktakeId, confirmUncountedAsZero),
    onSuccess: replace,
  });
  const apply = useMutation({
    mutationFn: async () => api.applyStocktake(stocktakeId),
    onSuccess: async (result) => {
      replace(result.stocktake);
      await queryClient.invalidateQueries({ queryKey: ['balances'] });
      await queryClient.invalidateQueries({ queryKey: ['stocktakes'] });
    },
  });
  const cancel = useMutation({
    mutationFn: async () => api.cancelStocktake(stocktakeId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['stocktakes'] });
      await navigate({ to: '/stocktakes' });
    },
  });

  if (loadError) return <Alert>{errorText(loadError)}</Alert>;
  if (!st) return <p className="text-ink-muted">جارٍ التحميل…</p>;

  const locationName = locations.find((l) => l.id === st.locationId)?.nameAr ?? '';
  const showExpected = st.status === 'REVIEW' || st.status === 'APPLIED';
  const uncounted = st.lines.filter((l) => l.countedQuantity === null).length;
  const differences = st.lines.filter((l) => (l.difference ?? 0) !== 0);
  const isCreator = user?.id === st.createdById;
  const reviewNeedsConfirm =
    review.error instanceof ApiError && review.error.code === 'STOCKTAKE_UNCOUNTED_LINES';

  return (
    <>
      <PageTitle>
        جرد {locationName} — {STOCKTAKE_STATUS[st.status]}
      </PageTitle>

      {st.status === 'APPLIED' && (
        <div className="mb-4">
          <Alert tone="ok">
            اعتُمد الجرد وطُبّقت {differences.length} فروقات على المخزون.{' '}
            <Link to="/stocktakes" className="underline">
              قائمة الجرد
            </Link>
          </Alert>
        </div>
      )}
      {st.status === 'CANCELLED' && (
        <div className="mb-4">
          <Alert tone="warn">هذا الجرد ملغى ولم يؤثر على المخزون.</Alert>
        </div>
      )}

      {counting && (
        <Card className="mb-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium text-ink-muted">امسح كل قطعة موجودة فعلياً</span>
            <input
              {...scanner.inputProps}
              className="tabular min-h-14 rounded-lg border-2 border-brand bg-white px-4 text-2xl outline-none focus:ring-4 focus:ring-blush"
              placeholder="2000000000015"
            />
          </label>
          <CountPanel last={last} pending={pending} />
        </Card>
      )}

      {st.status === 'REVIEW' && st.movementsSinceSnapshot > 0 && (
        <div className="mb-4">
          <Alert tone="warn">
            حدثت {st.movementsSinceSnapshot} حركة مخزون في هذا الموقع بعد بدء الجرد. تأكد أن العد لم
            يتداخل معها قبل الاعتماد.
          </Alert>
        </div>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-3 text-start">الصنف</th>
              <th className="p-3 text-start">الباركود</th>
              {showExpected && <th className="p-3 text-start">المتوقع</th>}
              <th className="w-28 p-3 text-start">المعدود</th>
              {showExpected && <th className="p-3 text-start">الفرق</th>}
            </tr>
          </thead>
          <tbody>
            {st.lines.map((line) => (
              <CountRow
                key={line.variant.id}
                line={line}
                editable={counting}
                showExpected={showExpected}
                stocktakeId={stocktakeId}
                onSaved={replace}
              />
            ))}
            {st.lines.length === 0 && (
              <tr>
                <td colSpan={5} className="p-8 text-center text-ink-muted">
                  لا توجد أصناف بعد — ابدأ المسح
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {counting && uncounted > 0 && (
          <span className="text-ink-muted">{uncounted} صنف لم يُعدّ بعد</span>
        )}
        {st.status === 'REVIEW' && (
          <span className="font-bold">{differences.length} صنف فيه فرق</span>
        )}
        <div className="ms-auto flex flex-wrap gap-2">
          {(counting || st.status === 'REVIEW') && can(user, 'inventory.stocktake.count') && (
            <ConfirmButton
              variant="danger"
              disabled={cancel.isPending}
              onConfirm={() => cancel.mutate()}
            >
              إلغاء الجرد
            </ConfirmButton>
          )}
          {counting && reviewNeedsConfirm && (
            <Button
              variant="secondary"
              disabled={review.isPending || pending > 0 || savingCounts > 0}
              onClick={() => review.mutate(true)}
            >
              اعتبار غير المعدود صفراً والمتابعة
            </Button>
          )}
          {counting && (
            <Button
              size="lg"
              disabled={review.isPending || pending > 0 || savingCounts > 0}
              onClick={() => review.mutate(false)}
            >
              إنهاء العد والمراجعة
            </Button>
          )}
          {st.status === 'REVIEW' && can(user, 'inventory.stocktake.apply') && (
            <Button
              size="lg"
              disabled={apply.isPending || isCreator}
              title={isCreator ? 'يجب أن يعتمده شخص آخر' : undefined}
              onClick={() => apply.mutate()}
            >
              اعتماد وتطبيق الفروقات
            </Button>
          )}
        </div>
      </div>
      {st.status === 'REVIEW' && isCreator && (
        <p className="mt-2 text-sm text-ink-muted">أنشأتَ هذا الجرد، لذا يجب أن يعتمده شخص آخر.</p>
      )}
      {[review.error, apply.error, cancel.error].map(
        (error, i) =>
          error && (
            <div key={i} className="mt-3">
              <Alert tone={reviewNeedsConfirm && i === 0 ? 'warn' : 'bad'}>
                {errorText(error)}
              </Alert>
            </div>
          ),
      )}
    </>
  );
}

function CountPanel({ last, pending }: { last: LastScan | null; pending: number }) {
  if (!last) return <p className="text-ink-muted">بانتظار أول مسحة…</p>;
  if (last.status === 'bad') {
    return (
      <div className="rounded-xl bg-bad-soft p-4 text-bad">
        <div className="text-xl font-bold">✗ {last.message}</div>
        <Code>{last.code}</Code>
      </div>
    );
  }
  const { variant, countedQuantity } = last.line;
  return (
    <div
      className={`flex items-center justify-between rounded-xl p-4 ${last.status === 'ok' ? 'bg-ok-soft' : 'bg-warn-soft'}`}
    >
      <div>
        <div className="text-xl font-bold">{variant.product.nameAr}</div>
        <div className="text-lg">{variant.title}</div>
        {last.status === 'dup' && (
          <div className="text-sm text-warn">مسحة مكررة — لم تُحتسب مرتين</div>
        )}
        {pending > 0 && <div className="text-sm text-ink-muted">جارٍ إرسال {pending}…</div>}
      </div>
      <div className="text-end">
        <div className="tabular text-5xl font-bold">{formatQuantity(countedQuantity ?? 0)}</div>
        <div className="text-sm text-ink-muted">معدود</div>
      </div>
    </div>
  );
}

function CountRow({
  line,
  editable,
  showExpected,
  stocktakeId,
  onSaved,
}: {
  line: StocktakeLine;
  editable: boolean;
  showExpected: boolean;
  stocktakeId: string;
  onSaved: (next: Stocktake) => void;
}) {
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const { variant } = line;
  const diff = line.difference ?? 0;

  // Keyed so the page can tell a typed count is still saving and hold "finish" until it lands.
  const save = useMutation({
    mutationKey: countSaveKey(stocktakeId),
    mutationFn: async (n: number) => api.setCount(stocktakeId, variant.id, n),
    onSuccess: onSaved,
  });
  const error = save.error ? errorText(save.error) : null;

  const commit = () => {
    setEditing(false);
    const n = Number(value);
    if (Number.isInteger(n) && n >= 0 && n !== line.countedQuantity) save.mutate(n);
  };

  return (
    <tr className={`border-t border-stone ${showExpected && diff !== 0 ? 'bg-warn-soft' : ''}`}>
      <td className="p-3">
        <div className="font-medium">{variant.product.nameAr}</div>
        <div className="text-sm text-ink-muted">{variant.title}</div>
        {error && <div className="text-sm text-bad">{error}</div>}
      </td>
      <td className="p-3">
        <Code>{variant.barcode}</Code>
      </td>
      {showExpected && <td className="tabular p-3">{formatQuantity(line.expectedQuantity)}</td>}
      <td className="p-2">
        {editable ? (
          <Input
            type="number"
            min={0}
            dir="ltr"
            className="tabular text-lg font-bold"
            placeholder="—"
            value={
              editing ? value : line.countedQuantity === null ? '' : String(line.countedQuantity)
            }
            onFocus={() => {
              setValue(line.countedQuantity === null ? '' : String(line.countedQuantity));
              setEditing(true);
            }}
            onChange={(e) => setValue(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        ) : (
          <span className="tabular text-lg font-bold">
            {line.countedQuantity === null ? '—' : formatQuantity(line.countedQuantity)}
          </span>
        )}
      </td>
      {showExpected && (
        <td
          className={`tabular p-3 font-bold ${diff < 0 ? 'text-bad' : diff > 0 ? 'text-ok' : 'text-ink-muted'}`}
        >
          {diff > 0 ? `+${diff}` : diff}
        </td>
      )}
    </tr>
  );
}
