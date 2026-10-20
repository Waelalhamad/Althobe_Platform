import { Card, PageTitle } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PAGES } from '../help';
import { can, meQuery } from '../queries';

type To =
  '/options' | '/locations' | '/rates' | '/users' | '/finance/accounts' | '/account' | '/help';

const ITEMS: { to: To; title: string; hint: string; anyOf?: string[] }[] = [
  {
    to: '/options',
    title: 'الخيارات',
    hint: 'القصّات والأقمشة والألوان والمقاسات',
    anyOf: ['products.write'],
  },
  {
    to: '/rates',
    title: 'أسعار الصرف',
    hint: 'الليرة السورية والتركية والدينار مقابل الدولار',
    anyOf: ['admin.rates.write'],
  },
  {
    to: '/locations',
    title: 'المواقع',
    hint: 'أسماء المخازن والمتجر',
    anyOf: ['admin.locations.write'],
  },
  {
    to: '/users',
    title: 'المستخدمون',
    hint: 'من يدخل النظام وما دوره',
    anyOf: ['admin.users.write'],
  },
  {
    to: '/finance/accounts',
    title: 'دليل الحسابات',
    hint: 'للمحاسب: أنواع المصاريف والصناديق',
    anyOf: ['accounting.close'],
  },
  { to: '/account', title: 'حسابي', hint: 'كلمة المرور' },
  { to: '/help', title: 'المساعدة', hint: 'شرح الكلمات والصفحات' },
];

/** الإعدادات: everything set once and rarely touched, in one place, away from daily work. */
export function SettingsPage() {
  const { data: user } = useQuery(meQuery);
  return (
    <>
      <PageTitle intro={PAGES.settings}>الإعدادات</PageTitle>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {ITEMS.filter((i) => !i.anyOf || i.anyOf.some((p) => can(user, p))).map((i) => (
          <Link key={i.to} to={i.to}>
            <Card className="flex min-h-24 flex-col justify-center hover:border-brand">
              <span className="text-lg font-bold">{i.title}</span>
              <span className="text-sm text-ink-muted">{i.hint}</span>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}
