import { Button, Card, Code, Field, Input, PageTitle, Select } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { toSVG } from 'bwip-js/browser';
import { memo, useEffect, useMemo, useState } from 'react';
import type { Variant } from '../api';
import { categoriesQuery, productsQuery, variantsQuery } from '../queries';
import { categoryPath, categoryTree } from './Categories';

const route = getRouteApi('/app/labels');

// docs/barcode.md → label specification. Printed from the browser so any printer driver works:
// a thermal label printer (one label per page, size chosen to match the roll) or ordinary A4
// sticker sheets (3 × 8 = 24 labels of 70 × 37 mm). Price is never on the label.

interface Size {
  w: number;
  h: number;
}

// Common thermal rolls for 2–3" printers such as the Xprinter XP-365B (width × height, mm).
const THERMAL_PRESETS: Size[] = [
  { w: 40, h: 30 },
  { w: 50, h: 25 },
  { w: 50, h: 30 },
  { w: 58, h: 40 },
  { w: 60, h: 40 },
];
const A4_LABEL: Size = { w: 70, h: 37.125 };
const STORAGE_KEY = 'althobe.labels.v1';

type Format = 'thermal' | 'a4';

interface Settings {
  format: Format;
  thermal: Size;
  border: boolean;
}

const DEFAULTS: Settings = { format: 'thermal', thermal: { w: 50, h: 30 }, border: false };

/** Remembered per computer: the printer and its roll do not change between visits. */
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage unavailable (private window): settings simply are not remembered.
  }
}

const sizeKey = (s: Size) => `${s.w}x${s.h}`;
const validMm = (n: number) => Number.isFinite(n) && n >= 15 && n <= 120;

export function LabelsPage() {
  const { categoryId, productId } = route.useSearch();
  const navigate = useNavigate();
  const { data: categories = [] } = useQuery(categoriesQuery);
  const { data: products = [] } = useQuery({
    ...productsQuery(categoryId),
    enabled: Boolean(categoryId),
  });
  // One product's sizes, or every size of the category.
  const { data: variants = [] } = useQuery({
    ...variantsQuery(productId ? { productId } : { categoryId: categoryId ?? '' }),
    enabled: Boolean(productId ?? categoryId),
  });
  const [copies, setCopies] = useState<Record<string, number>>({});
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [customW, setCustomW] = useState(String(settings.thermal.w));
  const [customH, setCustomH] = useState(String(settings.thermal.h));

  useEffect(() => saveSettings(settings), [settings]);
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  const isPreset = THERMAL_PRESETS.some((p) => sizeKey(p) === sizeKey(settings.thermal));
  const labelSize = settings.format === 'thermal' ? settings.thermal : A4_LABEL;
  const perPage = settings.format === 'thermal' ? 1 : 24;

  const labels = useMemo(
    () => variants.flatMap((v) => Array.from({ length: copies[v.id] ?? 1 }, () => v)),
    [variants, copies],
  );
  const pages = chunk(labels, perPage);
  const pageRule =
    settings.format === 'thermal' ? `${settings.thermal.w}mm ${settings.thermal.h}mm` : 'A4';

  const applyCustom = () => {
    const w = Number(customW);
    const h = Number(customH);
    if (validMm(w) && validMm(h)) update({ thermal: { w, h } });
  };

  return (
    <>
      <div className="print:hidden">
        <PageTitle
          actions={
            <Button onClick={() => window.print()} disabled={labels.length === 0}>
              طباعة {labels.length} ملصق
            </Button>
          }
        >
          طباعة الملصقات
        </PageTitle>

        <Card className="grid gap-3 md:grid-cols-2">
          <Field label="التصنيف">
            <Select
              value={categoryId ?? ''}
              onChange={(e) =>
                void navigate({
                  to: '/labels',
                  search: { categoryId: e.target.value || undefined, productId: undefined },
                })
              }
            >
              <option value="">اختر تصنيفاً…</option>
              {categoryTree(categories).map(({ category: c }) => (
                <option key={c.id} value={c.id}>
                  {categoryPath(categories, c.id)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="المنتج">
            <Select
              value={productId ?? ''}
              disabled={!categoryId}
              onChange={(e) =>
                void navigate({
                  to: '/labels',
                  search: { categoryId, productId: e.target.value || undefined },
                })
              }
            >
              <option value="">كل منتجات التصنيف</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title || p.category.nameAr} ({p.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="نوع الورق">
            <Select
              value={settings.format}
              onChange={(e) => update({ format: e.target.value as Format })}
            >
              <option value="thermal">طابعة ملصقات حرارية (رول)</option>
              <option value="a4">ورق A4 لاصق — 24 ملصق (70×37 مم)</option>
            </Select>
          </Field>

          {settings.format === 'thermal' && (
            <>
              <Field label="مقاس الملصق (العرض × الارتفاع)" hint="يجب أن يطابق مقاس ملصقات الرول">
                <Select
                  value={isPreset ? sizeKey(settings.thermal) : 'custom'}
                  onChange={(e) => {
                    const preset = THERMAL_PRESETS.find((p) => sizeKey(p) === e.target.value);
                    if (preset) {
                      update({ thermal: preset });
                      setCustomW(String(preset.w));
                      setCustomH(String(preset.h));
                    }
                  }}
                >
                  {THERMAL_PRESETS.map((p) => (
                    <option key={sizeKey(p)} value={sizeKey(p)}>
                      {p.w} × {p.h} مم
                    </option>
                  ))}
                  <option value="custom">مقاس آخر…</option>
                </Select>
              </Field>
              <div className="flex items-end gap-2">
                <div className="w-24">
                  <Field label="العرض (مم)">
                    <Input
                      type="number"
                      dir="ltr"
                      value={customW}
                      onChange={(e) => setCustomW(e.target.value)}
                      onBlur={applyCustom}
                    />
                  </Field>
                </div>
                <div className="w-24">
                  <Field label="الارتفاع (مم)">
                    <Input
                      type="number"
                      dir="ltr"
                      value={customH}
                      onChange={(e) => setCustomH(e.target.value)}
                      onBlur={applyCustom}
                    />
                  </Field>
                </div>
                <Button variant="secondary" onClick={applyCustom}>
                  تطبيق
                </Button>
              </div>
            </>
          )}

          <label className="flex items-center gap-2 text-sm md:col-span-2">
            <input
              type="checkbox"
              checked={settings.border}
              onChange={(e) => update({ border: e.target.checked })}
            />
            طباعة إطار للتجربة — لمعرفة أين تقع حدود الملصق عند ضبط الطابعة
          </label>
        </Card>

        {variants.length > 0 && (
          <Card className="mt-4 overflow-x-auto p-0">
            <table className="w-full">
              <thead className="bg-blush text-sm text-ink-muted">
                <tr>
                  <th className="p-3 text-start">الصنف</th>
                  <th className="p-3 text-start">الباركود</th>
                  <th className="w-32 p-3 text-start">عدد النسخ</th>
                </tr>
              </thead>
              <tbody>
                {variants.map((v) => (
                  <tr key={v.id} className="border-t border-stone">
                    <td className="p-3">{v.title}</td>
                    <td className="p-3">
                      <Code>{v.barcode}</Code>
                    </td>
                    <td className="p-2">
                      <Input
                        type="number"
                        min={0}
                        max={500}
                        dir="ltr"
                        value={copies[v.id] ?? 1}
                        onChange={(e) =>
                          setCopies((c) => ({
                            ...c,
                            [v.id]: Math.max(0, Math.min(500, Number(e.target.value) || 0)),
                          }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}

        {labels.length > 0 && (
          <>
            <h2 className="mb-2 mt-6 font-bold">
              معاينة بالمقاس الحقيقي ({labelSize.w} × {labelSize.h} مم)
            </h2>
            <div className="flex flex-wrap gap-3">
              {labels.slice(0, 6).map((v, i) => (
                <div key={i} className="outline outline-1 outline-dashed outline-mauve">
                  <Label variant={v} size={labelSize} border={false} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Print output only. The @page rule sets the paper to exactly one label (or A4). */}
      <style>{`@media print { @page { size: ${pageRule}; margin: 0; } html, body { margin: 0; padding: 0; background: #fff; } }`}</style>
      {/* LTR so every label sits in the top-left corner of the paper, where the printer starts,
          even if the driver's paper is larger than the label. The label content stays RTL. */}
      <div className="hidden print:block" dir="ltr">
        {pages.map((page, i) => (
          <div
            key={i}
            className={settings.format === 'a4' ? 'grid grid-cols-3' : ''}
            style={{
              // No break after the last label: that would feed one blank label.
              breakAfter: i < pages.length - 1 ? 'page' : 'auto',
              overflow: 'hidden',
              ...(settings.format === 'a4'
                ? { width: '210mm', height: '297mm', gridTemplateRows: 'repeat(8, 37.125mm)' }
                : { width: `${labelSize.w}mm`, height: `${labelSize.h}mm` }),
            }}
          >
            {page.map((v, j) => (
              <Label key={j} variant={v} size={labelSize} border={settings.border} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * One label, laid out in millimetres so it prints at exactly the chosen size. Everything scales
 * with the label (50 × 30 mm is the reference). The size is the largest text: it is what store
 * staff look for first; the other options (cut, buttons, fabric, colour, …) are listed under the
 * product name.
 */
const Label = memo(function Label({
  variant,
  size,
  border,
}: {
  variant: Variant;
  size: Size;
  border: boolean;
}) {
  const k = Math.min(size.h / 30, size.w / 50) || 1;
  const details = variant.options
    .filter((o) => o.groupKey !== 'SIZE')
    .map((o) => o.value)
    .join(' · ');
  const mm = (n: number) => `${(n * k).toFixed(2)}mm`;
  const svg = useMemo(
    () =>
      toSVG({
        bcid: 'ean13',
        text: variant.barcode,
        includetext: true, // standard EAN-13 digit groups between the guard bars
        height: 10,
        scale: 2,
      }),
    [variant.barcode],
  );

  return (
    <div
      dir="rtl"
      className="flex flex-col overflow-hidden bg-white text-black"
      style={{
        width: `${size.w}mm`,
        height: `${size.h}mm`,
        padding: mm(1.5),
        boxSizing: 'border-box',
        ...(border ? { outline: '0.2mm solid black', outlineOffset: '-0.2mm' } : {}),
      }}
    >
      <div className="flex shrink-0 items-center justify-between gap-1 leading-none">
        <div className="min-w-0 flex-1 text-start">
          <div className="truncate font-bold" style={{ fontSize: mm(2.6) }}>
            {variant.product.nameAr}
          </div>
          {/* Every option but the size (printed large beside it), on at most two lines. */}
          <div className="mt-0.5 line-clamp-2 leading-tight" style={{ fontSize: mm(2.3) }}>
            {details}
          </div>
        </div>
        <div className="shrink-0 text-center font-bold leading-none" style={{ fontSize: mm(5.2) }}>
          {variant.size}
        </div>
      </div>
      {/* Safe: bwip-js builds this SVG locally from a validated 13-digit barcode; no user HTML. */}
      <div
        className="flex min-h-0 w-full flex-1 items-center justify-center [&>svg]:h-full [&>svg]:max-w-full"
        style={{ marginBlock: mm(0.6) }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div
        dir="ltr"
        className="shrink-0 text-center font-mono leading-none"
        style={{ fontSize: mm(1.8) }}
      >
        {variant.sku}
      </div>
    </div>
  );
});

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
