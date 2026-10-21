import { Alert, Button, Card, Field, Input, PageTitle, useToast } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useRef, useState, type FormEvent } from 'react';
import { api, type CashCount, type DrawerCurrency, type Location, type PosLookup } from '../api';
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
import { can, locationsQuery, meQuery, partiesQuery, ratesQuery } from '../queries';

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

/** نقطة البيع: open the shift if none is open, then scan, take the money, print. */
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
            className={texts[c] && toMinorUnits(texts[c], c) === null ? 'border-bad' : ''}
          />
        </Field>
      ))}
    </div>
  );
}

export const EMPTY_COUNTS: Record<DrawerCurrency, string> = { SYP: '', USD: '', TRY: '' };

function OpenShift({ store }: { store: Location }) {
  const queryClient = useQueryClient();
  const [texts, setTexts] = useState(EMPTY_COUNTS);
  const counts = parseCounts(texts);
  const open = useMutation({
    mutationFn: async () => api.openShift(store.id, counts!),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: ['pos'] }),
  });
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
          <p className="text-ink-muted">
            عُدّ ما في الدرج الآن واكتبه بكل عملة (اترك الفارغ صفراً).
          </p>
          <CashInputs texts={texts} onChange={setTexts} />
          {open.isError && <Alert>{errorText(open.error)}</Alert>}
          <div>
            <Button type="submit" size="lg" disabled={!counts || open.isPending}>
              فتح الوردية والبدء بالبيع
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
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const scanRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [paid, setPaid] = useState(EMPTY_COUNTS);
  const [discountText, setDiscount] = useState('');
  // على الحساب (ADR-016): a known customer owes part or all of it instead of paying now.
  const [customerId, setCustomerId] = useState('');
  const [accountText, setAccountText] = useState('');
  const { data: customers = [] } = useQuery(partiesQuery('CUSTOMER'));
  const tillCustomers = customers.filter((c) => c.currency === 'SYP');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const manager = can(user, 'retail.manage');

  const rates: Partial<Record<DrawerCurrency, string>> = { USD: '1' };
  for (const r of rateList) if (r.rate && r.currency !== 'LYD') rates[r.currency] = r.rate;

  const lookup = useMutation({
    mutationFn: async (barcode: string) => api.posLookup(barcode, store.id),
    onSuccess: (found) => {
      setScanError(null);
      if (found.price === null) {
        setScanError(
          `«${found.variant.product.nameAr} ${found.variant.title}» ليس لها سعر مفرق — لا تُباع حتى يضع المدير سعرها`,
        );
        return;
      }
      setCart((lines) => {
        const at = lines.findIndex((l) => l.lookup.variant.id === found.variant.id);
        if (at === -1) return [...lines, { lookup: found, quantity: 1 }];
        return lines.map((l, i) => (i === at ? { ...l, quantity: l.quantity + 1 } : l));
      });
    },
    onError: (error) => setScanError(errorText(error)),
  });

  const scan = (e: FormEvent) => {
    e.preventDefault();
    const barcode = code.trim();
    setCode('');
    if (barcode) lookup.mutate(barcode);
    scanRef.current?.focus();
  };

  const subtotal = cart.reduce((s, l) => s + BigInt(l.lookup.price!) * BigInt(l.quantity), 0n);
  const discount = manager && discountText ? (toMinorUnits(discountText, 'SYP') ?? null) : '0';
  const total = discount === null ? null : subtotal - BigInt(discount);
  const payments = DRAWER.flatMap((c) => {
    const minor = paid[c].trim() ? toMinorUnits(paid[c], c) : null;
    return minor && minor !== '0' ? [{ currency: c, amount: minor }] : [];
  });
  const paymentsValid = DRAWER.every((c) => !paid[c].trim() || toMinorUnits(paid[c], c) !== null);
  const valueOf = (c: DrawerCurrency, minor: string) => toSypMinor(BigInt(minor), c, rates);
  const paidSyp = payments.reduce<bigint | null>(
    (s, p) =>
      s === null ? null : ((v) => (v === null ? null : s + v))(valueOf(p.currency, p.amount)),
    0n,
  );
  const account = customerId && accountText.trim() ? toMinorUnits(accountText, 'SYP') : '0';
  const onAccount = account === null ? null : BigInt(account);
  const change =
    total !== null && paidSyp !== null && onAccount !== null ? paidSyp + onAccount - total : null;
  const ready =
    cart.length > 0 &&
    total !== null &&
    total > 0n &&
    paymentsValid &&
    onAccount !== null &&
    onAccount <= total &&
    (payments.length > 0 || onAccount > 0n) &&
    change !== null &&
    change >= 0n &&
    // Change comes from cash; nothing is given back out of what goes on account.
    (onAccount === 0n || change <= (paidSyp ?? 0n));

  const sell = useMutation({
    mutationFn: async () =>
      api.sell(
        {
          shiftId,
          lines: cart.map((l) => ({ variantId: l.lookup.variant.id, quantity: l.quantity })),
          ...(discount && discount !== '0' ? { discount } : {}),
          payments,
          ...(onAccount && onAccount > 0n
            ? { account: { partyId: customerId, amount: account! } }
            : {}),
        },
        key,
      ),
    onSuccess: async (receipt) => {
      toast(`تم البيع — فاتورة ${receipt.receiptYear}/${receipt.receiptNo}`);
      setCart([]);
      setPaid(EMPTY_COUNTS);
      setDiscount('');
      setCustomerId('');
      setAccountText('');
      setKey(crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: ['pos'] });
      await navigate({
        to: '/pos/receipts/$saleId',
        params: { saleId: receipt.id },
        search: { print: true },
      });
    },
  });

  const setQuantity = (variantId: string, quantity: number) =>
    setCart((lines) =>
      quantity <= 0
        ? lines.filter((l) => l.lookup.variant.id !== variantId)
        : lines.map((l) => (l.lookup.variant.id === variantId ? { ...l, quantity } : l)),
    );

  return (
    <>
      <PageTitle
        actions={
          <Link to="/pos/shifts/$shiftId" params={{ shiftId }}>
            <Button variant="secondary">فواتير الوردية والإغلاق</Button>
          </Link>
        }
      >
        نقطة البيع — {store.nameAr}
        <span className="ms-3 text-sm font-normal text-ink-muted">وردية {openedBy}</span>
      </PageTitle>

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-4">
          <form onSubmit={scan}>
            <Input
              ref={scanRef}
              autoFocus
              dir="ltr"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="امسح الباركود هنا…"
              className="min-h-14 text-2xl"
              aria-label="الباركود"
            />
          </form>
          {scanError && <Alert>{scanError}</Alert>}

          <Card className="overflow-x-auto p-0">
            <table className="w-full">
              <thead className="bg-blush text-sm text-ink-muted">
                <tr>
                  <th className="p-2 text-start">القطعة</th>
                  <th className="p-2 text-start">السعر</th>
                  <th className="p-2 text-start">العدد</th>
                  <th className="p-2 text-start">المجموع</th>
                </tr>
              </thead>
              <tbody>
                {cart.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-6 text-center text-ink-muted">
                      امسح أول قطعة لتبدأ الفاتورة
                    </td>
                  </tr>
                )}
                {cart.map((l) => (
                  <tr key={l.lookup.variant.id} className="border-t border-stone">
                    <td className="p-2">
                      <div className="font-medium">{l.lookup.variant.product.nameAr}</div>
                      <div className="text-sm text-ink-muted">{l.lookup.variant.title}</div>
                      {l.lookup.available !== null && l.quantity > l.lookup.available && (
                        <div className="text-sm text-bad">
                          المتوفر في المتجر {l.lookup.available} فقط
                        </div>
                      )}
                    </td>
                    <td className="tabular p-2">{formatMoney(l.lookup.price, 'SYP')}</td>
                    <td className="p-2">
                      <div className="flex items-center gap-1">
                        <Button
                          variant="secondary"
                          size="lg"
                          aria-label="أنقص"
                          onClick={() => setQuantity(l.lookup.variant.id, l.quantity - 1)}
                        >
                          −
                        </Button>
                        <span className="tabular w-8 text-center text-lg font-bold">
                          {l.quantity}
                        </span>
                        <Button
                          variant="secondary"
                          size="lg"
                          aria-label="زد"
                          onClick={() => setQuantity(l.lookup.variant.id, l.quantity + 1)}
                        >
                          +
                        </Button>
                      </div>
                    </td>
                    <td className="tabular p-2 font-bold">
                      {formatMoney(
                        (BigInt(l.lookup.price!) * BigInt(l.quantity)).toString(),
                        'SYP',
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>

        <Card className="flex flex-col gap-3 self-start">
          <div className="text-sm text-ink-muted">المطلوب</div>
          <div className="tabular text-4xl font-bold">
            {total === null ? '—' : formatMoney(total.toString(), 'SYP')}
          </div>
          {manager && (
            <Field label="خصم على الفاتورة (ل.س) — للمدير">
              <Input
                dir="ltr"
                inputMode="decimal"
                value={discountText}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
          )}
          <hr className="border-stone" />
          <div className="text-sm font-medium text-ink-muted">المدفوع</div>
          {DRAWER.map((c) => {
            const minor = paid[c].trim() ? toMinorUnits(paid[c], c) : null;
            const inSyp = c !== 'SYP' && minor ? valueOf(c, minor) : null;
            return (
              <Field key={c} label={`${CURRENCY_NAME[c]} (${CURRENCY_SYMBOL[c]})`}>
                <div className="flex items-center gap-2">
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    value={paid[c]}
                    placeholder="0"
                    disabled={c !== 'SYP' && !rates[c]}
                    onChange={(e) => setPaid({ ...paid, [c]: e.target.value })}
                    className={paid[c] && minor === null ? 'border-bad' : ''}
                  />
                  {c === 'SYP' && total !== null && total > 0n && (
                    <Button
                      variant="ghost"
                      className="whitespace-nowrap text-sm"
                      onClick={() =>
                        setPaid({ ...EMPTY_COUNTS, SYP: fromMinorUnits(total.toString(), 'SYP') })
                      }
                    >
                      كامل
                    </Button>
                  )}
                </div>
                {c !== 'SYP' && !rates[c] && (
                  <span className="text-xs text-bad">لا يوجد سعر صرف</span>
                )}
                {inSyp !== null && inSyp !== undefined && (
                  <span className="tabular text-xs text-ink-muted">
                    = {formatMoney(inSyp.toString(), 'SYP')}
                  </span>
                )}
              </Field>
            );
          })}
          {tillCustomers.length > 0 && (
            <Field label="على الحساب — لزبون معروف">
              <div className="flex flex-col gap-2">
                <select
                  className="min-h-10 w-full rounded-lg border border-stone bg-white px-3"
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                >
                  <option value="">— بدون —</option>
                  {tillCustomers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.nameAr}
                    </option>
                  ))}
                </select>
                {customerId && (
                  <div className="flex items-center gap-2">
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      value={accountText}
                      placeholder="0"
                      aria-label="المبلغ على الحساب"
                      onChange={(e) => setAccountText(e.target.value)}
                      className={account === null ? 'border-bad' : ''}
                    />
                    {total !== null && paidSyp !== null && total > paidSyp && (
                      <Button
                        variant="ghost"
                        className="whitespace-nowrap text-sm"
                        onClick={() =>
                          setAccountText(fromMinorUnits((total - paidSyp).toString(), 'SYP'))
                        }
                      >
                        الباقي عليه
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </Field>
          )}
          {change !== null && (payments.length > 0 || (onAccount ?? 0n) > 0n) && (
            <div
              className={`rounded-lg px-3 py-2 text-lg font-bold ${change >= 0n ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
            >
              {change >= 0n
                ? `الباقي للزبون: ${formatMoney(change.toString(), 'SYP')}`
                : `ينقص: ${formatMoney((-change).toString(), 'SYP')}`}
            </div>
          )}
          {sell.isError && <Alert>{errorText(sell.error)}</Alert>}
          <Button size="lg" disabled={!ready || sell.isPending} onClick={() => sell.mutate()}>
            إتمام البيع وطباعة الإيصال
          </Button>
          {cart.length > 0 && (
            <Button variant="ghost" onClick={() => setCart([])}>
              إلغاء الفاتورة
            </Button>
          )}
        </Card>
      </div>
    </>
  );
}
