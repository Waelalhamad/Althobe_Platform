import {
  Alert,
  Button,
  Card,
  Chip,
  Code,
  ConfirmButton,
  Field,
  Input,
  PageTitle,
  Select,
} from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { api, type Money, type OptionGroup, type Product, type Variant } from '../api';
import { errorText, formatPrice, fromMinorUnits, toMinorUnits } from '../format';
import { PhotoThumb } from '../photo';
import { can, meQuery, optionGroupsQuery, productsQuery, variantsQuery } from '../queries';
import { ProductPhotos } from './ProductPhotos';

const route = getRouteApi('/app/products/$productId');

/** At most this many variants per click; the server enforces the same limit. */
const MAX_COMBINATIONS = 500;

const keyOf = (valueIds: string[]) => [...valueIds].sort().join(',');

export function ProductDetailPage() {
  const { productId } = route.useParams();
  const { data: user } = useQuery(meQuery);
  const { data: products = [] } = useQuery(productsQuery);
  const { data: groups = [] } = useQuery(optionGroupsQuery);
  const { data: variants = [] } = useQuery(variantsQuery(productId));
  const product = products.find((p) => p.id === productId);
  const productGroups = groups.filter((g) => product?.groupIds.includes(g.id));
  const canWrite = can(user, 'products.write');
  const canPrice = can(user, 'prices.write');

  return (
    <>
      <PageTitle
        actions={
          <Link to="/labels" search={{ productId }}>
            <Button variant="secondary">طباعة الملصقات</Button>
          </Link>
        }
      >
        {product?.nameAr ?? '…'} <Code>{product?.code}</Code>
      </PageTitle>

      {product && !product.isActive && (
        <div className="mb-4">
          <Alert tone="warn">
            هذا المنتج موقوف: لا يُستلم ولا يُباع، ولا تُضاف له أصناف حتى يُعاد تفعيله.
          </Alert>
        </div>
      )}

      {canWrite && product && <ProductSettings product={product} groups={groups} />}
      {canWrite && product?.isActive && (
        <VariantBuilder
          productId={productId}
          groups={productGroups}
          variants={variants}
          canPrice={canPrice}
        />
      )}
      <ProductPhotos productId={productId} groups={productGroups} canWrite={canWrite} />
      <VariantTable
        groups={productGroups}
        variants={variants}
        canWrite={canWrite}
        canPrice={canPrice}
      />
    </>
  );
}

/** Pick values per option type; every combination of the picked values becomes a variant. */
function VariantBuilder({
  productId,
  groups,
  variants,
  canPrice,
}: {
  productId: string;
  groups: OptionGroup[];
  variants: Variant[];
  canPrice: boolean;
}) {
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [retail, setRetail] = useState('');
  const [wholesale, setWholesale] = useState('');
  const prices = parsePrices(retail, wholesale);
  const lists = groups.map((g) => chosen[g.id] ?? []);
  const total = groups.length ? lists.reduce((n, list) => n * list.length, 1) : 0;

  const existingKeys = useMemo(
    () => new Set(variants.map((v) => keyOf(v.options.map((o) => o.valueId)))),
    [variants],
  );
  // At most 500 combinations: cheap enough to recount on every render.
  const already =
    total === 0 || total > MAX_COMBINATIONS
      ? 0
      : lists
          .reduce<string[][]>(
            (acc, list) => acc.flatMap((combo) => list.map((id) => [...combo, id])),
            [[]],
          )
          .filter((combo) => existingKeys.has(keyOf(combo))).length;
  const fresh = total - already;

  const toggle = (groupId: string, valueId: string) =>
    setChosen((c) => {
      const current = c[groupId] ?? [];
      return {
        ...c,
        [groupId]: current.includes(valueId)
          ? current.filter((id) => id !== valueId)
          : [...current, valueId],
      };
    });

  const generate = useMutation({
    mutationFn: async () =>
      api.generateVariants(productId, {
        selections: groups.map((g) => ({ groupId: g.id, valueIds: chosen[g.id] ?? [] })),
        ...(prices?.retail || prices?.wholesale
          ? {
              prices: {
                ...(prices.retail ? { retail: prices.retail } : {}),
                ...(prices.wholesale ? { wholesale: prices.wholesale } : {}),
              },
            }
          : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
      await queryClient.invalidateQueries({ queryKey: productsQuery.queryKey });
    },
  });

  return (
    <Card>
      <h2 className="mb-1 text-lg font-bold">إضافة أصناف</h2>
      <p className="mb-4 text-sm text-ink-muted">
        اختر قيمة أو أكثر من كل نوع. يُنشأ صنف لكل تركيبة، ولكل صنف باركود خاص. الأصناف الموجودة لا
        تتكرر.
      </p>
      {groups.length === 0 && (
        <Alert tone="warn">لم تُحدَّد أنواع خيارات لهذا المنتج — اخترها من «تعديل المنتج».</Alert>
      )}
      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <GroupPicker
            key={g.id}
            group={g}
            chosen={chosen[g.id] ?? []}
            onToggle={(valueId) => toggle(g.id, valueId)}
            onSetAll={(ids) => setChosen((c) => ({ ...c, [g.id]: ids }))}
          />
        ))}
      </div>

      {canPrice && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <PriceField label="سعر المفرق للأصناف الجديدة" value={retail} onChange={setRetail} />
          <PriceField
            label="سعر الجملة للأصناف الجديدة"
            value={wholesale}
            onChange={setWholesale}
          />
          <span className="pb-2 text-sm text-ink-muted">اختياري — يمكن التسعير لاحقاً</span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-stone pt-4">
        <Button
          size="lg"
          disabled={fresh === 0 || total > MAX_COMBINATIONS || !prices || generate.isPending}
          onClick={() => generate.mutate()}
        >
          {fresh > 0 ? `إنشاء ${fresh} صنف` : 'إنشاء الأصناف'}
        </Button>
        <span className="text-ink-muted">
          {total === 0
            ? 'اختر من كل نوع قيمة واحدة على الأقل'
            : `${total} تركيبة${already ? ` · ${already} موجودة مسبقاً` : ''}`}
        </span>
        {total > MAX_COMBINATIONS && (
          <span className="font-medium text-bad">
            الحد {MAX_COMBINATIONS} صنف في المرة الواحدة — قلّل الاختيارات
          </span>
        )}
        {total > 100 && total <= MAX_COMBINATIONS && (
          <span className="font-medium text-warn">عدد كبير — تأكد أنك تصنع كل هذه التركيبات</span>
        )}
        {generate.isSuccess && (
          <span className="text-ok">أُنشئ {generate.data.created.length} صنف جديد</span>
        )}
      </div>
      {generate.isError && (
        <div className="mt-3">
          <Alert>{errorText(generate.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

function GroupPicker({
  group,
  chosen,
  onToggle,
  onSetAll,
}: {
  group: OptionGroup;
  chosen: string[];
  onToggle: (valueId: string) => void;
  onSetAll: (valueIds: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState('');
  const active = group.values.filter((v) => v.isActive);
  const allChosen = active.length > 0 && active.every((v) => chosen.includes(v.id));

  // A value missing from the list is added right here, then picked.
  const add = useMutation({
    mutationFn: async () => api.addOptionValue(group.id, adding.trim()),
    onSuccess: async (value) => {
      setAdding('');
      await queryClient.invalidateQueries({ queryKey: optionGroupsQuery.queryKey });
      onToggle(value.id);
    },
  });

  return (
    <div role="group" aria-label={group.nameAr}>
      <div className="mb-2 flex items-center gap-2">
        <span className="font-bold">{group.nameAr}</span>
        {active.length > 1 && (
          <button
            type="button"
            className="text-sm text-brand underline"
            onClick={() => onSetAll(allChosen ? [] : active.map((v) => v.id))}
          >
            {allChosen ? 'إلغاء الكل' : 'اختيار الكل'}
          </button>
        )}
        {!group.isActive && (
          <span className="text-sm text-warn">
            هذا النوع مخفي — أظهره من صفحة الخيارات أو أزله من المنتج
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {active.map((v) => (
          <Chip
            key={v.id}
            selected={chosen.includes(v.id)}
            disabled={!group.isActive}
            onClick={() => onToggle(v.id)}
          >
            {v.valueAr}
          </Chip>
        ))}
        {group.isActive && (
          <form
            className="flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (adding.trim()) add.mutate();
            }}
          >
            <Input
              className="w-36"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
              placeholder="+ قيمة جديدة"
            />
            {adding.trim() && (
              <Button type="submit" variant="secondary" disabled={add.isPending}>
                إضافة
              </Button>
            )}
          </form>
        )}
      </div>
      {add.isError && <div className="mt-1 text-sm text-bad">{errorText(add.error)}</div>}
    </div>
  );
}

/** Rename, choose which option types the product is made with, retire or restore. */
function ProductSettings({ product, groups }: { product: Product; groups: OptionGroup[] }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [nameAr, setNameAr] = useState(product.nameAr);
  const [groupIds, setGroupIds] = useState(product.groupIds);
  // Hidden types stay listed only while the product still has them.
  const offered = groups.filter((g) => g.isActive || product.groupIds.includes(g.id));

  const update = useMutation({
    mutationFn: async (patch: Parameters<typeof api.updateProduct>[1]) =>
      api.updateProduct(product.id, patch),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: productsQuery.queryKey });
      await queryClient.invalidateQueries({ queryKey: ['variants', product.id] });
    },
  });

  if (!open) {
    return (
      <div className="mb-4 flex justify-end">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          تعديل المنتج
        </Button>
      </div>
    );
  }

  return (
    <Card className="mb-4">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="اسم المنتج">
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </Field>
        <div>
          <span className="text-sm font-medium text-ink-muted">أنواع الخيارات لهذا المنتج</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {offered.map((g) => (
              <Chip
                key={g.id}
                selected={groupIds.includes(g.id)}
                onClick={() =>
                  setGroupIds((ids) =>
                    ids.includes(g.id) ? ids.filter((id) => id !== g.id) : [...ids, g.id],
                  )
                }
              >
                {g.nameAr}
              </Chip>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={!nameAr.trim() || groupIds.length === 0 || update.isPending}
          onClick={() => update.mutate({ nameAr: nameAr.trim(), groupIds })}
        >
          حفظ
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          إغلاق
        </Button>
        <span className="ms-auto">
          {product.isActive ? (
            <ConfirmButton
              variant="danger"
              disabled={update.isPending}
              onConfirm={() => update.mutate({ isActive: false })}
            >
              إيقاف المنتج
            </ConfirmButton>
          ) : (
            <Button
              variant="secondary"
              disabled={update.isPending}
              onClick={() => update.mutate({ isActive: true })}
            >
              إعادة تفعيل المنتج
            </Button>
          )}
        </span>
      </div>
      {update.isSuccess && <p className="mt-3 text-ok">تم الحفظ</p>}
      {update.isError && (
        <div className="mt-3">
          <Alert>{errorText(update.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

function VariantTable({
  groups,
  variants,
  canWrite,
  canPrice,
}: {
  groups: OptionGroup[];
  variants: Variant[];
  canWrite: boolean;
  canPrice: boolean;
}) {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const valueOf = (v: Variant, groupId: string) =>
    v.options.find((o) => o.groupId === groupId)?.value ?? '—';
  const withPhotos = variants.some((v) => v.photoId);
  const visible = variants.filter((v) =>
    Object.entries(filters).every(([groupId, value]) => !value || valueOf(v, groupId) === value),
  );

  const toggle = useMutation({
    mutationFn: async (v: Variant) => api.setVariantActive(v.id, !v.isActive),
    onSuccess: async (v) => queryClient.invalidateQueries({ queryKey: ['variants', v.product.id] }),
  });

  return (
    <Card className="mt-4 overflow-x-auto p-0">
      {variants.length > 0 && (
        <div className="flex flex-wrap items-end gap-3 p-3">
          {groups.map((g) => {
            const values = [...new Set(variants.map((v) => valueOf(v, g.id)))];
            if (values.length < 2) return null;
            return (
              <div key={g.id} className="w-36">
                <Field label={g.nameAr}>
                  <Select
                    value={filters[g.id] ?? ''}
                    onChange={(e) => setFilters((f) => ({ ...f, [g.id]: e.target.value }))}
                  >
                    <option value="">الكل</option>
                    {values.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            );
          })}
          <span className="ms-auto text-sm text-ink-muted">
            {visible.length} من {variants.length} صنف
          </span>
        </div>
      )}
      {canPrice && visible.length > 0 && <BulkPrices variants={visible} />}
      <table className="w-full">
        <thead className="bg-blush text-sm text-ink-muted">
          <tr>
            {groups.map((g) => (
              <th key={g.id} className="p-3 text-start">
                {g.nameAr}
              </th>
            ))}
            <th className="p-3 text-start">SKU</th>
            <th className="p-3 text-start">الباركود</th>
            <th className="p-3 text-start">المفرق</th>
            <th className="p-3 text-start">الجملة</th>
            {withPhotos && <th className="p-3 text-start">الصورة</th>}
            {canWrite && <th className="p-3" />}
          </tr>
        </thead>
        <tbody>
          {visible.map((v) => (
            <tr key={v.id} className={`border-t border-stone ${v.isActive ? '' : 'opacity-50'}`}>
              {groups.map((g) => (
                <td key={g.id} className="p-3">
                  {valueOf(v, g.id)}
                </td>
              ))}
              <td className="p-3">
                <Code>{v.sku}</Code>
              </td>
              <td className="p-3">
                <Code>{v.barcode}</Code>
              </td>
              <PriceCell variant={v} list="retail" editable={canPrice} />
              <PriceCell variant={v} list="wholesale" editable={canPrice} />
              {withPhotos && (
                <td className="p-2">
                  <PhotoThumb id={v.photoId} size={44} />
                </td>
              )}
              {canWrite && (
                <td className="p-2 text-end">
                  <Button
                    variant="ghost"
                    disabled={toggle.isPending}
                    onClick={() => toggle.mutate(v)}
                  >
                    {v.isActive ? 'إيقاف' : 'تفعيل'}
                  </Button>
                </td>
              )}
            </tr>
          ))}
          {variants.length === 0 && (
            <tr>
              <td colSpan={groups.length + 6} className="p-6 text-center text-ink-muted">
                لا توجد أصناف بعد
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {toggle.isError && (
        <div className="p-3">
          <Alert>{errorText(toggle.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

/**
 * The typed prices as minor units: undefined for an empty field, or null when either field is
 * not a valid amount (so nothing is sent).
 */
function parsePrices(retail: string, wholesale: string) {
  const one = (text: string) => (text.trim() ? toMinorUnits(text) : undefined);
  const [r, w] = [one(retail), one(wholesale)];
  return r === null || w === null ? null : { retail: r, wholesale: w };
}

function PriceField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const invalid = value.trim() !== '' && toMinorUnits(value) === null;
  return (
    <div className="w-48">
      <Field label={`${label} ($)`}>
        <Input
          dir="ltr"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="25.00"
          className={invalid ? 'border-bad' : ''}
        />
      </Field>
    </div>
  );
}

/** Same price for every variant the filters show; an empty field leaves that price alone. */
function BulkPrices({ variants }: { variants: Variant[] }) {
  const queryClient = useQueryClient();
  const [retail, setRetail] = useState('');
  const [wholesale, setWholesale] = useState('');
  const prices = parsePrices(retail, wholesale);
  const ready = Boolean(prices?.retail ?? prices?.wholesale);

  const apply = useMutation({
    mutationFn: async () =>
      api.setPrices({
        variantIds: variants.map((v) => v.id),
        ...(prices?.retail ? { retail: prices.retail } : {}),
        ...(prices?.wholesale ? { wholesale: prices.wholesale } : {}),
      }),
    onSuccess: async () => {
      setRetail('');
      setWholesale('');
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
    },
  });

  return (
    <div className="mx-3 mb-3 flex flex-wrap items-end gap-3 rounded-lg bg-blush p-3">
      <span className="pb-2 font-medium">تسعير الأصناف المعروضة ({variants.length}):</span>
      <PriceField label="المفرق" value={retail} onChange={setRetail} />
      <PriceField label="الجملة" value={wholesale} onChange={setWholesale} />
      <ConfirmButton disabled={!ready || apply.isPending} onConfirm={() => apply.mutate()}>
        تعيين السعر لـ {variants.length} صنف
      </ConfirmButton>
      {apply.isSuccess && <span className="pb-2 text-ok">تم التسعير</span>}
      {apply.isError && <span className="pb-2 text-bad">{errorText(apply.error)}</span>}
    </div>
  );
}

/** A price in the table; with prices.write, click it to edit. Saving an empty field removes it. */
function PriceCell({
  variant,
  list,
  editable,
}: {
  variant: Variant;
  list: 'retail' | 'wholesale';
  editable: boolean;
}) {
  const queryClient = useQueryClient();
  const price: Money | null = variant.prices[list];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');

  const save = useMutation({
    mutationFn: async (amount: string | null) =>
      api.setPrices({ variantIds: [variant.id], [list]: amount }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
    },
  });

  if (!editing) {
    return (
      <td className={`tabular p-3 ${price ? '' : 'text-ink-muted'}`}>
        {editable ? (
          <button
            type="button"
            className="hover:text-brand hover:underline"
            onClick={() => {
              setText(price ? fromMinorUnits(price.amount) : '');
              setEditing(true);
            }}
          >
            {formatPrice(price)}
          </button>
        ) : (
          formatPrice(price)
        )}
      </td>
    );
  }

  const amount = text.trim() ? toMinorUnits(text) : null;
  const valid = !text.trim() || amount !== null;
  return (
    <td className="p-2">
      <form
        className="flex items-center gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate(amount);
        }}
      >
        <Input
          autoFocus
          dir="ltr"
          inputMode="decimal"
          aria-label={list === 'retail' ? 'سعر المفرق' : 'سعر الجملة'}
          className={`w-24 ${valid ? '' : 'border-bad'}`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <Button type="submit" variant="secondary" disabled={!valid || save.isPending}>
          حفظ
        </Button>
      </form>
      {save.isError && <div className="text-sm text-bad">{errorText(save.error)}</div>}
    </td>
  );
}
