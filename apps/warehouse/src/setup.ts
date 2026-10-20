import type { Category, Location, OptionGroup, Product } from './api';

// The setup steps on the home page, in the order the work has to happen. Worked out from data
// the app already loads; nothing extra is stored except "labels printed on this device".

export type StepKey = 'options' | 'categories' | 'products' | 'prices' | 'labels' | 'opening';

export interface SetupStep {
  key: StepKey;
  title: string;
  /** What this step is, and why it comes here. */
  why: string;
  done: boolean;
  /** Progress shown beside the title, e.g. "3 من 5". */
  progress?: string;
}

export interface SetupData {
  groups: OptionGroup[];
  categories: Category[];
  products: Product[];
  locations: Location[];
  /** Pieces in stock per location id. */
  piecesAt: Record<string, number>;
  labelsPrinted: boolean;
}

export function setupSteps(d: SetupData): SetupStep[] {
  const activeGroups = d.groups.filter((g) => g.isActive);
  const filled = activeGroups.filter((g) => g.values.some((v) => v.isActive));
  const sizes = d.groups.find((g) => g.key === 'SIZE');
  const priced = d.products.filter((p) => p.prices.retailSyp || p.prices.retailLyd);
  const activeLocations = d.locations.filter((l) => l.isActive);
  const counted = activeLocations.filter((l) => (d.piecesAt[l.id] ?? 0) > 0);
  const anyStock = counted.length > 0;

  return [
    {
      key: 'options',
      title: 'جهّز الخيارات',
      why: 'القصة، الزر، القماش، اللون، المقاسات… هي القطع التي تُبنى منها المنتجات.',
      done:
        activeGroups.length > 0 &&
        filled.length === activeGroups.length &&
        Boolean(sizes?.values.some((v) => v.isActive)),
      progress: `${filled.length} من ${activeGroups.length} قوائم فيها قيم`,
    },
    {
      key: 'categories',
      title: 'أنشئ التصنيفات',
      why: 'مثل ثوب وطقم. كل تصنيف يحدد أي الخيارات تُستخدم لمنتجاته.',
      done: d.categories.length > 0,
      progress: `${d.categories.length} تصنيف`,
    },
    {
      key: 'products',
      title: 'أنشئ المنتجات',
      why: 'داخل التصنيف تختار القيم، فيُنشأ كل تصميم كمنتج ومعه مقاساته وباركوداتها.',
      done: d.products.length > 0,
      progress: `${d.products.length} منتج`,
    },
    {
      key: 'prices',
      title: 'ضع الأسعار والصور',
      why: 'سعر المفرق بالليرة السورية (والدينار لليبيا)، والجملة بالدولار. الصور اختيارية لكنها تساعد على التعرف على المنتج.',
      done: d.products.length > 0 && priced.length === d.products.length,
      progress: `${priced.length} من ${d.products.length} مسعّر · ${
        d.products.filter((p) => p.mainPhotoId).length
      } بصور`,
    },
    {
      key: 'labels',
      title: 'اطبع الملصقات',
      why: 'ملصق بالباركود على كل قطعة، حتى تُمسح عند الإدخال والبيع والجرد.',
      done: d.labelsPrinted || anyStock,
    },
    {
      key: 'opening',
      title: 'الجرد الافتتاحي',
      why: 'أدخل البضاعة الموجودة أصلاً في كل موقع بمسح ملصقاتها. بعدها يبدأ العمل اليومي.',
      done: activeLocations.length > 0 && counted.length === activeLocations.length,
      progress: `${counted.length} من ${activeLocations.length} مواقع`,
    },
  ];
}

const PRINTED_KEY = 'althobe.labels.printed';

/** Remembered per device: storage may be unavailable (private window), which only hides a tick. */
export function labelsPrinted(): boolean {
  try {
    return localStorage.getItem(PRINTED_KEY) === '1';
  } catch {
    return false;
  }
}

export function markLabelsPrinted(): void {
  try {
    localStorage.setItem(PRINTED_KEY, '1');
  } catch {
    // Not remembered; the step is still ticked once stock exists.
  }
}
