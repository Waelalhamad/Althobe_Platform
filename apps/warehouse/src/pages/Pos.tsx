import { Alert, Button, Card, Field, Input, PageTitle } from '@althobe/ui/components';
import { sound } from '@althobe/ui/sound';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  api,
  type CashCount,
  type DrawerCurrency,
  type Location,
  type Party,
  type PosLookup,
  type PosSale,
} from '../api';
import {
  CURRENCY_NAME,
  CURRENCY_SYMBOL,
  errorText,
  formatMoney,
  fromMinorUnits,
  toMinorUnits,
  toSypMinor,
} from '../format';
import { PAGES } from '../help';
import { PhotoThumb } from '../photo';
import { can, locationsQuery, meQuery, partiesQuery, ratesQuery } from '../queries';
import { Paper, PRINT_CSS } from './Receipt';

export const DRAWER: DrawerCurrency[] = ['SYP', 'USD', 'TRY'];

/** The store the POS runs at: today there is one (ADR-014). */
export function useStore(): Location | undefined {
  const { data: locations = [] } = useQuery(locationsQuery);
  return locations.find((l) => l.kind === 'STORE' && l.isActive);
}

export const currentShiftQuery = (locationId: string) => ({
  queryKey: ['pos', 'current', locationId],
  queryFn: async () => api.currentShift(locationId),
});

/** نقطة البيع: open the shift if none is open, then scan → pay → done, and again. */
export function PosPage() {
  const store = useStore();
  const { data: shift, isLoading } = useQuery({
    ...currentShiftQuery(store?.id ?? ''),
    enabled: Boolean(store),
  });

  if (!store) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  if (isLoading) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  if (!shift) return <OpenShift store={store} />;
  return <Register store={store} shiftId={shift.id} openedBy={shift.openedBy.nameAr} />;
}

/** Amounts typed per drawer currency → minor units; null while something does not parse. */
export function parseCounts(texts: Record<DrawerCurrency, string>): CashCount | null {
  const out: CashCount = {};
  for (const c of DRAWER) {
    if (!texts[c].trim()) continue;
    const minor = toMinorUnits(texts[c], c);
    if (minor === null) return null;
    out[c] = minor;
  }
  return out;
}

export function CashInputs({
  texts,
  onChange,
}: {
  texts: Record<DrawerCurrency, string>;
  onChange: (texts: Record<DrawerCurrency, string>) => void;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {DRAWER.map((c) => (
        <Field key={c} label={`${CURRENCY_NAME[c]} (${CURRENCY_SYMBOL[c]})`}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={texts[c]}
            placeholder="0"
            onChange={(e) => onChange({ ...texts, [c]: e.target.value })}
            className={`min-h-14 text-xl ${texts[c] && toMinorUnits(texts[c], c) === null ? 'border-bad' : ''}`}
          />
        </Field>
      ))}
    </div>
  );
}

export const EMPTY_COUNTS: Record<DrawerCurrency, string> = { SYP: '', USD: '', TRY: '' };

/**
 * فتح الوردية: starts from what the drawer held when the last shift closed, so on a normal
 * morning it is one tap; the cashier changes a number only when the drawer differs.
 */
function OpenShift({ store }: { store: Location }) {
  const queryClient = useQueryClient();
  const { data: last, isLoading } = useQuery({
    queryKey: ['pos', 'last-count', store.id],
    queryFn: async () => api.lastCount(store.id),
  });
  const [texts, setTexts] = useState<Record<DrawerCurrency, string> | null>(null);
  const fromLast = (): Record<DrawerCurrency, string> => {
    if (!last) return EMPTY_COUNTS;
    const out = { ...EMPTY_COUNTS };
    for (const c of DRAWER) {
      const v = last.counted[c] ?? '0';
      out[c] = v === '0' ? '' : fromMinorUnits(v, c);
    }
    return out;
  };
  const shown = texts ?? fromLast();
  const counts = parseCounts(shown);
  const open = useMutation({
    mutationFn: async () => api.openShift(store.id, counts!),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['pos'] }),
  });
  if (isLoading) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  return (
    <>
      <PageTitle intro={PAGES.posOpen}>فتح وردية — {store.nameAr}</PageTitle>
      <Card className="max-w-2xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (counts) open.mutate();
          }}
          className="flex flex-col gap-4"
        >
          <p className="text-lg">
            {last
              ? 'هذا ما بقي في الدرج آخر مرة. إذا هو نفسه اضغط «ابدأ البيع»، وإذا تغيّر صحّح الرقم.'
              : 'عُدّ ما في الدرج الآن واكتبه بكل عملة (اترك الفارغ صفراً).'}
          </p>
          <CashInputs texts={shown} onChange={setTexts} />
          {open.isError && <Alert>{errorText(open.error)}</Alert>}
          <div>
            <Button
              type="submit"
              size="lg"
              className="w-full sm:w-auto"
              disabled={!counts || open.isPending}
            >
              ابدأ البيع
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

interface CartLine {
  lookup: PosLookup;
  quantity: number;
}

/** Banknotes a customer hands over, one tap each (whole units). */
const NOTES: Record<Exclude<DrawerCurrency, 'SYP'>, number[]> = {
  USD: [1, 5, 10, 20, 50, 100],
  TRY: [5, 10, 20, 50, 100, 200],
};

/** Round amounts just above `total` (SYP minor units): what a customer usually hands over. */
function roundUps(total: bigint): bigint[] {
  const out = new Set<bigint>();
  for (const step of [100_00n, 500_00n, 1_000_00n, 5_000_00n]) {
    const up = ((total + step - 1n) / step) * step;
    if (up > total) out.add(up);
  }
  return [...out].sort((a, b) => (a < b ? -1 : 1)).slice(0, 3);
}

const NOTHING: Record<DrawerCurrency, bigint> = { SYP: 0n, USD: 0n, TRY: 0n };

function Register({
  store,
  shiftId,
  openedBy,
}: {
  store: Location;
  shiftId: string;
  openedBy: string;
}) {
  const { data: user } = useQuery(meQuery);
  const { data: rateList = [] } = useQuery(ratesQuery);
  const queryClient = useQueryClient();
  const scanRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [stage, setStage] = useState<'cart' | 'pay'>('cart');
  const [searching, setSearching] = useState(false);
  const [paid, setPaid] = useState(NOTHING);
  const [account, setAccount] = useState<{ party: Party; amount: bigint } | null>(null);
  const [discountText, setDiscount] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [done, setDone] = useState<PosSale | null>(null);
  const [lastSaleId, setLastSaleId] = useState<string | null>(null);
  const manager = can(user, 'retail.manage');

  const rates: Partial<Record<DrawerCurrency, string>> = { USD: '1' };
  for (const r of rateList) if (r.rate && r.currency !== 'LYD') rates[r.currency] = r.rate;

  const focusScan = () => setTimeout(() => scanRef.current?.focus(), 0);

  const lookup = useMutation({
    mutationFn: async (barcode: string) => api.posLookup(barcode, store.id),
    onSuccess: (found) => {
      if (found.price === null) {
        sound.bad();
        setScanError(
          `«${found.variant.product.nameAr} ${found.variant.title}» ما إلها سعر — اطلب من المدير يحط سعرها`,
        );
        return;
      }
      sound.ok();
      setScanError(null);
      setLastAdded(found.variant.id);
      setCart((lines) => {
        const at = lines.findIndex((l) => l.lookup.variant.id === found.variant.id);
        if (at === -1) return [...lines, { lookup: found, quantity: 1 }];
        return lines.map((l, i) => (i === at ? { ...l, quantity: l.quantity + 1 } : l));
      });
    },
    onError: (error) => {
      sound.bad();
      setScanError(errorText(error));
    },
  });

  const subtotal = cart.reduce((s, l) => s + BigInt(l.lookup.price!) * BigInt(l.quantity), 0n);
  const discount = manager && discountText ? toMinorUnits(discountText, 'SYP') : '0';
  const total = discount === null ? null : subtotal - BigInt(discount);
  const paidSyp = DRAWER.reduce<bigint | null>((s, c) => {
    const v = paid[c] === 0n ? 0n : toSypMinor(paid[c], c, rates);
    return s === null || v === null ? null : s + v;
  }, 0n);
  const onAccount = account?.amount ?? 0n;
  const remaining = total !== null && paidSyp !== null ? total - paidSyp - onAccount : null;
  const pieces = cart.reduce((s, l) => s + l.quantity, 0);
  const overStock = cart.some(
    (l) => l.lookup.available !== null && l.quantity > l.lookup.available,
  );
  const canPay = cart.length > 0 && total !== null && total > 0n && !overStock;
  const ready =
    canPay &&
    remaining !== null &&
    remaining <= 0n &&
    (DRAWER.some((c) => paid[c] > 0n) || onAccount > 0n) &&
    // Change comes from cash; nothing is given back out of what goes on account.
    -remaining <= (paidSyp ?? 0n);

  const reset = () => {
    setCart([]);
    setStage('cart');
    setPaid(NOTHING);
    setAccount(null);
    setDiscount('');
    setScanError(null);
    setLastAdded(null);
    setKey(crypto.randomUUID());
    focusScan();
  };

  const sell = useMutation({
    mutationFn: async (money: Record<DrawerCurrency, bigint>) =>
      api.sell(
        {
          shiftId,
          lines: cart.map((l) => ({ variantId: l.lookup.variant.id, quantity: l.quantity })),
          ...(discount && discount !== '0' ? { discount } : {}),
          payments: DRAWER.filter((c) => money[c] > 0n).map((c) => ({
            currency: c,
            amount: money[c].toString(),
          })),
          ...(account && account.amount > 0n
            ? { account: { partyId: account.party.id, amount: account.amount.toString() } }
            : {}),
        },
        key,
      ),
    onSuccess: (sale) => {
      sound.ok();
      setDone(sale);
      setLastSaleId(sale.id);
      reset();
      void queryClient.invalidateQueries({ queryKey: ['pos'] });
    },
    onError: () => sound.bad(),
  });

  /** كاش ليرة — كامل: the rest of the total in pounds, and the sale goes through at once. */
  const payExactSyp = () => {
    if (!canPay || remaining === null || remaining <= 0n || sell.isPending) return;
    const money = { ...paid, SYP: paid.SYP + remaining };
    setPaid(money);
    sell.mutate(money);
  };
  const finish = () => {
    if (ready && !sell.isPending) sell.mutate(paid);
  };

  // The receipt prints by itself; the screen underneath is already empty for the next customer.
  useEffect(() => {
    if (!done) return;
    const print = setTimeout(() => window.print(), 300);
    const close = setTimeout(() => setDone(null), 8000);
    return () => {
      clearTimeout(print);
      clearTimeout(close);
    };
  }, [done]);

  // Keys for a PC: F2 search, F4 exact pounds, Enter pays or finishes, Esc goes back.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (done) {
        // The next customer's first scan closes the message and still counts in full.
        setDone(null);
        if (e.key.length === 1) {
          e.preventDefault();
          setCode((c) => c + e.key);
        }
        scanRef.current?.focus();
        return;
      }
      if (e.key === 'F2') {
        e.preventDefault();
        setSearching(true);
      } else if (e.key === 'F4') {
        e.preventDefault();
        payExactSyp();
      } else if (e.key === 'Escape') {
        if (searching) setSearching(false);
        else if (stage === 'pay') setStage('cart');
        focusScan();
      } else if (e.key === 'Enter' && stage === 'pay') {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const scan = (e: FormEvent) => {
    e.preventDefault();
    const barcode = code.trim();
    setCode('');
    if (barcode) lookup.mutate(barcode);
    else if (canPay) setStage('pay');
    focusScan();
  };

  const setQuantity = (variantId: string, quantity: number) =>
    setCart((lines) =>
      quantity <= 0
        ? lines.filter((l) => l.lookup.variant.id !== variantId)
        : lines.map((l) => (l.lookup.variant.id === variantId ? { ...l, quantity } : l)),
    );

  return (
    <>
      <style>{PRINT_CSS}</style>
      {done && (
        <div className="hidden print:block">
          <Paper sale={done} storeName={store.nameAr} />
        </div>
      )}
      <div className="print:hidden">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-bold">نقطة البيع</h1>
          <span className="text-sm text-ink-muted">
            {store.nameAr} · وردية {openedBy}
          </span>
          <div className="ms-auto flex flex-wrap gap-2">
            {lastSaleId && (
              <Link
                to="/pos/receipts/$saleId"
                params={{ saleId: lastSaleId }}
                search={{ print: false }}
              >
                <Button variant="ghost">آخر فاتورة</Button>
              </Link>
            )}
            <Link to="/pos/shifts/$shiftId" params={{ shiftId }}>
              <Button variant="secondary">فواتير الوردية · إغلاق الوردية</Button>
            </Link>
          </div>
        </div>

        {stage === 'cart' ? (
          <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
            <div className="flex flex-col gap-3">
              <form onSubmit={scan} className="flex gap-2">
                <Input
                  ref={scanRef}
                  autoFocus
                  dir="ltr"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  onBlur={() => {
                    // Back to the scanner after a tap on empty space.
                    setTimeout(() => {
                      if (document.activeElement === document.body) scanRef.current?.focus();
                    }, 200);
                  }}
                  placeholder="امسح الباركود…"
                  className="min-h-16 text-2xl"
                  aria-label="الباركود"
                />
                <Button
                  size="lg"
                  variant="secondary"
                  className="whitespace-nowrap"
                  onClick={() => setSearching(true)}
                >
                  🔍 بحث <Kbd>F2</Kbd>
                </Button>
              </form>
              {scanError && (
                <div className="rounded-xl bg-bad-soft px-4 py-3 text-lg font-bold text-bad">
                  {scanError}
                </div>
              )}
              {cart.length === 0 ? (
                <div className="flex min-h-60 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-mauve bg-white p-8 text-center">
                  <div className="text-xl font-bold">امسح أول قطعة</div>
                  <div className="text-ink-muted">أو اضغط «بحث» واكتب اسمها أو مقاسها</div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {cart.map((l) => (
                    <CartRow
                      key={l.lookup.variant.id}
                      line={l}
                      fresh={l.lookup.variant.id === lastAdded}
                      onQuantity={(q) => setQuantity(l.lookup.variant.id, q)}
                    />
                  ))}
                </div>
              )}
            </div>

            <Card className="flex flex-col gap-3 self-start lg:sticky lg:top-4">
              <div className="text-ink-muted">{pieces} قطعة · المطلوب</div>
              <div className="tabular text-5xl font-bold">
                {total === null ? '—' : formatMoney(total.toString(), 'SYP')}
              </div>
              {manager && <DiscountField value={discountText} onChange={setDiscount} />}
              {overStock && (
                <p className="font-bold text-bad">في قطعة أكتر من الموجود بالمتجر — عدّل العدد</p>
              )}
              <Button
                size="lg"
                className="min-h-20 text-2xl"
                disabled={!canPay}
                onClick={() => setStage('pay')}
              >
                ادفع <Kbd light>Enter</Kbd>
              </Button>
              <Button
                size="lg"
                variant="secondary"
                disabled={!canPay || sell.isPending}
                onClick={payExactSyp}
              >
                كاش ليرة — المبلغ كامل <Kbd>F4</Kbd>
              </Button>
              {cart.length > 0 && (
                <Button variant="ghost" onClick={reset}>
                  إلغاء الفاتورة
                </Button>
              )}
              {sell.isError && <Alert>{errorText(sell.error)}</Alert>}
            </Card>
          </div>
        ) : (
          <PayStage
            total={total ?? 0n}
            paid={paid}
            setPaid={setPaid}
            rates={rates}
            remaining={remaining}
            account={account}
            setAccount={setAccount}
            ready={ready}
            busy={sell.isPending}
            error={sell.isError ? errorText(sell.error) : null}
            onBack={() => {
              setStage('cart');
              focusScan();
            }}
            onExact={payExactSyp}
            onDone={finish}
          />
        )}
      </div>

      {searching && (
        <SearchPanel
          onPick={(barcode) => {
            setSearching(false);
            lookup.mutate(barcode);
            focusScan();
          }}
          onClose={() => {
            setSearching(false);
            focusScan();
          }}
        />
      )}

      {done && (
        <button
          type="button"
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 bg-ok p-6 text-white print:hidden"
          onClick={() => {
            setDone(null);
            focusScan();
          }}
        >
          <div className="text-6xl" aria-hidden>
            ✓
          </div>
          <div className="text-3xl font-bold">
            تم البيع — فاتورة {done.receiptYear}/{done.receiptNo}
          </div>
          <div className="tabular text-5xl font-bold">
            {done.change !== '0'
              ? `الباقي للزبون: ${formatMoney(done.change, 'SYP')}`
              : 'ما في باقي'}
          </div>
          {done.onAccount !== '0' && (
            <div className="text-2xl">
              على حساب {done.party?.nameAr}: {formatMoney(done.onAccount, 'SYP')}
            </div>
          )}
          <div className="mt-4 rounded-xl bg-white px-8 py-4 text-2xl font-bold text-ok">
            زبون جديد
          </div>
        </button>
      )}
    </>
  );
}

function Kbd({ children, light }: { children: ReactNode; light?: boolean }) {
  return (
    <kbd
      className={`hidden rounded border px-1 text-xs font-normal md:inline ${light ? 'border-white/50 text-white/80' : 'border-stone text-ink-muted'}`}
    >
      {children}
    </kbd>
  );
}

/** One piece in the cart: big enough for a finger, with − / + and its line total. */
function CartRow({
  line: l,
  fresh,
  onQuantity,
}: {
  line: CartLine;
  fresh: boolean;
  onQuantity: (q: number) => void;
}) {
  const short = l.lookup.available !== null && l.quantity > l.lookup.available;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-xl border-2 bg-white p-3 ${short ? 'border-bad' : fresh ? 'border-ok' : 'border-stone'}`}
    >
      <PhotoThumb id={l.lookup.variant.photoId} size={56} />
      <div className="min-w-40 flex-1">
        <div className="text-lg font-bold">{l.lookup.variant.product.nameAr}</div>
        <div className="text-ink-muted">{l.lookup.variant.title}</div>
        {short && <div className="font-bold text-bad">بالمتجر {l.lookup.available} بس</div>}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="lg"
          className="min-w-14 text-2xl"
          aria-label={l.quantity === 1 ? 'احذف' : 'أنقص'}
          onClick={() => onQuantity(l.quantity - 1)}
        >
          {l.quantity === 1 ? '🗑' : '−'}
        </Button>
        <span className="tabular w-10 text-center text-2xl font-bold">{l.quantity}</span>
        <Button
          variant="secondary"
          size="lg"
          className="min-w-14 text-2xl"
          aria-label="زد"
          onClick={() => onQuantity(l.quantity + 1)}
        >
          +
        </Button>
      </div>
      <div className="tabular w-32 text-end text-xl font-bold">
        {formatMoney((BigInt(l.lookup.price!) * BigInt(l.quantity)).toString(), 'SYP')}
      </div>
    </div>
  );
}

function DiscountField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(value !== '');
  if (!open) {
    return (
      <button type="button" className="self-start text-sm text-brand" onClick={() => setOpen(true)}>
        + خصم (للمدير)
      </button>
    );
  }
  return (
    <Field label="خصم على الفاتورة (ل.س)">
      <Input
        dir="ltr"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

/**
 * الدفع: tap what the customer hands over — the exact pounds, a round amount, banknotes, or a
 * typed amount on the big keypad — and what is left, or the change, shows in large figures.
 */
function PayStage({
  total,
  paid,
  setPaid,
  rates,
  remaining,
  account,
  setAccount,
  ready,
  busy,
  error,
  onBack,
  onExact,
  onDone,
}: {
  total: bigint;
  paid: Record<DrawerCurrency, bigint>;
  setPaid: (p: Record<DrawerCurrency, bigint>) => void;
  rates: Partial<Record<DrawerCurrency, string>>;
  remaining: bigint | null;
  account: { party: Party; amount: bigint } | null;
  setAccount: (a: { party: Party; amount: bigint } | null) => void;
  ready: boolean;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onExact: () => void;
  onDone: () => void;
}) {
  const [currency, setCurrency] = useState<DrawerCurrency>('SYP');
  const [typed, setTyped] = useState('');
  const [choosing, setChoosing] = useState(false);
  const owed = remaining ?? 0n;
  const typedMinor = typed ? toMinorUnits(typed, currency) : null;
  const add = (c: DrawerCurrency, minor: bigint) => setPaid({ ...paid, [c]: paid[c] + minor });
  const nothingYet = DRAWER.every((c) => paid[c] === 0n) && !account;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" size="lg" onClick={onBack}>
            → رجوع للفاتورة <Kbd>Esc</Kbd>
          </Button>
          <div className="text-xl">
            المطلوب{' '}
            <span className="tabular font-bold">{formatMoney(total.toString(), 'SYP')}</span>
          </div>
        </div>

        <Button
          size="lg"
          className="min-h-20 text-2xl"
          disabled={owed <= 0n || busy}
          onClick={onExact}
        >
          ✓ كاش ليرة — المبلغ كامل <Kbd light>F4</Kbd>
        </Button>

        <Card>
          <div className="mb-2 font-bold">الزبون عطاك ليرة:</div>
          <div className="grid grid-cols-3 gap-2">
            {roundUps(paid.SYP + (owed > 0n ? owed : 0n)).map((v) => (
              <QuickButton key={v.toString()} onClick={() => setPaid({ ...paid, SYP: v })}>
                {formatMoney(v.toString(), 'SYP')}
              </QuickButton>
            ))}
          </div>
        </Card>

        {(['USD', 'TRY'] as const).map((c) =>
          rates[c] ? (
            <Card key={c}>
              <div className="mb-2 font-bold">
                {CURRENCY_NAME[c]} — كل كبسة ورقة{' '}
                <span className="text-sm font-normal text-ink-muted">
                  (1 {CURRENCY_SYMBOL[c]} ={' '}
                  {formatMoney((toSypMinor(100n, c, rates) ?? 0n).toString(), 'SYP')})
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                {NOTES[c].map((n) => (
                  <QuickButton key={n} onClick={() => add(c, BigInt(n) * 100n)}>
                    {n} {CURRENCY_SYMBOL[c]}
                  </QuickButton>
                ))}
              </div>
            </Card>
          ) : null,
        )}

        <Card>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="font-bold">مبلغ تاني:</span>
            {DRAWER.filter((c) => c === 'SYP' || rates[c]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setCurrency(c);
                  setTyped('');
                }}
                className={`min-h-12 rounded-full border px-4 font-bold ${currency === c ? 'border-brand bg-brand text-white' : 'border-stone bg-white'}`}
              >
                {CURRENCY_NAME[c]}
              </button>
            ))}
          </div>
          <div
            className="tabular mb-2 min-h-14 rounded-lg border-2 border-stone bg-white px-4 py-2 text-end text-3xl font-bold"
            dir="ltr"
          >
            {typed || '0'} {CURRENCY_SYMBOL[currency]}
          </div>
          <Keypad
            onKey={(k) =>
              setTyped((t) => {
                if (k === '⌫') return t.slice(0, -1);
                if (k === '.' && t.includes('.')) return t;
                return (t + k).slice(0, 12);
              })
            }
          />
          <Button
            size="lg"
            className="mt-2 w-full"
            disabled={!typedMinor || typedMinor === '0'}
            onClick={() => {
              add(currency, BigInt(typedMinor!));
              setTyped('');
            }}
          >
            أضف {typed ? `${typed} ${CURRENCY_SYMBOL[currency]}` : ''}
          </Button>
        </Card>
      </div>

      <Card className="flex flex-col gap-3 self-start lg:sticky lg:top-4">
        <div className="font-bold">المدفوع</div>
        {DRAWER.filter((c) => paid[c] > 0n).map((c) => (
          <div key={c} className="flex items-center justify-between gap-2 text-lg">
            <span className="tabular font-bold">{formatMoney(paid[c].toString(), c)}</span>
            <button
              type="button"
              className="min-h-10 rounded-lg px-3 text-bad"
              aria-label={`امسح ${CURRENCY_NAME[c]}`}
              onClick={() => setPaid({ ...paid, [c]: 0n })}
            >
              ✕
            </button>
          </div>
        ))}
        {account && (
          <div className="flex items-center justify-between gap-2 text-lg">
            <span>
              على حساب {account.party.nameAr}:{' '}
              <span className="tabular font-bold">
                {formatMoney(account.amount.toString(), 'SYP')}
              </span>
            </span>
            <button
              type="button"
              className="min-h-10 rounded-lg px-3 text-bad"
              aria-label="امسح على الحساب"
              onClick={() => setAccount(null)}
            >
              ✕
            </button>
          </div>
        )}
        {nothingYet && <div className="text-ink-muted">لسا ما في شي</div>}

        <div
          className={`rounded-xl px-4 py-4 text-center ${remaining === null ? '' : remaining > 0n ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok'}`}
        >
          {remaining === null ? (
            <span>لا يوجد سعر صرف</span>
          ) : remaining > 0n ? (
            <>
              <div>ينقص</div>
              <div className="tabular text-4xl font-bold">
                {formatMoney(remaining.toString(), 'SYP')}
              </div>
            </>
          ) : (
            <>
              <div>الباقي للزبون</div>
              <div className="tabular text-4xl font-bold">
                {formatMoney((-remaining).toString(), 'SYP')}
              </div>
            </>
          )}
        </div>

        <Button size="lg" className="min-h-20 text-2xl" disabled={!ready || busy} onClick={onDone}>
          ✓ تم — اطبع <Kbd light>Enter</Kbd>
        </Button>

        {!account &&
          (choosing ? (
            <CustomerPicker
              onPick={(party) => {
                setAccount({ party, amount: owed > 0n ? owed : 0n });
                setChoosing(false);
              }}
              onClose={() => setChoosing(false)}
            />
          ) : (
            <Button
              variant="secondary"
              size="lg"
              disabled={owed <= 0n}
              onClick={() => setChoosing(true)}
            >
              الباقي على حساب زبون…
            </Button>
          ))}
        {error && <Alert>{error}</Alert>}
      </Card>
    </div>
  );
}

function QuickButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="tabular min-h-16 rounded-xl border-2 border-stone bg-white px-2 text-xl font-bold hover:border-brand active:bg-blush"
    >
      {children}
    </button>
  );
}

/** A finger-sized number pad for the tablet; the keyboard works as well. */
function Keypad({ onKey }: { onKey: (k: string) => void }) {
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '.', '0', '⌫'];
  return (
    <div className="grid grid-cols-3 gap-2" dir="ltr">
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onKey(k)}
          className="min-h-14 rounded-xl border border-stone bg-white text-2xl font-bold active:bg-blush"
        >
          {k}
        </button>
      ))}
    </div>
  );
}

/** على الحساب: find a known customer by name; only those kept in pounds go on account here. */
function CustomerPicker({ onPick, onClose }: { onPick: (p: Party) => void; onClose: () => void }) {
  const { data: customers = [] } = useQuery(partiesQuery('CUSTOMER'));
  const [q, setQ] = useState('');
  const list = customers
    .filter((c) => c.currency === 'SYP' && c.nameAr.includes(q.trim()))
    .slice(0, 8);
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-stone p-2">
      <Input autoFocus value={q} placeholder="اسم الزبون…" onChange={(e) => setQ(e.target.value)} />
      {list.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onPick(c)}
          className="min-h-12 rounded-lg bg-white px-3 text-start text-lg font-medium hover:bg-blush"
        >
          {c.nameAr}
        </button>
      ))}
      {list.length === 0 && (
        <p className="text-sm text-ink-muted">
          ما في زبون بهالاسم — المدير بيضيفه من «الموردون والزبائن».
        </p>
      )}
      <Button variant="ghost" onClick={onClose}>
        إلغاء
      </Button>
    </div>
  );
}

/** بحث بالاسم: when a label is missing or the scanner will not read it. */
function SearchPanel({
  onPick,
  onClose,
}: {
  onPick: (barcode: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const term = q.trim();
  const { data: results = [], isFetching } = useQuery({
    queryKey: ['pos', 'search', term],
    queryFn: async () => api.variants({ q: term }),
    enabled: term.length >= 2,
  });
  const shown = results.filter((v) => v.isActive).slice(0, 24);
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-surface p-4 print:hidden">
      <div className="mb-3 flex gap-2">
        <Input
          autoFocus
          value={q}
          placeholder="اكتب الاسم أو القماش أو اللون أو المقاس… مثل: قطني أسود 54"
          onChange={(e) => setQ(e.target.value)}
          className="min-h-16 text-2xl"
          aria-label="بحث"
        />
        <Button size="lg" variant="secondary" onClick={onClose}>
          إغلاق <Kbd>Esc</Kbd>
        </Button>
      </div>
      {term.length < 2 && <p className="text-lg text-ink-muted">اكتب حرفين على الأقل.</p>}
      {term.length >= 2 && !isFetching && shown.length === 0 && (
        <p className="text-lg text-ink-muted">ما لقيت شي بهالاسم.</p>
      )}
      <div className="grid gap-3 overflow-y-auto sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => onPick(v.barcode)}
            // Without a price it cannot be sold: shown, so the cashier knows why, but not picked.
            disabled={!v.prices.retailSyp}
            className="flex items-center gap-3 rounded-xl border-2 border-stone bg-white p-3 text-start hover:border-brand disabled:opacity-50"
          >
            <PhotoThumb id={v.photoId} size={64} />
            <div className="flex-1">
              <div className="text-lg font-bold">{v.product.nameAr}</div>
              <div className="text-ink-muted">{v.title}</div>
              <div className="tabular font-bold">
                {v.prices.retailSyp ? formatMoney(v.prices.retailSyp.amount, 'SYP') : 'بدون سعر'}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
