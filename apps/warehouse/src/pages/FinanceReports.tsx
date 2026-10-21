import { Button, Card, Chip, Code, Field, Input, PageTitle } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import type { BalanceSheet, IncomeStatement, Range, SheetGroup, TrialBalance } from '../api';
import { BRANCH, formatMoney, today } from '../format';
import { PAGES } from '../help';
import { balanceSheetQuery, incomeQuery, trialBalanceQuery } from '../queries';
import { BranchSelect, monthStart, RangeFilter } from './finance-parts';

export type ReportTab = 'income' | 'trial' | 'balance' | 'book';
const TABS: { key: ReportTab; label: string }[] = [
  { key: 'income', label: 'الأرباح والخسائر' },
  { key: 'balance', label: 'الميزانية' },
  { key: 'trial', label: 'ميزان المراجعة' },
  { key: 'book', label: 'دفتر الجرد (للطباعة)' },
];

const SECTION: Record<string, string> = {
  revenue: 'الإيرادات',
  costOfSales: 'تكلفة المبيعات',
  stockLosses: 'خسائر وفروقات مخزون (تالف، فروقات جرد وتعديل)',
  expenses: 'المصاريف التشغيلية',
  exchange: 'فروقات الصرف',
};

/** The financial statements, in USD, for any period and either country. */
export function FinanceReportsPage() {
  const { tab } = useSearch({ from: '/app/finance/reports' });
  const navigate = useNavigate();
  const [range, setRange] = useState<Range>({ from: monthStart(today()), to: today() });

  return (
    <>
      <PageTitle
        intro={PAGES.financeReports}
        actions={
          <Button variant="secondary" onClick={() => window.print()}>
            طباعة
          </Button>
        }
      >
        التقارير المالية
      </PageTitle>
      <div className="mb-4 flex flex-wrap gap-2 print:hidden">
        {TABS.map((t) => (
          <Chip
            key={t.key}
            selected={t.key === tab}
            onClick={() => void navigate({ to: '/finance/reports', search: { tab: t.key } })}
          >
            {t.label}
          </Chip>
        ))}
      </div>
      {tab === 'balance' ? (
        <BalanceFilter range={range} onChange={setRange} />
      ) : (
        <RangeFilter range={range} onChange={setRange} />
      )}
      <p className="mb-3 text-ink-muted">
        {tab === 'balance'
          ? `في ${range.to ?? today()}`
          : `من ${range.from ?? 'البداية'} إلى ${range.to ?? 'اليوم'}`}
        {range.branch ? ` · ${BRANCH[range.branch]}` : ' · سوريا وليبيا معاً'} · بالدولار
      </p>
      {tab === 'income' && <Income range={range} />}
      {tab === 'trial' && <Trial range={range} />}
      {tab === 'balance' && <Sheet asOf={range.to} branch={range.branch} />}
      {tab === 'book' && (
        <>
          <h2 className="mb-2 text-xl font-bold">قائمة الدخل</h2>
          <Income range={range} />
          <h2 className="mt-6 mb-2 text-xl font-bold">الميزانية في {range.to ?? today()}</h2>
          <Sheet asOf={range.to} branch={range.branch} />
          <p className="mt-4 text-sm text-ink-muted">
            تفاصيل البضاعة بالقطعة: «تقرير المخزون» في قسم التقارير.
          </p>
        </>
      )}
    </>
  );
}

function BalanceFilter({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
      <div className="w-40">
        <Field label="في تاريخ">
          <Input
            type="date"
            value={range.to ?? ''}
            onChange={(e) => onChange({ ...range, to: e.target.value || undefined })}
          />
        </Field>
      </div>
      <BranchSelect value={range.branch} onChange={(branch) => onChange({ ...range, branch })} />
    </div>
  );
}

function Income({ range }: { range: Range }) {
  const { data } = useQuery(incomeQuery(range));
  if (!data) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  return <IncomeTable data={data} />;
}

function IncomeTable({ data }: { data: IncomeStatement }) {
  const total = (key: string) => data.sections.find((s) => s.key === key)!;
  const block = (key: string) => {
    const s = total(key);
    return (
      <>
        <tr className="bg-blush/60 font-bold">
          <td className="p-2" colSpan={2}>
            {SECTION[key]}
          </td>
        </tr>
        {s.rows.map((r) => (
          <tr key={r.account.id} className="border-t border-stone">
            <td className="p-2 ps-6">
              <Code>{r.account.code}</Code> {r.account.nameAr}
            </td>
            <td className="tabular p-2">{formatMoney(r.amount)}</td>
          </tr>
        ))}
        <tr className="border-t border-stone font-bold">
          <td className="p-2">مجموع {SECTION[key]}</td>
          <td className="tabular p-2">{formatMoney(s.total)}</td>
        </tr>
      </>
    );
  };
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full">
        <tbody>
          {block('revenue')}
          {block('costOfSales')}
          {block('stockLosses')}
          <Total label="مجمل الربح" value={data.grossProfit} />
          {block('expenses')}
          {block('exchange')}
          <Total label="صافي الربح" value={data.netProfit} big />
        </tbody>
      </table>
    </Card>
  );
}

function Total({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <tr className={`border-t-2 border-ink ${big ? 'text-lg' : ''} font-bold`}>
      <td className="p-2">{label}</td>
      <td className={`tabular p-2 ${BigInt(value) < 0n ? 'text-bad' : 'text-ok'}`}>
        {formatMoney(value)}
      </td>
    </tr>
  );
}

function Trial({ range }: { range: Range }) {
  const { data } = useQuery(trialBalanceQuery(range));
  if (!data) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  return <TrialTable data={data} />;
}

function TrialTable({ data }: { data: TrialBalance }) {
  const cell = (v: string) => <td className="tabular p-2">{formatMoney(v)}</td>;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full">
        <thead className="bg-blush text-sm text-ink-muted">
          <tr>
            <th className="p-2 text-start">الحساب</th>
            <th className="p-2 text-start">رصيد أول المدة</th>
            <th className="p-2 text-start">مدين</th>
            <th className="p-2 text-start">دائن</th>
            <th className="p-2 text-start">رصيد آخر المدة</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.account.id} className="border-t border-stone">
              <td className="p-2">
                <Code>{r.account.code}</Code> {r.account.nameAr}
              </td>
              {cell(r.opening)}
              {cell(r.debit)}
              {cell(r.credit)}
              {cell(r.closing)}
            </tr>
          ))}
          <tr className="border-t-2 border-ink font-bold">
            <td className="p-2">المجموع</td>
            {cell(data.totals.opening)}
            {cell(data.totals.debit)}
            {cell(data.totals.credit)}
            {cell(data.totals.closing)}
          </tr>
        </tbody>
      </table>
      <p
        className={`p-3 text-sm ${data.totals.debit === data.totals.credit ? 'text-ok' : 'text-bad'}`}
      >
        {data.totals.debit === data.totals.credit
          ? '✓ مجموع المدين يساوي مجموع الدائن'
          : '✗ المدين لا يساوي الدائن'}
      </p>
    </Card>
  );
}

function Sheet({ asOf, branch }: { asOf?: string; branch?: Range['branch'] }) {
  const { data } = useQuery(
    balanceSheetQuery({ ...(asOf ? { asOf } : {}), ...(branch ? { branch } : {}) }),
  );
  if (!data) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  return <SheetTable data={data} />;
}

function SheetTable({ data }: { data: BalanceSheet }) {
  const group = (title: string, g: SheetGroup) => (
    <>
      <tr className="bg-blush/60 font-bold">
        <td className="p-2" colSpan={2}>
          {title}
        </td>
      </tr>
      {g.rows.map((r) => (
        <tr key={r.account.id} className="border-t border-stone">
          <td className="p-2 ps-6">
            <Code>{r.account.code}</Code> {r.account.nameAr}
          </td>
          <td className="tabular p-2">{formatMoney(r.amount)}</td>
        </tr>
      ))}
    </>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <tbody>
            {group('الأصول (ما نملكه)', data.assets)}
            <Total label="مجموع الأصول" value={data.assets.total} />
          </tbody>
        </table>
      </Card>
      <Card className="overflow-x-auto p-0">
        <table className="w-full">
          <tbody>
            {group('الخصوم (ما علينا)', data.liabilities)}
            {group('حقوق الملكية', data.equity)}
            <tr className="border-t border-stone">
              <td className="p-2 ps-6">أرباح الفترة (غير مُرحّلة)</td>
              <td className="tabular p-2">{formatMoney(data.profit)}</td>
            </tr>
            <Total label="مجموع الخصوم وحقوق الملكية" value={data.totalLiabilitiesAndEquity} />
          </tbody>
        </table>
      </Card>
    </div>
  );
}
