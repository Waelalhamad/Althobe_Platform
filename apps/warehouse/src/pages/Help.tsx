import { Card, Hint, PageTitle } from '@althobe/ui/components';
import { Link } from '@tanstack/react-router';
import { PAGES, TERMS, type TermKey } from '../help';

// Everything the "؟" hints say, plus what each page is for, in one place.

const PAGE_LIST = [
  { to: '/', name: 'الرئيسية', text: PAGES.home },
  { to: '/options', name: 'الخيارات', text: PAGES.options },
  { to: '/products', name: 'التصنيفات والمنتجات', text: PAGES.categories },
  { to: '/labels', name: 'طباعة الملصقات', text: PAGES.labels },
  { to: '/balances', name: 'الأرصدة', text: PAGES.balances },
  { to: '/stocktakes', name: 'الجرد', text: PAGES.stocktakes },
  { to: '/movements', name: 'السجل', text: PAGES.movements },
  { to: '/reports', name: 'التقارير', text: PAGES.reports },
] as const;

export function HelpPage() {
  return (
    <>
      <PageTitle intro={PAGES.help}>المساعدة</PageTitle>

      <Card className="mb-6">
        <h2 className="mb-2 text-lg font-bold">ترتيب العمل</h2>
        <ol className="list-inside list-decimal space-y-1">
          <li>الخيارات: جهّز القوائم (القصة، القماش، اللون، المقاسات…).</li>
          <li>التصنيفات: أنشئ ثوب، طقم…</li>
          <li>المنتجات: داخل التصنيف اختر القيم، فيُنشأ كل تصميم بمقاساته.</li>
          <li>الأسعار والصور: لكل منتج.</li>
          <li>الملصقات: اطبع والصق على كل قطعة.</li>
          <li>الجرد الافتتاحي: امسح القطع الموجودة في كل موقع.</li>
          <li>العمل اليومي: استلام، بيع، نقل، مرتجع، تالف، جرد — كله بالمسح من الرئيسية.</li>
        </ol>
        <p className="mt-2 text-sm text-ink-muted">
          الصفحة الرئيسية تعرض هذه الخطوات وتأخذك إلى الخطوة التالية بزر واحد.
        </p>
      </Card>

      <h2 className="mb-3 text-lg font-bold">الكلمات</h2>
      <div className="mb-6 grid gap-3 md:grid-cols-2">
        {Object.values(TERMS).map((t) => (
          <Card key={t.term}>
            <h3 className="font-bold">{t.term}</h3>
            <p className="text-ink-muted">{t.text}</p>
          </Card>
        ))}
      </div>

      <h2 className="mb-3 text-lg font-bold">الصفحات</h2>
      <div className="grid gap-3 md:grid-cols-2">
        {PAGE_LIST.map((p) => (
          <Link key={p.to} to={p.to}>
            <Card className="h-full hover:border-brand">
              <h3 className="font-bold text-brand">{p.name}</h3>
              <p className="text-ink-muted">{p.text}</p>
            </Card>
          </Link>
        ))}
      </div>
    </>
  );
}

/** "؟" beside a word, with its explanation from the glossary. */
export function TermHint({ term }: { term: TermKey }) {
  return <Hint label={`ما معنى ${TERMS[term].term}؟`}>{TERMS[term].text}</Hint>;
}
