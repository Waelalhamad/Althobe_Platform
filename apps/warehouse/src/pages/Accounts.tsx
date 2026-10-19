import {
  Alert,
  Button,
  Card,
  Code,
  Field,
  Input,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, type Branch, type Currency, type Range } from '../api';
import {
  BRANCH,
  CURRENCY_SYMBOL,
  errorText,
  formatMoney,
  today,
  VOUCHER_TYPE,
  voucherNumber,
} from '../format';
import { PAGES } from '../help';
import { can, glAccountsQuery, meQuery, statementQuery } from '../queries';
import { CLASS_NAME, DebitCredit, monthStart, RangeFilter, useRefreshBooks } from './finance-parts';

const KIND: Record<string, string> = { CASH: 'صندوق', INVENTORY: 'مخزون', GENERAL: '' };

/** دليل الحسابات: the tree, a statement for each account, and new accounts for the owner. */
export function AccountsPage() {
  const { data: user } = useQuery(meQuery);
  const { data: accounts = [] } = useQuery(glAccountsQuery);
  const refresh = useRefreshBooks();
  const toast = useToast();
  const manage = can(user, 'accounting.close');

  const toggle = useMutation({
    mutationFn: async (a: { id: string; isActive: boolean }) =>
      api.updateGlAccount(a.id, { isActive: a.isActive }),
    onSuccess: async (a) => {
      toast(a.isActive ? `أُعيد تفعيل ${a.nameAr}` : `أُوقف ${a.nameAr}`);
      await refresh();
    },
  });

  return (
    <>
      <PageTitle intro={PAGES.accounts}>دليل الحسابات</PageTitle>
      {manage && <NewAccount />}
      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-2 text-start">الرمز</th>
              <th className="p-2 text-start">الحساب</th>
              <th className="p-2 text-start">النوع</th>
              <th className="p-2 text-start">البلد</th>
              {manage && <th className="p-2" />}
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <tr
                key={a.id}
                className={`border-t border-stone ${a.isPostable ? '' : 'bg-blush/40 font-bold'} ${a.isActive ? '' : 'text-mauve line-through'}`}
              >
                <td className="p-2">
                  <Code>{a.code}</Code>
                </td>
                <td
                  className="p-2"
                  style={{ paddingInlineStart: `${(a.code.length - 1) * 0.6 + 0.5}rem` }}
                >
                  {a.isPostable ? (
                    <Link
                      to="/finance/accounts/$accountId"
                      params={{ accountId: a.id }}
                      className="text-brand"
                    >
                      {a.nameAr}
                    </Link>
                  ) : (
                    a.nameAr
                  )}
                </td>
                <td className="p-2 text-sm">
                  {KIND[a.kind]}
                  {a.currency && ` ${CURRENCY_SYMBOL[a.currency]}`}
                </td>
                <td className="p-2 text-sm">{a.branch ? BRANCH[a.branch] : ''}</td>
                {manage && (
                  <td className="p-2 text-end">
                    {a.isPostable && !a.systemRole && a.kind !== 'INVENTORY' && (
                      <Button
                        variant="ghost"
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate({ id: a.id, isActive: !a.isActive })}
                      >
                        {a.isActive ? 'إيقاف' : 'تفعيل'}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {toggle.isError && <Alert>{errorText(toggle.error)}</Alert>}
    </>
  );
}

function NewAccount() {
  const { data: accounts = [] } = useQuery(glAccountsQuery);
  const refresh = useRefreshBooks();
  const toast = useToast();
  const [parentId, setParent] = useState('');
  const [nameAr, setName] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [branch, setBranch] = useState<Branch | ''>('');
  const parents = accounts.filter((a) => !a.isPostable && a.systemRole !== 'INVENTORY_PARENT');
  const parent = accounts.find((a) => a.id === parentId);
  const isBox = parent?.systemRole === 'CASH_PARENT';

  const create = useMutation({
    mutationFn: async () =>
      api.createGlAccount({
        parentId,
        nameAr: nameAr.trim(),
        ...(isBox ? { kind: 'CASH' as const, currency } : {}),
        ...(branch ? { branch } : {}),
      }),
    onSuccess: async (a) => {
      toast(`أُضيف الحساب ${a.code} · ${a.nameAr}`);
      setName('');
      await refresh();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (parentId && nameAr.trim()) create.mutate();
  };

  return (
    <Card className="mb-4">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
        <div className="w-64">
          <Field label="تحت">
            <Select value={parentId} onChange={(e) => setParent(e.target.value)}>
              <option value="">— اختر المجموعة —</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code} · {p.nameAr} ({CLASS_NAME[p.class]})
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="w-64">
          <Field label="اسم الحساب الجديد">
            <Input value={nameAr} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        {isBox && (
          <div className="w-32">
            <Field label="عملة الصندوق">
              <Select value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>
                <option value="USD">دولار</option>
                <option value="SYP">ليرة سورية</option>
                <option value="LYD">دينار ليبي</option>
                <option value="TRY">ليرة تركية</option>
              </Select>
            </Field>
          </div>
        )}
        <div className="w-32">
          <Field label="البلد">
            <Select value={branch} onChange={(e) => setBranch(e.target.value as Branch | '')}>
              <option value="">—</option>
              <option value="SY">{BRANCH.SY}</option>
              <option value="LY">{BRANCH.LY}</option>
            </Select>
          </Field>
        </div>
        <Button type="submit" disabled={!parentId || !nameAr.trim() || create.isPending}>
          إضافة حساب
        </Button>
      </form>
      {create.isError && (
        <div className="mt-2">
          <Alert>{errorText(create.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

/** كشف حساب: every line on one account, with the running balance. */
export function StatementPage() {
  const { accountId } = useParams({ from: '/app/finance/accounts/$accountId' });
  const [range, setRange] = useState<Range>({ from: monthStart(today()), to: today() });
  const { data, error } = useQuery(statementQuery(accountId, range));

  if (error) return <Alert>{errorText(error)}</Alert>;
  const own =
    data?.account.currency && data.account.currency !== 'USD' ? data.account.currency : null;

  return (
    <>
      <PageTitle
        intro={PAGES.statement}
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            طباعة
          </Button>
        }
      >
        كشف حساب {data ? `${data.account.code} · ${data.account.nameAr}` : ''}
      </PageTitle>
      <RangeFilter range={range} onChange={setRange} />
      <p className="mb-2 hidden print:block">
        من {range.from ?? 'البداية'} إلى {range.to ?? 'اليوم'}
      </p>
      {!data && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {data && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <thead className="bg-blush text-sm text-ink-muted">
              <tr>
                <th className="p-2 text-start">التاريخ</th>
                <th className="p-2 text-start">القيد</th>
                <th className="p-2 text-start">البيان</th>
                <th className="p-2 text-start">مدين $</th>
                <th className="p-2 text-start">دائن $</th>
                {own && <th className="p-2 text-start">المبلغ {CURRENCY_SYMBOL[own]}</th>}
                <th className="p-2 text-start">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-blush/40">
                <td className="p-2" colSpan={3}>
                  الرصيد السابق
                </td>
                <td colSpan={own ? 3 : 2} />
                <td className="tabular p-2 font-bold">
                  <Balance
                    base={data.opening.base}
                    own={own ? data.opening.currency : null}
                    currency={own}
                  />
                </td>
              </tr>
              {data.rows.map((r, i) => (
                <tr key={i} className="border-t border-stone">
                  <td className="tabular p-2 text-ink-muted">{r.entry.entryDate}</td>
                  <td className="p-2">
                    <Link
                      to="/finance/entries/$entryId"
                      params={{ entryId: r.entry.id }}
                      className="text-brand"
                    >
                      {VOUCHER_TYPE[r.entry.voucherType]} {voucherNumber(r.entry)}
                    </Link>
                  </td>
                  <td className="p-2">{r.memo ?? r.entry.memo}</td>
                  <DebitCredit base={r.amountBase} />
                  {own && <td className="tabular p-2">{formatMoney(r.amountCurrency, own)}</td>}
                  <td className="tabular p-2">
                    <Balance
                      base={r.balanceBase}
                      own={own ? r.balanceCurrency : null}
                      currency={own}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

function Balance({
  base,
  own,
  currency,
}: {
  base: string;
  own: string | null;
  currency: Currency | null;
}) {
  return (
    <>
      {own !== null && currency ? <div>{formatMoney(own, currency)}</div> : null}
      <div className={own !== null ? 'text-sm text-ink-muted' : ''}>{formatMoney(base)}</div>
    </>
  );
}
