import { Button, Card, Code, Field, Input, PageTitle, Select } from '@althobe/ui/components';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { toSVG } from 'bwip-js/browser';
import { memo, useMemo, useState } from 'react';
import type { Variant } from '../api';
import { productsQuery, variantsQuery } from '../queries';

const route = getRouteApi('/app/labels');

// docs/barcode.md → label specification. Printed from the browser so any printer driver works:
// a thermal label printer (one 50×30 mm label per page) or ordinary A4 sticker sheets
// (3 × 8 = 24 labels of 70 × 37 mm — a standard stationery size). Price is never on the label.
const FORMATS = {
  thermal: { name: 'طابعة ملصقات حرارية — 50×30 مم', page: '50mm 30mm', perPage: 1 },
  a4: { name: 'ورق A4 لاصق — 24 ملصق (70×37 مم)', page: 'A4', perPage: 24 },
} as const;
type Format = keyof typeof FORMATS;

export function LabelsPage() {
  const { productId } = route.useSearch();
  const navigate = useNavigate();
  const { data: products = [] } = useQuery(productsQuery);
  const { data: variants = [] } = useQuery({
    ...variantsQuery(productId ?? ''),
    enabled: Boolean(productId),
  });
  const [copies, setCopies] = useState<Record<string, number>>({});
  const [format, setFormat] = useState<Format>('a4');

  const labels = useMemo(
    () => variants.flatMap((v) => Array.from({ length: copies[v.id] ?? 1 }, () => v)),
    [variants, copies],
  );
  const pages = chunk(labels, FORMATS[format].perPage);

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
          <Field label="المنتج">
            <Select
              value={productId ?? ''}
              onChange={(e) =>
                void navigate({ to: '/labels', search: { productId: e.target.value || undefined } })
              }
            >
              <option value="">اختر منتجاً…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.nameAr} ({p.code})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="نوع الورق">
            <Select value={format} onChange={(e) => setFormat(e.target.value as Format)}>
              {Object.entries(FORMATS).map(([key, f]) => (
                <option key={key} value={key}>
                  {f.name}
                </option>
              ))}
            </Select>
          </Field>
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
                    <td className="p-3">
                      {v.fabric} · {v.colour} · {v.size}
                    </td>
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
            <h2 className="mb-2 mt-6 font-bold">معاينة</h2>
            <div className="flex flex-wrap gap-3">
              {labels.slice(0, 6).map((v, i) => (
                <div key={i} className="border border-dashed border-mauve bg-white">
                  <Label variant={v} format={format} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Print output only. The @page rule sets the paper for the chosen format. */}
      <style>{`@media print { @page { size: ${FORMATS[format].page}; margin: 0; } }`}</style>
      <div className="hidden print:block">
        {pages.map((page, i) => (
          <div
            key={i}
            className={format === 'a4' ? 'grid grid-cols-3' : ''}
            style={{
              breakAfter: 'page',
              ...(format === 'a4'
                ? { width: '210mm', height: '297mm', gridTemplateRows: 'repeat(8, 37.125mm)' }
                : {}),
            }}
          >
            {page.map((v, j) => (
              <Label key={j} variant={v} format={format} />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

const Label = memo(function Label({ variant, format }: { variant: Variant; format: Format }) {
  const thermal = format === 'thermal';
  const svg = useMemo(
    () =>
      toSVG({
        bcid: 'ean13',
        text: variant.barcode,
        includetext: true,
        textxalign: 'center',
        height: thermal ? 10 : 13,
        scale: 2,
      }),
    [variant.barcode, thermal],
  );

  return (
    <div
      className="flex flex-col items-center justify-center overflow-hidden text-center text-black"
      style={
        thermal
          ? { width: '50mm', height: '30mm', padding: '1.5mm' }
          : { width: '70mm', height: '37.125mm', padding: '2.5mm' }
      }
    >
      <div
        className="w-full shrink-0 truncate font-bold leading-tight"
        style={{ fontSize: thermal ? '8pt' : '10pt' }}
      >
        {variant.product.nameAr}
      </div>
      <div
        className="w-full shrink-0 truncate leading-tight"
        style={{ fontSize: thermal ? '7pt' : '9pt' }}
      >
        {variant.fabric} · {variant.colour} · مقاس {variant.size}
      </div>
      {/* Safe: bwip-js builds this SVG locally from a validated 13-digit barcode; no user HTML. */}
      <div
        className="my-0.5 flex min-h-0 w-full flex-1 items-center justify-center [&>svg]:h-full [&>svg]:max-w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <div
        dir="ltr"
        className="shrink-0 font-mono leading-tight"
        style={{ fontSize: thermal ? '6pt' : '7pt' }}
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
