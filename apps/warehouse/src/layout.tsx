import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { can, meQuery, modeQuery } from './queries';

type To =
  | '/'
  | '/options'
  | '/locations'
  | '/products'
  | '/labels'
  | '/balances'
  | '/stocktakes'
  | '/movements'
  | '/reports';

interface NavItem {
  to: To;
  label: string;
  /** Shown only to users holding one of these permissions; none = everyone. */
  anyOf?: string[];
}

// Grouped by job, in the order the work happens. Each person sees only what they may use.
const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ to: '/', label: 'الرئيسية' }] },
  {
    group: 'الإعداد',
    items: [
      { to: '/options', label: 'الخيارات', anyOf: ['products.write'] },
      { to: '/products', label: 'التصنيفات والمنتجات', anyOf: ['products.write'] },
      { to: '/labels', label: 'طباعة الملصقات', anyOf: ['products.write', 'inventory.receive'] },
      { to: '/locations', label: 'المواقع', anyOf: ['admin.locations.write'] },
    ],
  },
  {
    group: 'المخزون',
    items: [
      { to: '/balances', label: 'الأرصدة', anyOf: ['inventory.view'] },
      {
        to: '/stocktakes',
        label: 'الجرد',
        anyOf: ['inventory.stocktake.count', 'inventory.stocktake.apply'],
      },
      { to: '/movements', label: 'السجل', anyOf: ['inventory.view'] },
    ],
  },
  {
    group: 'التقارير',
    items: [{ to: '/reports', label: 'التقارير', anyOf: ['inventory.view'] }],
  },
];

function visibleNav(user: User | undefined) {
  return NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => !i.anyOf || i.anyOf.some((p) => can(user, p))),
  })).filter((g) => g.items.length > 0);
}

export function AppLayout() {
  const { data: user } = useQuery(meQuery);
  const { data: mode } = useQuery(modeQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setMenuOpen(false), [pathname]);

  const logout = async () => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  const nav = visibleNav(user);
  const linkClass = 'rounded-lg px-3 py-1.5 font-medium text-white/85 hover:bg-white/10';
  const active = { className: 'bg-white/15 text-white' };

  return (
    <div className="min-h-screen print:min-h-0">
      <header className="bg-brand text-white print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo-mark.svg" alt="" className="size-10 rounded-full bg-white p-0.5" />
            <span className="text-lg font-bold">الثوب العربي</span>
          </Link>

          {/* Wide screens: groups side by side, each with a small heading. */}
          <nav className="hidden items-end gap-4 lg:flex">
            {nav.map((g) => (
              <div key={g.group ?? 'main'} className="flex flex-col">
                {g.group && <span className="px-3 text-xs text-white/60">{g.group}</span>}
                <div className="flex gap-1">
                  {g.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={linkClass}
                      activeProps={active}
                      activeOptions={{ exact: item.to === '/' }}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-1 text-sm">
            <Link to="/help" className={linkClass} activeProps={active}>
              ؟ المساعدة
            </Link>
            {can(user, 'admin.users.write') && (
              <Link to="/users" className={`${linkClass} hidden sm:inline`} activeProps={active}>
                المستخدمون
              </Link>
            )}
            <Link to="/account" className={`${linkClass} hidden sm:inline`} activeProps={active}>
              {user?.nameAr}
            </Link>
            <button type="button" onClick={() => void logout()} className={linkClass}>
              خروج
            </button>
            <button
              type="button"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((o) => !o)}
              className="rounded-lg border border-white/30 px-3 py-1.5 font-bold lg:hidden"
            >
              {menuOpen ? '✕ إغلاق' : '☰ القائمة'}
            </button>
          </div>
        </div>

        {/* Phones and tablets: one menu with the groups listed. */}
        {menuOpen && (
          <nav className="border-t border-white/20 px-4 pb-4 lg:hidden">
            {nav.map((g) => (
              <div key={g.group ?? 'main'} className="mt-3">
                {g.group && <div className="mb-1 text-sm text-white/60">{g.group}</div>}
                <div className="flex flex-col gap-1">
                  {g.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`${linkClass} py-2 text-base`}
                      activeProps={active}
                      activeOptions={{ exact: item.to === '/' }}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-3 flex flex-col gap-1 border-t border-white/20 pt-3">
              {can(user, 'admin.users.write') && (
                <Link to="/users" className={`${linkClass} py-2 text-base`}>
                  المستخدمون
                </Link>
              )}
              <Link to="/account" className={`${linkClass} py-2 text-base`}>
                حسابي ({user?.nameAr})
              </Link>
            </div>
          </nav>
        )}
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
