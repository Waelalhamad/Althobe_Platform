import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { can, doesStockWork, meQuery, modeQuery } from './queries';

type To =
  | '/stock'
  | '/products'
  | '/labels'
  | '/balances'
  | '/stocktakes'
  | '/movements'
  | '/adjustments'
  | '/gifts'
  | '/shipments'
  | '/reports'
  | '/finance'
  | '/finance/entries'
  | '/finance/accounts'
  | '/finance/reports'
  | '/finance/close'
  | '/finance/payroll'
  | '/finance/parties'
  | '/pos'
  | '/pos/shifts';

interface NavItem {
  to: To;
  label: string;
  /** Shown only to users holding one of these permissions; none = everyone. */
  anyOf?: string[];
}

type Section = 'stock' | 'store' | 'finance';

// Three sides of the app: the warehouse, the store's till (ADR-014) and the books (ADR-013).
// Each person sees only the sides of their job; the switch between them shows only to those
// with more than one (the owner, a manager). Setup lives on one «الإعدادات» page, not here.
const NAV: { section: Section; group: string | null; items: NavItem[] }[] = [
  { section: 'stock', group: null, items: [{ to: '/stock', label: 'عمل المخزون' }] },
  {
    section: 'stock',
    group: 'المنتجات',
    items: [
      { to: '/products', label: 'التصنيفات والمنتجات', anyOf: ['products.write'] },
      { to: '/labels', label: 'الملصقات', anyOf: ['products.write', 'inventory.receive'] },
    ],
  },
  {
    section: 'stock',
    group: 'المخزون',
    items: [
      { to: '/balances', label: 'الأرصدة', anyOf: ['inventory.view'] },
      {
        to: '/stocktakes',
        label: 'الجرد',
        anyOf: ['inventory.stocktake.count', 'inventory.stocktake.apply'],
      },
      { to: '/movements', label: 'السجل', anyOf: ['inventory.view'] },
      { to: '/shipments', label: 'الشحنات', anyOf: ['inventory.view'] },
      {
        to: '/adjustments',
        label: 'طلبات التعديل',
        anyOf: ['inventory.adjust', 'inventory.adjust.approve'],
      },
      { to: '/gifts', label: 'الهدايا', anyOf: ['admin.gifts', 'accounting.view'] },
      { to: '/reports', label: 'تقرير المخزون', anyOf: ['inventory.view'] },
    ],
  },
  {
    section: 'store',
    group: null,
    items: [
      { to: '/pos', label: 'نقطة البيع', anyOf: ['retail.sell'] },
      { to: '/pos/shifts', label: 'الورديات والفواتير', anyOf: ['retail.sell'] },
    ],
  },
  {
    section: 'finance',
    group: null,
    items: [
      { to: '/finance', label: 'الصناديق', anyOf: ['accounting.view'] },
      { to: '/finance/parties', label: 'الموردون والزبائن', anyOf: ['parties.read'] },
      { to: '/finance/payroll', label: 'الرواتب والسلف', anyOf: ['payroll.manage'] },
      { to: '/finance/reports', label: 'الأرباح والتقارير', anyOf: ['accounting.view'] },
    ],
  },
  {
    // What an accountant needs and an owner can skip: entries, the chart, closing a month.
    section: 'finance',
    group: 'للمحاسب',
    items: [
      { to: '/finance/entries', label: 'القيود', anyOf: ['accounting.post'] },
      { to: '/finance/accounts', label: 'دليل الحسابات', anyOf: ['accounting.post'] },
      { to: '/finance/close', label: 'إقفال الشهر', anyOf: ['accounting.close'] },
    ],
  },
];

const SECTIONS: { key: Section; label: string; home: '/stock' | '/pos' | '/finance' }[] = [
  { key: 'stock', label: 'المخزون', home: '/stock' },
  { key: 'store', label: 'المتجر', home: '/pos' },
  { key: 'finance', label: 'المالية', home: '/finance' },
];

/** A side is a person's when their job is there, not merely when they may look at it. */
function hasSection(user: User | undefined, section: Section): boolean {
  if (section === 'stock') return doesStockWork(user);
  if (section === 'store') return can(user, 'retail.sell');
  return can(user, 'accounting.view');
}

function visibleNav(user: User | undefined) {
  return NAV.filter((g) => hasSection(user, g.section))
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !i.anyOf || i.anyOf.some((p) => can(user, p))),
    }))
    .filter((g) => g.items.length > 0);
}

/** Pages every side uses keep the side the person came from. */
const SHARED = ['/rates', '/help', '/account', '/users', '/settings', '/options', '/locations'];

function sectionOf(pathname: string, previous: Section): Section {
  if (pathname.startsWith('/finance')) return 'finance';
  if (pathname.startsWith('/pos')) return 'store';
  if (pathname === '/' || SHARED.some((p) => pathname.startsWith(p))) return previous;
  return 'stock';
}

/** المخزون | المتجر | المالية: shown only to people who work on more than one side. */
function SectionSwitch({ current, sections }: { current: Section; sections: typeof SECTIONS }) {
  if (sections.length < 2) return null;
  return (
    <div className="flex rounded-full bg-white/10 p-1" role="group" aria-label="القسم">
      {sections.map((s) => (
        <Link
          key={s.key}
          to={s.home}
          aria-current={s.key === current ? 'page' : undefined}
          className={`rounded-full px-4 py-1 text-sm font-bold ${
            s.key === current ? 'bg-white text-brand' : 'text-white hover:bg-white/10'
          }`}
        >
          {s.label}
        </Link>
      ))}
    </div>
  );
}

/** Weak internet is everyday in Syria: say it plainly, before a save fails. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

const SETTINGS_PERMISSIONS = [
  'products.write',
  'admin.users.write',
  'admin.locations.write',
  'admin.rates.write',
  'accounting.close',
];

export function AppLayout() {
  const { data: user } = useQuery(meQuery);
  const { data: mode } = useQuery(modeQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const online = useOnline();
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setMenuOpen(false), [pathname]);

  const allNav = visibleNav(user);
  const sections = SECTIONS.filter((s) => allNav.some((g) => g.section === s.key));
  const first = sections[0]?.key ?? 'stock';
  const [section, setSection] = useState<Section>(() => sectionOf(pathname, first));
  useEffect(() => setSection((previous) => sectionOf(pathname, previous)), [pathname]);
  const current = sections.some((s) => s.key === section) ? section : first;
  const nav = allNav.filter((g) => g.section === current);

  const logout = async () => {
    await api.logout().catch(() => undefined);
    queryClient.clear();
    await navigate({ to: '/login' });
  };

  const settings = SETTINGS_PERMISSIONS.some((p) => can(user, p));
  const linkClass = 'rounded-lg px-3 py-1.5 font-medium text-white/85 hover:bg-white/10';
  const active = { className: 'bg-white/15 text-white' };
  const exact = (to: string) => to === '/stock' || to === '/finance' || to === '/pos';

  return (
    <div className="min-h-screen print:min-h-0">
      <header className="bg-brand text-white print:hidden">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link to="/" className="flex items-center gap-3">
            <img src="/logo-mark.svg" alt="" className="size-10 rounded-full bg-white p-0.5" />
            <span className="text-lg font-bold">الثوب العربي</span>
          </Link>
          <SectionSwitch current={current} sections={sections} />

          {/* Wide screens: groups side by side, each with a small heading. */}
          <nav className="hidden items-end gap-4 lg:flex">
            {nav.map((g) => (
              <div key={g.group ?? 'main'} className="flex flex-col">
                {g.group && <span className="px-3 text-xs text-white/85">{g.group}</span>}
                <div className="flex gap-1">
                  {g.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={linkClass}
                      activeProps={active}
                      activeOptions={{ exact: exact(item.to) }}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
          </nav>

          <div className="ms-auto flex items-center gap-1 text-sm">
            {settings && (
              <Link to="/settings" className={linkClass} activeProps={active}>
                ⚙ الإعدادات
              </Link>
            )}
            <Link to="/help" className={`${linkClass} hidden sm:inline`} activeProps={active}>
              ؟ المساعدة
            </Link>
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
                {g.group && <div className="mb-1 text-sm text-white/85">{g.group}</div>}
                <div className="flex flex-col gap-1">
                  {g.items.map((item) => (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`${linkClass} py-2 text-base`}
                      activeProps={active}
                      activeOptions={{ exact: exact(item.to) }}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </div>
            ))}
            <div className="mt-3 flex flex-col gap-1 border-t border-white/20 pt-3">
              <Link to="/help" className={`${linkClass} py-2 text-base`}>
                ؟ المساعدة
              </Link>
              <Link to="/account" className={`${linkClass} py-2 text-base`}>
                حسابي ({user?.nameAr})
              </Link>
            </div>
          </nav>
        )}
      </header>
      {!online && (
        <div className="bg-bad px-4 py-2 text-center font-bold text-white print:hidden">
          لا يوجد اتصال بالإنترنت — لن يُحفظ شيء حتى يعود الاتصال
        </div>
      )}
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
