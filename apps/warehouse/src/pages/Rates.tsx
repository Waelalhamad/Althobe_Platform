import { Alert, Button, Card, Field, Input, PageTitle, useToast } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type Rate } from '../api';
import { CURRENCY_SYMBOL, errorText } from '../format';
import { PAGES } from '../help';
import { ratesQuery } from '../queries';

const NAMES: Record<Rate['currency'], string> = {
  SYP: 'الليرة السورية',
  LYD: 'الدينار الليبي',
  TRY: 'الليرة التركية',
};

const RATE_PATTERN = /^\d{1,12}(\.\d{1,6})?$/;

/** Owner only (the API enforces admin.rates.write): units of each currency per 1 USD. */
export function RatesPage() {
  const { data: rates = [] } = useQuery(ratesQuery);
  return (
    <>
      <PageTitle intro={PAGES.rates}>أسعار الصرف</PageTitle>
      <div className="grid gap-4 md:grid-cols-2">
        {rates.map((r) => (
          <RateCard key={r.currency} rate={r} />
        ))}
      </div>
    </>
  );
}

function RateCard({ rate }: { rate: Rate }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(rate.rate ? String(Number(rate.rate)) : '');
  const [official, setOfficial] = useState(
    rate.officialRate ? String(Number(rate.officialRate)) : '',
  );
  const clean = value.replace(/[,\s]/g, '');
  const cleanOfficial = official.replace(/[,\s]/g, '');
  const officialValid =
    cleanOfficial === '' || (RATE_PATTERN.test(cleanOfficial) && Number(cleanOfficial) > 0);
  const valid = RATE_PATTERN.test(clean) && Number(clean) > 0 && officialValid;
  const changed =
    rate.rate === null ||
    Number(clean) !== Number(rate.rate) ||
    (cleanOfficial === ''
      ? rate.officialRate !== null
      : Number(cleanOfficial) !== Number(rate.officialRate));
  // Since 2026-01-01 one new pound is 100 old ones (about 122 per dollar in mid-2026). A rate in
  // the thousands is almost surely the old pound.
  const oldPound = rate.currency === 'SYP' && valid && Number(clean) >= 1000;
  const symbol = CURRENCY_SYMBOL[rate.currency];

  const save = useMutation({
    mutationFn: async () => api.setRate(rate.currency, clean, cleanOfficial || null),
    onSuccess: async (saved) => {
      toast(`تم حفظ السعر: 1 $ = ${Number(saved.rate)} ${symbol}`);
      await queryClient.invalidateQueries({ queryKey: ratesQuery.queryKey });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && changed) save.mutate();
  };

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <h2 className="text-lg font-bold">{NAMES[rate.currency]}</h2>
        <Field
          label={`كم ${symbol} مقابل 1 دولار ($)`}
          hint={
            rate.updatedAt
              ? `آخر تعديل: ${new Date(rate.updatedAt).toLocaleString('ar-SY-u-nu-latn')}`
              : 'لم يُحدَّد بعد'
          }
        >
          <Input
            dir="ltr"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={{ SYP: '122', LYD: '6.4', TRY: '41' }[rate.currency]}
            className={value && !valid ? 'border-bad' : ''}
          />
        </Field>
        {oldPound && (
          <Alert tone="warn">
            هذا يبدو سعر الليرة القديمة. منذ 1/1/2026 كل 100 ليرة قديمة = ليرة جديدة واحدة، فالسعر
            اليوم حوالي {Math.round(Number(clean) / 100)}. تأكد قبل الحفظ.
          </Alert>
        )}
        <Field
          label="السعر الرسمي (المصرف المركزي) — للعلم فقط"
          hint="اختياري. القيود تستخدم السعر أعلاه."
        >
          <Input
            dir="ltr"
            inputMode="decimal"
            value={official}
            onChange={(e) => setOfficial(e.target.value)}
            className={official && !officialValid ? 'border-bad' : ''}
          />
        </Field>
        <div>
          <Button type="submit" disabled={!valid || !changed || save.isPending}>
            حفظ
          </Button>
        </div>
        {save.isError && <Alert>{errorText(save.error)}</Alert>}
      </form>
    </Card>
  );
}
