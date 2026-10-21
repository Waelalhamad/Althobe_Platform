import {
  Alert,
  Button,
  Card,
  Chip,
  ConfirmButton,
  EmptyState,
  Field,
  Input,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, type Branch, type Currency, type Party, type PartyKind } from '../api';
import {
  BRANCH,
  CURRENCY_NAME,
  CURRENCY_SYMBOL,
  errorText,
  formatMoney,
  fromUsdCents,
  toMinorUnits,
  toUsdCents,
} from '../format';
import { PAGES } from '../help';
import {
  boxesQuery,
  can,
  meQuery,
  partiesQuery,
  partiesSummaryQuery,
  partyQuery,
  ratesQuery,
} from '../queries';

// Suppliers and customers (ADR-016): «مين إلك عنده، ومين إله عليك», each in their own currency.

const CURRENCIES: Currency[] = ['SYP', 'USD', 'TRY', 'LYD'];

/** What a party move changes: their page, the totals, the boxes and the books. */
function useRefreshParties() {
  const queryClient = useQueryClient();
  return async () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['parties'] }),
      queryClient.invalidateQueries({ queryKey: ['books'] }),
    ]);
}

const KIND_TEXT: Record<PartyKind, { title: string; owe: string; one: string }> = {
  CUSTOMER: { title: 'إلنا عندهم — الزبائن', owe: 'إلنا عنده', one: 'زبون' },
  SUPPLIER: { title: 'إلهم علينا — الموردون', owe: 'إله علينا', one: 'مورد' },
};

/** الموردون والزبائن: the two lists with what is outstanding, and what has no name on it. */
export function PartiesPage() {
  const { data: user } = useQuery(meQuery);
  const { data: summary } = useQuery(partiesSummaryQuery);
  const { data: all = [], isLoading } = useQuery(partiesQuery());
  const [adding, setAdding] = useState<PartyKind | null>(null);
  const manage = can(user, 'parties.manage');

  return (
    <>
      <PageTitle intro={PAGES.parties}>الموردون والزبائن</PageTitle>

      {summary && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <Total title="إلنا عند الزبائن" rows={summary.customers} />
          <Total title="علينا للموردين" rows={summary.suppliers} />
        </div>
      )}

      {summary && summary.books.payable.unassigned !== '0' && (
        <Unassigned side="PAYABLE" amount={summary.books.payable.unassigned} manage={manage} />
      )}
      {summary && summary.books.receivable.unassigned !== '0' && (
        <Unassigned
          side="RECEIVABLE"
          amount={summary.books.receivable.unassigned}
          manage={manage}
        />
      )}

      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {(['CUSTOMER', 'SUPPLIER'] as const).map((kind) => {
        const list = all.filter((p) => p.kind === kind);
        return (
          <section key={kind} className="mb-8">
            <div className="mb-2 flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold">{KIND_TEXT[kind].title}</h2>
              {manage && adding !== kind && (
                <Button variant="secondary" onClick={() => setAdding(kind)}>
                  + {KIND_TEXT[kind].one} جديد
                </Button>
              )}
            </div>
            {adding === kind && <PartyForm kind={kind} onDone={() => setAdding(null)} />}
            {!isLoading && list.length === 0 && adding !== kind ? (
              <EmptyState title={kind === 'CUSTOMER' ? 'لا يوجد زبائن بعد' : 'لا يوجد موردون بعد'}>
                {kind === 'CUSTOMER'
                  ? 'أضف الزبون الذي يأخذ على الحساب من المتجر، أو تاجر الجملة. بعدها تختاره في نقطة البيع أو عند إخراج البضاعة.'
                  : 'أضف كل مورد بعملته. بعدها تختاره عند استلام البضاعة، فيُكتب لك كم عليك له.'}
              </EmptyState>
            ) : (
              list.length > 0 && <PartyTable parties={list} />
            )}
          </section>
        );
      })}
    </>
  );
}

function Total({ title, rows }: { title: string; rows: { currency: Currency; amount: string }[] }) {
  return (
    <Card>
      <div className="text-sm text-ink-muted">{title}</div>
      {rows.length === 0 ? (
        <div className="text-xl font-bold">لا شيء</div>
      ) : (
        rows.map((r) => (
          <div key={r.currency} className="tabular text-xl font-bold">
            {formatMoney(r.amount, r.currency)}
          </div>
        ))
      )}
    </Card>
  );
}

function PartyTable({ parties }: { parties: Party[] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full">
        <tbody>
          {parties.map((p) => (
            <tr key={p.id} className="border-t border-stone first:border-0">
              <td className="p-3">
                <Link
                  to="/finance/parties/$partyId"
                  params={{ partyId: p.id }}
                  className="font-medium text-brand"
                >
                  {p.nameAr}
                </Link>
                {p.phone && <span className="text-sm text-ink-muted"> · {p.phone}</span>}
              </td>
              <td className="p-3 text-sm text-ink-muted">{CURRENCY_NAME[p.currency]}</td>
              <td
                className={`tabular p-3 text-end font-bold ${p.balance && BigInt(p.balance) < 0n ? 'text-ok' : ''}`}
              >
                {p.balance === null || p.balance === '0' ? '—' : formatMoney(p.balance, p.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * What the books hold with no name on it: receipts confirmed before suppliers existed (or
 * without one). The owner closes it: paid from a box, or already paid before the system.
 */
function Unassigned({
  side,
  amount,
  manage,
}: {
  side: 'PAYABLE' | 'RECEIVABLE';
  amount: string;
  manage: boolean;
}) {
  const [open, setOpen] = useState(false);
  const payable = side === 'PAYABLE';
  return (
    <Card className="mb-6 border-warn">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-bold">
            {payable ? 'بضاعة مستلمة بدون مورد' : 'ديون زبائن بدون اسم'}:{' '}
            <span className="tabular">{formatMoney(amount)}</span>
          </div>
          <div className="text-sm text-ink-muted">
            {payable
              ? 'استلامات قبل إضافة الموردين، أو بدون اختيار مورد. إذا كانت مدفوعة، سكّرها هنا.'
              : 'مبالغ في حساب الزبائن بدون زبون محدد.'}
          </div>
        </div>
        {manage && !open && (
          <Button variant="secondary" onClick={() => setOpen(true)}>
            سكّرها
          </Button>
        )}
      </div>
      {open && <SettleUnassigned side={side} max={amount} onDone={() => setOpen(false)} />}
    </Card>
  );
}

function SettleUnassigned({
  side,
  max,
  onDone,
}: {
  side: 'PAYABLE' | 'RECEIVABLE';
  max: string;
  onDone: () => void;
}) {
  const refresh = useRefreshParties();
  const toast = useToast();
  const { data: boxes = [] } = useQuery(boxesQuery);
  // Goods received with no supplier were, most often, stock owned before the system (F-01).
  const [how, setHow] = useState<'opening' | 'owner' | 'box'>(
    side === 'PAYABLE' ? 'opening' : 'owner',
  );
  const [boxId, setBoxId] = useState('');
  const [amount, setAmount] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const box = boxes.find((b) => b.account.id === boxId);
  const currency: Currency = how === 'box' && box ? box.account.currency! : 'USD';
  const minor = toMinorUnits(amount, currency);
  const settle = useMutation({
    mutationFn: async () =>
      api.settleUnassigned(
        {
          side,
          amount: minor!,
          ...(how === 'box' ? { boxId } : { as: how === 'opening' ? 'OPENING' : 'OWNER' }),
        },
        key,
      ),
    onSuccess: async () => {
      await refresh();
      toast('تم التسكير');
      onDone();
    },
  });

  return (
    <form
      className="mt-4 flex flex-wrap items-end gap-3"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        settle.mutate();
      }}
    >
      <div className="flex flex-wrap gap-2">
        {side === 'PAYABLE' && (
          <Chip selected={how === 'opening'} onClick={() => setHow('opening')}>
            كانت بضاعة موجودة قبل النظام (رصيد افتتاحي)
          </Chip>
        )}
        <Chip selected={how === 'owner'} onClick={() => setHow('owner')}>
          {side === 'PAYABLE' ? 'كانت مدفوعة من قبل (المالك)' : 'قبضها المالك'}
        </Chip>
        <Chip selected={how === 'box'} onClick={() => setHow('box')}>
          {side === 'PAYABLE' ? 'أدفعها هلق من صندوق' : 'دخلت صندوق'}
        </Chip>
      </div>
      {how === 'box' && (
        <div className="w-64">
          <Field label="الصندوق">
            <Select value={boxId} onChange={(e) => setBoxId(e.target.value)}>
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
      )}
      <div className="w-44">
        <Field label={`المبلغ (${CURRENCY_SYMBOL[currency]})`} hint={`الحد: ${formatMoney(max)}`}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={amount && !minor ? 'border-bad' : ''}
          />
        </Field>
      </div>
      <Button
        type="submit"
        disabled={!minor || minor === '0' || (how === 'box' && !boxId) || settle.isPending}
      >
        تسكير
      </Button>
      <Button variant="ghost" onClick={onDone}>
        إلغاء
      </Button>
      {settle.error && (
        <div className="w-full">
          <Alert>{errorText(settle.error)}</Alert>
        </div>
      )}
    </form>
  );
}

function PartyForm({
  kind,
  party,
  onDone,
}: {
  kind: PartyKind;
  party?: Party;
  onDone: () => void;
}) {
  const refresh = useRefreshParties();
  const toast = useToast();
  const [form, setForm] = useState<{
    nameAr: string;
    phone: string;
    currency: Currency;
    branch: Branch;
    notes: string;
  }>({
    nameAr: party?.nameAr ?? '',
    phone: party?.phone ?? '',
    currency: party?.currency ?? (kind === 'CUSTOMER' ? 'SYP' : 'USD'),
    branch: party?.branch ?? 'SY',
    notes: party?.notes ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = useMutation({
    mutationFn: async () =>
      party ? api.updateParty(party.id, form) : api.createParty({ kind, ...form }),
    onSuccess: async (p) => {
      await refresh();
      toast(party ? `تم حفظ ${p.nameAr}` : `تمت إضافة ${p.nameAr}`);
      onDone();
    },
  });

  return (
    <Card className="mb-4">
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
        className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
      >
        <Field label="الاسم">
          <Input value={form.nameAr} onChange={(e) => set({ nameAr: e.target.value })} required />
        </Field>
        <Field label="الهاتف">
          <Input dir="ltr" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field
          label="عملة الحساب"
          hint={kind === 'CUSTOMER' ? 'زبون المتجر على الحساب: ليرة سورية' : 'بعملة فواتيره'}
        >
          <Select
            value={form.currency}
            onChange={(e) => set({ currency: e.target.value as Currency })}
          >
            {CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {CURRENCY_NAME[c]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="البلد">
          <Select value={form.branch} onChange={(e) => set({ branch: e.target.value as Branch })}>
            {(['SY', 'LY'] as const).map((b) => (
              <option key={b} value={b}>
                {BRANCH[b]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="sm:col-span-2 lg:col-span-4">
          <Field label="ملاحظات">
            <Input value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" disabled={!form.nameAr.trim() || save.isPending}>
            حفظ
          </Button>
          <Button variant="ghost" onClick={onDone}>
            إلغاء
          </Button>
        </div>
      </form>
      {save.error && (
        <div className="mt-3">
          <Alert>{errorText(save.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

// ─── One party: the statement ────────────────────────────────────────────────────────────────

const ENTRY_KIND: Record<string, string> = {
  BILL: 'بضاعة استلمناها',
  PAYMENT: 'دفعنا له',
  INVOICE: 'فاتورة جملة',
  RECEIPT: 'قبضنا منه',
  POS_SALE: 'أخذ من المتجر على الحساب',
  POS_REFUND: 'رجّع بضاعة',
};

/** كشف حساب: every bill and payment, newest first, with the balance after each. */
export function PartyPage() {
  const { partyId } = useParams({ from: '/app/finance/parties/$partyId' });
  const { data: user } = useQuery(meQuery);
  const { data: p, error } = useQuery(partyQuery(partyId));
  const [editing, setEditing] = useState(false);
  const [settling, setSettling] = useState(false);
  const refresh = useRefreshParties();
  const toggle = useMutation({
    mutationFn: async () => api.updateParty(partyId, { isActive: !p!.isActive }),
    onSuccess: async () => refresh(),
  });
  const manage = can(user, 'parties.manage');

  if (error) return <Alert>{errorText(error)}</Alert>;
  if (!p) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  const customer = p.kind === 'CUSTOMER';
  const owes = BigInt(p.balance ?? '0');

  return (
    <>
      <PageTitle intro={PAGES.party}>{p.nameAr}</PageTitle>
      {!p.isActive && (
        <div className="mb-4">
          <Alert tone="warn">موقوف: لا يظهر للاختيار. كشف حسابه محفوظ.</Alert>
        </div>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card className={owes !== 0n ? 'border-warn' : undefined}>
          <div className="text-sm text-ink-muted">
            {owes >= 0n
              ? KIND_TEXT[p.kind].owe
              : customer
                ? 'دفع زيادة (له عندنا)'
                : 'دفعنا زيادة (لنا عنده)'}
          </div>
          <div className="tabular text-3xl font-bold">
            {owes === 0n
              ? 'لا شيء'
              : formatMoney((owes < 0n ? -owes : owes).toString(), p.currency)}
          </div>
          <div className="text-sm text-ink-muted">
            {customer ? 'زبون' : 'مورد'} · {CURRENCY_NAME[p.currency]} · {BRANCH[p.branch]}
            {p.phone && ` · ${p.phone}`}
          </div>
          {manage && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button onClick={() => setSettling(true)}>{customer ? 'قبض منه' : 'دفعة له'}</Button>
              <Button variant="secondary" onClick={() => setEditing(true)}>
                تعديل
              </Button>
              <ConfirmButton variant="ghost" onConfirm={() => toggle.mutate()}>
                {p.isActive ? 'إيقاف' : 'إعادة تفعيل'}
              </ConfirmButton>
            </div>
          )}
        </Card>
        {p.notes && (
          <Card>
            <div className="text-sm text-ink-muted">ملاحظات</div>
            <div>{p.notes}</div>
          </Card>
        )}
      </div>

      {editing && <PartyForm kind={p.kind} party={p} onDone={() => setEditing(false)} />}
      {settling && <SettleForm party={p} onDone={() => setSettling(false)} />}

      <h2 className="mb-2 text-lg font-bold">كشف الحساب</h2>
      {p.entries.length === 0 ? (
        <p className="text-ink-muted">لا توجد حركات بعد.</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <thead className="bg-blush text-sm text-ink-muted">
              <tr>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">الحركة</th>
                <th className="p-2 text-start">المبلغ</th>
                <th className="p-2 text-start">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {p.entries.map((e) => (
                <tr key={e.id} className="border-t border-stone">
                  <td className="tabular p-2 text-ink-muted">
                    {new Date(e.createdAt).toLocaleDateString('ar-SY-u-nu-latn')}
                  </td>
                  <td className="p-2">
                    {e.journalEntryId ? (
                      <Link
                        to="/finance/entries/$entryId"
                        params={{ entryId: e.journalEntryId }}
                        className="text-brand"
                      >
                        {ENTRY_KIND[e.kind]}
                      </Link>
                    ) : (
                      ENTRY_KIND[e.kind]
                    )}
                    {e.note && <span className="text-sm text-ink-muted"> · {e.note}</span>}
                  </td>
                  <td className={`tabular p-2 font-bold ${BigInt(e.amount) < 0n ? 'text-ok' : ''}`}>
                    {BigInt(e.amount) > 0n ? '+' : '−'}
                    {formatMoney(e.amount.replace('-', ''), p.currency)}
                  </td>
                  <td className="tabular p-2">{formatMoney(e.balance, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

/** قبض من زبون · دفعة لمورد: any box; another currency is counted at today's rates. */
function SettleForm({ party, onDone }: { party: Party; onDone: () => void }) {
  const refresh = useRefreshParties();
  const toast = useToast();
  const { data: boxes = [] } = useQuery(boxesQuery);
  const { data: rates = [] } = useQuery(ratesQuery);
  const usable = boxes.filter((b) => b.account.isActive);
  const own = usable.find((b) => b.account.currency === party.currency);
  const [boxId, setBoxId] = useState(own?.account.id ?? '');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const box = usable.find((b) => b.account.id === boxId);
  const currency = box?.account.currency ?? party.currency;
  const minor = toMinorUnits(amount, currency);
  const customer = party.kind === 'CUSTOMER';
  // Another currency: what it is worth in the party's, at today's rates, before confirming.
  const rateOf = (c: Currency) => (c === 'USD' ? '1' : rates.find((r) => r.currency === c)?.rate);
  const boxRate = rateOf(currency);
  const partyRate = rateOf(party.currency);
  const worth =
    minor && currency !== party.currency && boxRate && partyRate
      ? formatMoney(
          fromUsdCents(toUsdCents(minor, currency, boxRate), party.currency, partyRate),
          party.currency,
        )
      : null;
  const save = useMutation({
    mutationFn: async () =>
      api.settleParty(party.id, { boxId, amount: minor!, note: note || undefined }, key),
    onSuccess: async () => {
      await refresh();
      toast(customer ? 'تم القبض' : 'تم الدفع');
      onDone();
    },
  });

  return (
    <Card className="mb-6">
      <h2 className="mb-3 font-bold">
        {customer ? `قبض من ${party.nameAr}` : `دفعة إلى ${party.nameAr}`}
      </h2>
      <form
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.mutate();
        }}
        className="flex flex-wrap items-end gap-3"
      >
        <div className="w-64">
          <Field label={customer ? 'دخلت إلى صندوق' : 'طلعت من صندوق'}>
            <Select value={boxId} onChange={(e) => setBoxId(e.target.value)}>
              <option value="">— اختر —</option>
              {usable.map((b) => (
                <option key={b.account.id} value={b.account.id}>
                  {b.account.nameAr}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-44">
          <Field
            label={`المبلغ (${CURRENCY_SYMBOL[currency]})`}
            hint={worth ? `≈ ${worth} من حسابه بسعر اليوم` : undefined}
          >
            <Input
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className={amount && !minor ? 'border-bad' : ''}
            />
          </Field>
        </div>
        <div className="w-56">
          <Field label="ملاحظة">
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" disabled={!boxId || !minor || minor === '0' || save.isPending}>
          تسجيل
        </Button>
        <Button variant="ghost" onClick={onDone}>
          إلغاء
        </Button>
      </form>
      {save.error && (
        <div className="mt-3">
          <Alert>{errorText(save.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
