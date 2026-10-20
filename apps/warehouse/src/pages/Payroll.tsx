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
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import {
  api,
  type Branch,
  type Currency,
  type Employee,
  type EmployeeInput,
  type Frequency,
  type LinePatch,
  type PayrollLine,
  type PayrollRun,
} from '../api';
import {
  BRANCH,
  CURRENCY_NAME,
  CURRENCY_SYMBOL,
  errorText,
  formatMoney,
  FREQUENCY,
  fromMinorUnits,
  today,
  toMinorUnits,
} from '../format';
import { PAGES } from '../help';
import {
  boxesQuery,
  employeeQuery,
  employeesQuery,
  payrollRunQuery,
  payrollRunsQuery,
  payrollSummaryQuery,
} from '../queries';

// Payroll (ADR-015): employees, advances, pay sheets. Money is in each employee's own currency.

const CURRENCIES: Currency[] = ['SYP', 'USD', 'LYD', 'TRY'];

/** Payroll changes the boxes and the books too: refresh all three. */
function useRefreshPayroll() {
  const queryClient = useQueryClient();
  return async () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['payroll'] }),
      queryClient.invalidateQueries({ queryKey: ['books'] }),
    ]);
}

const money = (amount: string | null, currency: Currency | null) =>
  amount === null || currency === null ? '—' : formatMoney(amount, currency);

const MONTH = new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const DAY = new Intl.DateTimeFormat('ar-SY-u-nu-latn', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
});
const utc = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** «شهر تشرين الأول 2026» or «أسبوع 3 تشرين الأول – 9 تشرين الأول»: words, not 2026-10. */
function periodText(r: Pick<PayrollRun, 'frequency' | 'periodStart' | 'periodEnd'>): string {
  return r.frequency === 'MONTHLY'
    ? `شهر ${MONTH.format(utc(r.periodStart))}`
    : `أسبوع ${DAY.format(utc(r.periodStart))} – ${DAY.format(utc(r.periodEnd))}`;
}

function statusText(r: PayrollRun): string {
  if (r.status === 'DRAFT') return 'مسودة — لم يُعتمد';
  if (r.status === 'CANCELLED') return 'ملغى';
  return r.unpaidEmployees === 0 ? 'مدفوع بالكامل ✓' : `معتمد — ${r.unpaidEmployees} لم يقبضوا`;
}

/** الرواتب والسلف: what is owed both ways, the employees, and the pay sheets. */
export function PayrollPage() {
  const { data: summary } = useQuery(payrollSummaryQuery);
  const { data: employees = [], isLoading } = useQuery(employeesQuery());
  const { data: runs = [], isLoading: loadingRuns } = useQuery(payrollRunsQuery);
  const [adding, setAdding] = useState(false);

  return (
    <>
      <PageTitle intro={PAGES.payroll}>الرواتب والسلف</PageTitle>

      {summary && !summary.books.ok && (
        <div className="mb-4">
          <Alert tone="warn">
            السلف أو الرواتب المستحقة في الدفاتر لا تطابق صفحات الموظفين. أخبر المطوّر — هذا لا يحدث
            إلا بخطأ برمجي.
          </Alert>
        </div>
      )}

      {summary && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <Card>
            <div className="text-sm text-ink-muted">سلف عند الموظفين</div>
            {summary.advances.length === 0 ? (
              <div className="text-xl font-bold">لا شيء</div>
            ) : (
              summary.advances.map((a) => (
                <div key={a.currency} className="tabular text-xl font-bold">
                  {formatMoney(a.amount, a.currency)}
                </div>
              ))
            )}
          </Card>
          <Card className={summary.unpaid.length ? 'border-warn' : undefined}>
            <div className="text-sm text-ink-muted">رواتب معتمدة لم تُدفع بعد</div>
            {summary.unpaid.length === 0 ? (
              <div className="text-xl font-bold">لا شيء</div>
            ) : (
              <>
                {summary.unpaid.map((u) => (
                  <div key={u.currency} className="tabular text-xl font-bold">
                    {formatMoney(u.amount, u.currency)}
                  </div>
                ))}
                <div className="text-sm text-ink-muted">{summary.unpaidEmployees} موظف</div>
              </>
            )}
          </Card>
        </div>
      )}

      <RunsSection runs={runs} loading={loadingRuns} hasEmployees={employees.length > 0} />

      <div className="mt-8 mb-2 flex items-center justify-between gap-3">
        <h2 className="text-lg font-bold">الموظفون</h2>
        {!adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            + موظف جديد
          </Button>
        )}
      </div>
      {adding && <EmployeeForm onDone={() => setAdding(false)} />}
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {!isLoading && employees.length === 0 && !adding && (
        <EmptyState
          title="لا يوجد موظفون بعد"
          action={<Button onClick={() => setAdding(true)}>أضف أول موظف</Button>}
        >
          أضف كل موظف مع راتبه وعملته، وهل يقبض كل شهر أو كل أسبوع. بعدها تقدر تعطيه سلفة أو تعمل
          كشف الرواتب.
        </EmptyState>
      )}
      {employees.length > 0 && <EmployeesTable employees={employees} />}
    </>
  );
}

function EmployeesTable({ employees }: { employees: Employee[] }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full">
        <thead className="bg-blush text-sm text-ink-muted">
          <tr>
            <th className="p-2 text-start">الاسم</th>
            <th className="p-2 text-start">الراتب</th>
            <th className="p-2 text-start">عليه سلف</th>
          </tr>
        </thead>
        <tbody>
          {employees.map((e) => (
            <tr key={e.id} className="border-t border-stone">
              <td className="p-2">
                <Link
                  to="/finance/employees/$employeeId"
                  params={{ employeeId: e.id }}
                  className="font-medium text-brand"
                >
                  {e.nameAr}
                </Link>
                {e.jobTitle && <span className="text-sm text-ink-muted"> · {e.jobTitle}</span>}
                {e.branch === 'LY' && <span className="text-sm text-ink-muted"> · ليبيا</span>}
              </td>
              <td className="tabular p-2">
                {money(e.salary, e.currency)}{' '}
                <span className="text-sm text-ink-muted">({FREQUENCY[e.frequency]})</span>
              </td>
              <td className={`tabular p-2 ${e.advanceBalance !== '0' ? 'font-bold' : ''}`}>
                {e.advanceBalance === '0' ? '—' : money(e.advanceBalance, e.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/** Last month, or the week that ended yesterday: the period usually paid next. */
function defaultPeriod() {
  const [y, m] = today().split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
  return { month: last, weekStart: weekAgo };
}

function RunsSection({
  runs,
  loading,
  hasEmployees,
}: {
  runs: PayrollRun[];
  loading: boolean;
  hasEmployees: boolean;
}) {
  const navigate = useNavigate();
  const refresh = useRefreshPayroll();
  const [frequency, setFrequency] = useState<Frequency>('MONTHLY');
  const [month, setMonth] = useState(defaultPeriod().month);
  const [weekStart, setWeekStart] = useState(defaultPeriod().weekStart);
  const create = useMutation({
    mutationFn: async () =>
      api.createPayrollRun(
        frequency === 'MONTHLY' ? { frequency, period: month } : { frequency, weekStart },
      ),
    onSuccess: async (run) => {
      await refresh();
      await navigate({ to: '/finance/payroll/$runId', params: { runId: run.id } });
    },
  });
  const shown = runs.filter((r) => r.status !== 'CANCELLED');

  return (
    <>
      <h2 className="mb-2 text-lg font-bold">كشوف الرواتب</h2>
      {hasEmployees && (
        <Card className="mb-4">
          <form
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              create.mutate();
            }}
            className="flex flex-wrap items-end gap-3"
          >
            <div className="flex gap-2">
              {(['MONTHLY', 'WEEKLY'] as const).map((f) => (
                <Chip key={f} selected={frequency === f} onClick={() => setFrequency(f)}>
                  {FREQUENCY[f]}
                </Chip>
              ))}
            </div>
            {frequency === 'MONTHLY' ? (
              <div className="w-48">
                <Field label="الشهر">
                  <Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
                </Field>
              </div>
            ) : (
              <div className="w-48">
                <Field label="أول يوم بالأسبوع">
                  <Input
                    type="date"
                    value={weekStart}
                    onChange={(e) => setWeekStart(e.target.value)}
                  />
                </Field>
              </div>
            )}
            <Button type="submit" disabled={create.isPending}>
              كشف جديد
            </Button>
          </form>
          {create.error && (
            <div className="mt-3">
              <Alert>{errorText(create.error)}</Alert>
            </div>
          )}
        </Card>
      )}
      {loading ? null : shown.length === 0 ? (
        <p className="text-ink-muted">لا توجد كشوف بعد.</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-stone first:border-0">
                  <td className="p-3">
                    <Link
                      to="/finance/payroll/$runId"
                      params={{ runId: r.id }}
                      className="font-medium text-brand"
                    >
                      {periodText(r)}
                    </Link>
                  </td>
                  <td className="tabular p-3">
                    {r.totals.map((t) => formatMoney(t.net, t.currency)).join(' + ')}
                  </td>
                  <td className="p-3 text-sm">{statusText(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}

/** New employee, or editing one: the currency is fixed once they have advances or pay. */
function EmployeeForm({ employee, onDone }: { employee?: Employee; onDone: () => void }) {
  const refresh = useRefreshPayroll();
  const toast = useToast();
  const [form, setForm] = useState<{
    nameAr: string;
    jobTitle: string;
    phone: string;
    branch: Branch;
    currency: Currency;
    salary: string;
    frequency: Frequency;
    notes: string;
  }>({
    nameAr: employee?.nameAr ?? '',
    jobTitle: employee?.jobTitle ?? '',
    phone: employee?.phone ?? '',
    branch: employee?.branch ?? 'SY',
    currency: employee?.currency ?? 'SYP',
    salary: employee?.salary ? fromMinorUnits(employee.salary, employee.currency!) : '',
    frequency: employee?.frequency ?? 'MONTHLY',
    notes: employee?.notes ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const salary = toMinorUnits(form.salary, form.currency);
  const save = useMutation({
    mutationFn: async () => {
      const input: EmployeeInput = { ...form, salary: salary! };
      return employee ? api.updateEmployee(employee.id, input) : api.createEmployee(input);
    },
    onSuccess: async (e) => {
      await refresh();
      toast(employee ? `تم حفظ ${e.nameAr}` : `تمت إضافة ${e.nameAr}`);
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
        <Field label="العمل" hint="مثل: كاشير، أمين مستودع">
          <Input value={form.jobTitle} onChange={(e) => set({ jobTitle: e.target.value })} />
        </Field>
        <Field label="الهاتف">
          <Input dir="ltr" value={form.phone} onChange={(e) => set({ phone: e.target.value })} />
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
        <Field label="عملة الراتب" hint="السلف والدفع بنفس العملة">
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
        <Field label={`الراتب (${CURRENCY_SYMBOL[form.currency]})`}>
          <Input
            dir="ltr"
            inputMode="decimal"
            value={form.salary}
            onChange={(e) => set({ salary: e.target.value })}
            className={form.salary && !salary ? 'border-bad' : ''}
            required
          />
        </Field>
        <Field label="يقبض كل">
          <Select
            value={form.frequency}
            onChange={(e) => set({ frequency: e.target.value as Frequency })}
          >
            <option value="MONTHLY">شهر</option>
            <option value="WEEKLY">أسبوع</option>
          </Select>
        </Field>
        <Field label="ملاحظات">
          <Input value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </Field>
        <div className="flex gap-2 sm:col-span-2 lg:col-span-4">
          <Button type="submit" disabled={!form.nameAr.trim() || !salary || save.isPending}>
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

// ─── One pay sheet ───────────────────────────────────────────────────────────────────────────

/** A pay sheet: edit it while it is a draft, approve it, then pay from a box per currency. */
export function PayrollRunPage() {
  const { runId } = useParams({ from: '/app/finance/payroll/$runId' });
  const { data: run, error } = useQuery(payrollRunQuery(runId));
  const refresh = useRefreshPayroll();
  const toast = useToast();
  const navigate = useNavigate();
  // One key per click target: a double click approves or cancels once.
  const [key, setKey] = useState(() => crypto.randomUUID());
  const act = useMutation({
    mutationFn: async (action: 'approve' | 'cancel') => api.payrollAction(runId, action, key),
    onSuccess: async (_run, action) => {
      setKey(crypto.randomUUID());
      await refresh();
      toast(
        action === 'approve'
          ? 'تم اعتماد الكشف — التالي: ادفع لكل موظف من صندوق'
          : 'تم إلغاء الكشف',
      );
      if (action === 'cancel') await navigate({ to: '/finance/payroll' });
    },
  });

  if (error) return <Alert>{errorText(error)}</Alert>;
  if (!run) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  const draft = run.status === 'DRAFT';
  const currencies = [...new Set(run.lines.map((l) => l.currency))];

  return (
    <>
      <PageTitle intro={PAGES.payrollRun}>كشف رواتب {periodText(run)}</PageTitle>
      <p className="mb-4 font-medium">
        {statusText(run)}
        {run.accrualEntryId && (
          <>
            {' · '}
            <Link
              to="/finance/entries/$entryId"
              params={{ entryId: run.accrualEntryId }}
              className="text-brand"
            >
              القيد
            </Link>
          </>
        )}
      </p>

      <Card className="mb-4 overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-2 text-start">الموظف</th>
              <th className="p-2 text-start">الراتب</th>
              <th className="p-2 text-start">مكافأة</th>
              <th className="p-2 text-start">خصم</th>
              <th className="p-2 text-start">تنخصم من السلفة</th>
              <th className="p-2 text-start">الصافي</th>
              <th className="p-2 text-start">{draft ? '' : 'القبض'}</th>
            </tr>
          </thead>
          <tbody>
            {run.lines.map((l) =>
              draft ? (
                <DraftRow key={l.id} runId={run.id} line={l} />
              ) : (
                <tr key={l.id} className="border-t border-stone">
                  <td className="p-2 font-medium">{l.employee.nameAr}</td>
                  <td className="tabular p-2">{formatMoney(l.salary, l.currency)}</td>
                  <td className="tabular p-2">
                    {l.bonus === '0' ? '—' : formatMoney(l.bonus, l.currency)}
                  </td>
                  <td className="tabular p-2">
                    {l.deduction === '0' ? '—' : formatMoney(l.deduction, l.currency)}
                    {l.deductionNote && (
                      <div className="text-xs text-ink-muted">{l.deductionNote}</div>
                    )}
                  </td>
                  <td className="tabular p-2">
                    {l.advanceDeduct === '0' ? '—' : formatMoney(l.advanceDeduct, l.currency)}
                  </td>
                  <td className="tabular p-2 font-bold">{formatMoney(l.net, l.currency)}</td>
                  <td className="p-2 text-sm">
                    {l.paid ? (
                      <span className="text-ok">
                        ✓ {l.paid.boxName}
                        <br />
                        {new Date(l.paid.paidAt).toLocaleDateString('ar-SY-u-nu-latn')}
                      </span>
                    ) : run.status === 'APPROVED' ? (
                      'لم يقبض'
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ),
            )}
          </tbody>
          <tfoot className="border-t-2 border-stone font-bold">
            {run.totals.map((t) => (
              <tr key={t.currency}>
                <td className="p-2">المجموع ({CURRENCY_NAME[t.currency]})</td>
                <td className="tabular p-2" colSpan={4}>
                  التكلفة {formatMoney(t.gross, t.currency)}
                </td>
                <td className="tabular p-2">{formatMoney(t.net, t.currency)}</td>
                <td />
              </tr>
            ))}
          </tfoot>
        </table>
      </Card>

      {act.error && (
        <div className="mb-4">
          <Alert>{errorText(act.error)}</Alert>
        </div>
      )}

      {draft && (
        <div className="flex flex-wrap gap-2">
          <ConfirmButton size="lg" disabled={act.isPending} onConfirm={() => act.mutate('approve')}>
            اعتماد الكشف
          </ConfirmButton>
          <ConfirmButton variant="ghost" onConfirm={() => act.mutate('cancel')}>
            حذف المسودة
          </ConfirmButton>
          <p className="w-full text-sm text-ink-muted">
            بعد الاعتماد لا يتغير الكشف، ويُسجَّل مصروف الرواتب في الدفاتر بتاريخ آخر الفترة.
          </p>
        </div>
      )}

      {run.status === 'APPROVED' && (
        <>
          {currencies.map((c) => (
            <PayBox key={c} run={run} currency={c} />
          ))}
          {run.lines.every((l) => !l.paid) && (
            <div className="mt-6">
              <ConfirmButton variant="danger" onConfirm={() => act.mutate('cancel')}>
                إلغاء الاعتماد
              </ConfirmButton>
              <p className="mt-1 text-sm text-ink-muted">
                ممكن فقط قبل أن يقبض أي موظف: يُلغى القيد وترجع السلف على الموظفين.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

const CELL_LABEL = {
  salary: 'الراتب',
  bonus: 'مكافأة',
  deduction: 'خصم',
  advanceDeduct: 'تنخصم من السلفة',
} as const;

/** One editable sheet line. Saved with its own button, so a half-typed number is never sent. */
function DraftRow({ runId, line }: { runId: string; line: PayrollLine }) {
  const refresh = useRefreshPayroll();
  const c = line.currency;
  const initial = {
    salary: fromMinorUnits(line.salary, c),
    bonus: line.bonus === '0' ? '' : fromMinorUnits(line.bonus, c),
    deduction: line.deduction === '0' ? '' : fromMinorUnits(line.deduction, c),
    deductionNote: line.deductionNote ?? '',
    advanceDeduct: line.advanceDeduct === '0' ? '' : fromMinorUnits(line.advanceDeduct, c),
  };
  const [form, setForm] = useState(initial);
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const amount = (text: string) => (text.trim() === '' ? '0' : toMinorUnits(text, c));
  const parsed = {
    salary: amount(form.salary),
    bonus: amount(form.bonus),
    deduction: amount(form.deduction),
    advanceDeduct: amount(form.advanceDeduct),
  };
  const valid = Object.values(parsed).every((v) => v !== null);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const net = valid
    ? BigInt(parsed.salary!) +
      BigInt(parsed.bonus!) -
      BigInt(parsed.deduction!) -
      BigInt(parsed.advanceDeduct!)
    : null;

  const save = useMutation({
    mutationFn: async () => {
      const patch: LinePatch = {
        salary: parsed.salary!,
        bonus: parsed.bonus!,
        deduction: parsed.deduction!,
        deductionNote: form.deductionNote,
        advanceDeduct: parsed.advanceDeduct!,
      };
      return api.updatePayrollLine(runId, line.id, patch);
    },
    onSuccess: async () => refresh(),
  });
  const remove = useMutation({
    mutationFn: async () => api.removePayrollLine(runId, line.id),
    onSuccess: async () => refresh(),
  });

  const cell = (field: 'salary' | 'bonus' | 'deduction' | 'advanceDeduct') => (
    <Input
      dir="ltr"
      inputMode="decimal"
      value={form[field]}
      placeholder="0"
      onChange={(e) => set({ [field]: e.target.value })}
      className={`w-28 ${parsed[field] === null ? 'border-bad' : ''}`}
      aria-label={`${CELL_LABEL[field]} — ${line.employee.nameAr}`}
    />
  );

  return (
    <tr className="border-t border-stone align-top">
      <td className="p-2">
        <div className="font-medium">{line.employee.nameAr}</div>
        <div className="text-xs text-ink-muted">{CURRENCY_NAME[c]}</div>
      </td>
      <td className="p-2">{cell('salary')}</td>
      <td className="p-2">{cell('bonus')}</td>
      <td className="p-2">
        {cell('deduction')}
        <Input
          value={form.deductionNote}
          placeholder="السبب (غياب…)"
          onChange={(e) => set({ deductionNote: e.target.value })}
          className="mt-1 w-28 text-sm"
        />
      </td>
      <td className="p-2">
        {cell('advanceDeduct')}
        <div className="mt-1 text-xs text-ink-muted">
          عليه {formatMoney(line.advanceBalance, c)}
        </div>
      </td>
      <td className={`tabular p-2 font-bold ${net !== null && net < 0n ? 'text-bad' : ''}`}>
        {net === null ? '—' : formatMoney(net.toString(), c)}
      </td>
      <td className="p-2">
        <div className="flex flex-col gap-1">
          {dirty && (
            <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              حفظ
            </Button>
          )}
          <ConfirmButton variant="ghost" onConfirm={() => remove.mutate()}>
            شيل من الكشف
          </ConfirmButton>
        </div>
        {(save.error ?? remove.error) && (
          <div className="mt-1 text-xs text-bad">{errorText(save.error ?? remove.error)}</div>
        )}
      </td>
    </tr>
  );
}

/** Pay everyone still owed in one currency, from one box of that currency. */
function PayBox({
  run,
  currency,
}: {
  run: { id: string; lines: PayrollLine[] };
  currency: Currency;
}) {
  const refresh = useRefreshPayroll();
  const toast = useToast();
  const { data: boxes = [] } = useQuery(boxesQuery);
  const usable = boxes.filter((b) => b.account.isActive && b.account.currency === currency);
  const [boxId, setBoxId] = useState('');
  const chosen = boxId || usable[0]?.account.id || '';
  const [key, setKey] = useState(() => crypto.randomUUID());
  const due = run.lines.filter((l) => l.currency === currency && !l.paid);
  const total = due.reduce((s, l) => s + BigInt(l.net), 0n).toString();
  const box = usable.find((b) => b.account.id === chosen);
  const short = box ? BigInt(box.balance) < BigInt(total) : false;
  const pay = useMutation({
    mutationFn: async (lineIds?: string[]) =>
      api.payrollAction(run.id, 'pay', key, { boxId: chosen, ...(lineIds ? { lineIds } : {}) }),
    onSuccess: async () => {
      setKey(crypto.randomUUID());
      await refresh();
      toast(`تم الدفع من ${box?.account.nameAr ?? 'الصندوق'}`);
    },
  });
  if (due.length === 0) return null;

  return (
    <Card className="mb-4">
      <h2 className="mb-3 font-bold">الدفع بـ{CURRENCY_NAME[currency]}</h2>
      {usable.length === 0 ? (
        <Alert tone="warn">لا يوجد صندوق بهذه العملة. أضفه من دليل الحسابات.</Alert>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-72">
            <Field
              label="من أي صندوق؟"
              hint={box ? `فيه الآن ${formatMoney(box.balance, currency)}` : undefined}
            >
              <Select value={chosen} onChange={(e) => setBoxId(e.target.value)}>
                {usable.map((b) => (
                  <option key={b.account.id} value={b.account.id}>
                    {b.account.nameAr}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <ConfirmButton size="lg" disabled={pay.isPending} onConfirm={() => pay.mutate(undefined)}>
            ادفع للكل ({formatMoney(total, currency)})
          </ConfirmButton>
        </div>
      )}
      {short && (
        <p className="mt-2 text-sm text-warn">الصندوق فيه أقل من المطلوب — تأكد قبل الدفع.</p>
      )}
      {due.length > 1 && usable.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          <span className="text-sm text-ink-muted">أو لموظف واحد:</span>
          {due.map((l) => (
            <ConfirmButton
              key={l.id}
              variant="secondary"
              disabled={pay.isPending}
              onConfirm={() => pay.mutate([l.id])}
            >
              {l.employee.nameAr} ({formatMoney(l.net, currency)})
            </ConfirmButton>
          ))}
        </div>
      )}
      {pay.error && (
        <div className="mt-3">
          <Alert>{errorText(pay.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

// ─── One employee ────────────────────────────────────────────────────────────────────────────

const ADVANCE_KIND: Record<string, string> = {
  GIVEN: 'سلفة',
  REPAID: 'رجّعها نقداً',
  DEDUCTED: 'انخصمت من الراتب',
  RESTORED: 'رجعت (إلغاء كشف)',
};

/** One employee: their details, what they owe in advances, and their pay history. */
export function EmployeePage() {
  const { employeeId } = useParams({ from: '/app/finance/employees/$employeeId' });
  const { data: e, error } = useQuery(employeeQuery(employeeId));
  const [editing, setEditing] = useState(false);
  const [moving, setMoving] = useState<'advances' | 'repayments' | null>(null);
  const refresh = useRefreshPayroll();
  const toggle = useMutation({
    mutationFn: async () => api.updateEmployee(employeeId, { isActive: !e!.isActive }),
    onSuccess: async () => refresh(),
  });

  if (error) return <Alert>{errorText(error)}</Alert>;
  if (!e) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  const c = e.currency!;

  return (
    <>
      <PageTitle intro={PAGES.employee}>{e.nameAr}</PageTitle>
      {!e.isActive && (
        <div className="mb-4">
          <Alert tone="warn">موقوف: لا يظهر في الكشوف الجديدة. تاريخه محفوظ.</Alert>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2">
        <Card>
          <div className="text-sm text-ink-muted">الراتب</div>
          <div className="tabular text-2xl font-bold">{money(e.salary, c)}</div>
          <div className="text-sm text-ink-muted">
            كل {e.frequency === 'MONTHLY' ? 'شهر' : 'أسبوع'} · {BRANCH[e.branch]}
            {e.jobTitle && ` · ${e.jobTitle}`}
            {e.phone && ` · ${e.phone}`}
          </div>
          {!editing && (
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                تعديل
              </Button>
              <ConfirmButton variant="ghost" onConfirm={() => toggle.mutate()}>
                {e.isActive ? 'إيقاف (ترك العمل)' : 'إعادة تفعيل'}
              </ConfirmButton>
            </div>
          )}
        </Card>
        <Card className={e.advanceBalance !== '0' ? 'border-warn' : undefined}>
          <div className="text-sm text-ink-muted">عليه سلف</div>
          <div className="tabular text-2xl font-bold">
            {e.advanceBalance === '0' ? 'لا شيء' : money(e.advanceBalance, c)}
          </div>
          <div className="mt-3 flex gap-2">
            <Button onClick={() => setMoving('advances')}>سلفة جديدة</Button>
            {e.advanceBalance !== '0' && (
              <Button variant="secondary" onClick={() => setMoving('repayments')}>
                رجّع من السلفة نقداً
              </Button>
            )}
          </div>
        </Card>
      </div>

      {editing && <EmployeeForm employee={e} onDone={() => setEditing(false)} />}
      {moving && (
        <AdvanceForm
          employeeId={e.id}
          currency={c}
          kind={moving}
          owed={e.advanceBalance ?? '0'}
          onDone={() => setMoving(null)}
        />
      )}

      <h2 className="mb-2 text-lg font-bold">حركات السلف</h2>
      {e.advances.length === 0 ? (
        <p className="mb-6 text-ink-muted">لم يأخذ سلفة بعد.</p>
      ) : (
        <Card className="mb-6 overflow-x-auto p-0">
          <table className="w-full">
            <tbody>
              {e.advances.map((a) => (
                <tr key={a.id} className="border-t border-stone first:border-0">
                  <td className="tabular p-2 text-ink-muted">
                    {new Date(a.createdAt).toLocaleDateString('ar-SY-u-nu-latn')}
                  </td>
                  <td className="p-2">{ADVANCE_KIND[a.kind]}</td>
                  <td
                    className={`tabular p-2 font-bold ${a.kind === 'GIVEN' || a.kind === 'RESTORED' ? '' : 'text-ok'}`}
                  >
                    {a.kind === 'GIVEN' || a.kind === 'RESTORED' ? '+' : '−'}
                    {formatMoney(a.amount, c)}
                  </td>
                  <td className="p-2 text-sm text-ink-muted">
                    {a.note} · {a.createdBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <h2 className="mb-2 text-lg font-bold">الرواتب</h2>
      {e.pay.length === 0 ? (
        <p className="text-ink-muted">لم يدخل أي كشف بعد.</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full">
            <tbody>
              {e.pay.map((p) => (
                <tr key={p.runId} className="border-t border-stone first:border-0">
                  <td className="p-2">
                    <Link
                      to="/finance/payroll/$runId"
                      params={{ runId: p.runId }}
                      className="text-brand"
                    >
                      {periodText(p)}
                    </Link>
                  </td>
                  <td className="tabular p-2 font-bold">{formatMoney(p.net, c)}</td>
                  <td className="tabular p-2 text-sm text-ink-muted">
                    {p.advanceDeduct !== '0' && `سلفة −${formatMoney(p.advanceDeduct, c)}`}
                  </td>
                  <td className="p-2 text-sm">
                    {p.status === 'DRAFT'
                      ? 'مسودة'
                      : p.paidAt
                        ? `✓ قبض ${new Date(p.paidAt).toLocaleDateString('ar-SY-u-nu-latn')}`
                        : 'لم يقبض بعد'}
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

/** Money for an advance out of a box, or paid back into one, in the salary's currency. */
function AdvanceForm({
  employeeId,
  currency,
  kind,
  owed,
  onDone,
}: {
  employeeId: string;
  currency: Currency;
  kind: 'advances' | 'repayments';
  owed: string;
  onDone: () => void;
}) {
  const refresh = useRefreshPayroll();
  const toast = useToast();
  const { data: boxes = [] } = useQuery(boxesQuery);
  const usable = boxes.filter((b) => b.account.isActive && b.account.currency === currency);
  const [boxId, setBoxId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key] = useState(() => crypto.randomUUID());
  const chosen = boxId || usable[0]?.account.id || '';
  const minor = toMinorUnits(amount, currency);
  const give = kind === 'advances';
  const save = useMutation({
    mutationFn: async () =>
      api.advance(
        employeeId,
        kind,
        { boxId: chosen, amount: minor!, note: note || undefined },
        key,
      ),
    onSuccess: async () => {
      await refresh();
      toast(give ? 'تم تسجيل السلفة' : 'تم تسجيل التسديد');
      onDone();
    },
  });

  return (
    <Card className="mb-6">
      <h2 className="mb-3 font-bold">{give ? 'سلفة جديدة' : 'رجّع من السلفة نقداً'}</h2>
      {usable.length === 0 ? (
        <Alert tone="warn">
          لا يوجد صندوق بـ{CURRENCY_NAME[currency]}. السلفة بعملة الراتب نفسها.
        </Alert>
      ) : (
        <form
          onSubmit={(ev: FormEvent) => {
            ev.preventDefault();
            save.mutate();
          }}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="w-64">
            <Field label={give ? 'طلعت من صندوق' : 'دخلت إلى صندوق'}>
              <Select value={chosen} onChange={(e) => setBoxId(e.target.value)}>
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
              hint={give ? undefined : `عليه ${formatMoney(owed, currency)}`}
            >
              <Input
                dir="ltr"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className={amount && !minor ? 'border-bad' : ''}
                required
              />
            </Field>
          </div>
          <div className="w-56">
            <Field label="ملاحظة">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" disabled={!minor || minor === '0' || save.isPending}>
            تسجيل
          </Button>
          <Button variant="ghost" onClick={onDone}>
            إلغاء
          </Button>
        </form>
      )}
      {save.error && (
        <div className="mt-3">
          <Alert>{errorText(save.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
