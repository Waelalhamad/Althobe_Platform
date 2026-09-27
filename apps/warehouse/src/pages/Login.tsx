import { Alert, Button, Field, Input } from '@althobe/ui/components';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText } from '../format';
import { meQuery } from '../queries';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const login = useMutation({
    mutationFn: async () => api.login(email, password),
    onSuccess: async (user) => {
      queryClient.setQueryData(meQuery.queryKey, user);
      await navigate({ to: '/' });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    login.mutate();
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-blush px-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-8 shadow-lg">
        <div className="mb-6 flex flex-col items-center gap-2">
          <img src="/logo.svg" alt="الثوب العربي" className="h-32 w-auto" />
          <p className="text-sm text-ink-muted">أصالة الآباء بأيدي الأبناء</p>
        </div>
        <div className="flex flex-col gap-4">
          <Field label="البريد الإلكتروني">
            <Input
              type="email"
              dir="ltr"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>
          <Field label="كلمة المرور">
            <Input
              type="password"
              dir="ltr"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {login.isError && <Alert>{errorText(login.error)}</Alert>}
          <Button type="submit" size="lg" disabled={login.isPending}>
            {login.isPending ? 'جارٍ الدخول…' : 'تسجيل الدخول'}
          </Button>
        </div>
      </form>
    </div>
  );
}
