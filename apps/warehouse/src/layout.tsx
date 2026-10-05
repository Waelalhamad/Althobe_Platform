import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { api } from './api';
import { can, meQuery, modeQuery } from './queries';

const NAV = [
  { to: '/', label: 'الرئيسية' },
  { to: '/products', label: 'المنتجات' },
  { to: '/options', label: 'الخيارات' },
  { to: '/labels', label: 'طباعة الملصقات' },
  { to: '/balances', label: 'الأرصدة' },
  { to: '/stocktakes', label: 'الجرد' },
  { to: '/movements', label: 'السجل' },
  { to: '/reports', label: 'التقارير' },
] as const;

export function AppLayout() {
  const { data: user } = useQuery(meQuery);
  const { data: mode } = useQuery(modeQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const logout = async () => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  return (
    <div className="min-h-screen print:min-h-0">
      <header className="bg-brand text-white print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo-mark.svg" alt="" className="size-10 rounded-full bg-white p-0.5" />
            <span className="text-lg font-bold">الثوب العربي</span>
          </Link>
          <nav className="flex flex-wrap gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="rounded-lg px-3 py-1.5 font-medium text-white/85 hover:bg-white/10"
                activeProps={{ className: 'bg-white/15 text-white' }}
                activeOptions={{ exact: item.to === '/' }}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ms-auto flex items-center gap-3 text-sm">
            {can(user, 'admin.users.write') && (
              <Link to="/users" className="rounded-lg px-3 py-1.5 hover:bg-white/10">
                المستخدمون
              </Link>
            )}
            <Link to="/account" className="rounded-lg px-3 py-1.5 text-white/85 hover:bg-white/10">
              {user?.nameAr}
            </Link>
            <button
              type="button"
              onClick={() => void logout()}
              className="rounded-lg px-3 py-1.5 hover:bg-white/10"
            >
              خروج
            </button>
          </div>
        </div>
      </header>
      {mode?.practice && (
        <div className="bg-warn-soft px-4 py-2 text-center font-bold text-warn print:hidden">
          وضع التدريب — قاعدة بيانات للتجربة، لا تؤثر على المخزون الحقيقي
        </div>
      )}
      {/* No padding or width limit when printing: labels must start at the paper edge. */}
      <main className="mx-auto max-w-6xl px-4 py-6 print:m-0 print:max-w-none print:p-0">
        <Outlet />
      </main>
    </div>
  );
}
