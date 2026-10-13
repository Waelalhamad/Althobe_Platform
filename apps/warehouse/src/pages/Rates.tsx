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
  const clean = value.replace(/[,\s]/g, '');
  const valid = RATE_PATTERN.test(clean) && Number(clean) > 0;
  const changed = rate.rate === null || Number(clean) !== Number(rate.rate);
  const symbol = CURRENCY_SYMBOL[rate.currency];

  const save = useMutation({
    mutationFn: async () => api.setRate(rate.currency, clean),
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
            placeholder={rate.currency === 'SYP' ? '14000' : '7'}
            className={value && !valid ? 'border-bad' : ''}
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
