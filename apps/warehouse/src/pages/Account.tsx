import { Alert, Button, Card, Field, Input, PageTitle } from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText, ROLE } from '../format';
import { meQuery } from '../queries';

const MIN_LENGTH = 12;

/** Change your own password. Other devices are logged out; this one stays in. */
export function AccountPage() {
  const { data: me } = useQuery(meQuery);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');

  const change = useMutation({
    mutationFn: async () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      setRepeat('');
    },
  });

  const mismatch = repeat.length > 0 && next !== repeat;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!mismatch) change.mutate();
  };

  return (
    <>
      <PageTitle>حسابي</PageTitle>
      <Card className="mb-4">
        <div className="font-bold">{me?.nameAr}</div>
        <div className="text-sm text-ink-muted" dir="ltr">
          {me?.email}
        </div>
        <div className="mt-1 text-sm">{me?.roles.map((r) => ROLE[r] ?? r).join('، ')}</div>
      </Card>

      <Card className="max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-3">
          <h2 className="font-bold">تغيير كلمة المرور</h2>
          <Field label="كلمة المرور الحالية">
            <Input
              type="password"
              dir="ltr"
              autoComplete="current-password"
              required
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label="كلمة المرور الجديدة" hint={`${MIN_LENGTH} حرفاً على الأقل`}>
            <Input
              type="password"
              dir="ltr"
              autoComplete="new-password"
              required
              minLength={MIN_LENGTH}
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
          </Field>
          <Field label="تأكيد كلمة المرور الجديدة">
            <Input
              type="password"
              dir="ltr"
              autoComplete="new-password"
              required
              value={repeat}
              onChange={(e) => setRepeat(e.target.value)}
            />
          </Field>
          {mismatch && <Alert tone="warn">كلمتا المرور غير متطابقتين</Alert>}
          {change.isError && <Alert>{errorText(change.error)}</Alert>}
          {change.isSuccess && (
            <Alert tone="ok">تم تغيير كلمة المرور، وخرجت الأجهزة الأخرى من الحساب.</Alert>
          )}
          <Button type="submit" disabled={change.isPending || mismatch || next.length < MIN_LENGTH}>
            حفظ كلمة المرور
          </Button>
        </form>
      </Card>
    </>
  );
}
