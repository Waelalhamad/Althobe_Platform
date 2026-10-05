import { Alert, Button, Card, Chip, Code, ConfirmButton, PageTitle } from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Product, type Variant } from '../api';
import { choosableValues, errorText, formatPrice, fromMinorUnits, valueLabel } from '../format';
import { can, categoriesQuery, meQuery, optionGroupsQuery, productQuery } from '../queries';
import { EditableAmount, useCatalogueRefresh } from './catalogue-parts';
import { ProductPhotos } from './ProductPhotos';

const route = getRouteApi('/app/products/$productId');

/** One design (ADR-011): its photos, its price, and its sizes with their barcodes. */
export function ProductDetailPage() {
  const { productId } = route.useParams();
  const { data: user } = useQuery(meQuery);
  const { data } = useQuery(productQuery(productId));
  const canWrite = can(user, 'products.write');
  const canPrice = can(user, 'prices.write');
  if (!data) return <p className="text-ink-muted">جارٍ التحميل…</p>;
  const { product, variants } = data;

  return (
    <>
      <PageTitle
        actions={
          <Link to="/labels" search={{ categoryId: product.category.id, productId }}>
            <Button variant="secondary">طباعة الملصقات</Button>
          </Link>
        }
      >
        {product.category.nameAr} · {product.title} <Code>{product.code}</Code>
      </PageTitle>
      <Link
        to="/categories/$categoryId"
        params={{ categoryId: product.category.id }}
        className="mb-4 inline-block text-sm text-brand underline"
      >
        ← {product.category.nameAr}
      </Link>

      {!product.isActive && (
        <div className="mb-4">
          <Alert tone="warn">هذا المنتج موقوف: لا يُستلم ولا يُباع حتى يُعاد تفعيله.</Alert>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <PricesCard product={product} canPrice={canPrice} />
        {canWrite && <ProductActions product={product} />}
      </div>
      <ProductPhotos productId={productId} canWrite={canWrite} />
      <SizesTable variants={variants} canWrite={canWrite} canPrice={canPrice} />
      {canWrite && product.isActive && <AddSizes product={product} variants={variants} />}
    </>
  );
}

function PricesCard({ product, canPrice }: { product: Product; canPrice: boolean }) {
  const refresh = useCatalogueRefresh();
  const save = (list: 'retail' | 'wholesale') => async (amount: string | null) => {
    await api.setProductPrices({ productIds: [product.id], [list]: amount });
    await refresh();
  };
  return (
    <Card>
      <h2 className="mb-3 text-lg font-bold">السعر (لكل المقاسات)</h2>
      <div className="flex flex-wrap gap-8">
        {(['retail', 'wholesale'] as const).map((list) => (
          <div key={list}>
            <div className="text-sm text-ink-muted">{list === 'retail' ? 'المفرق' : 'الجملة'}</div>
            <div className="tabular text-2xl font-bold">
              <EditableAmount
                text={formatPrice(product.prices[list])}
                initial={product.prices[list] ? fromMinorUnits(product.prices[list].amount) : ''}
                label={list === 'retail' ? 'سعر المفرق' : 'سعر الجملة'}
                editable={canPrice}
                muted={!product.prices[list]}
                onSave={save(list)}
              />
            </div>
          </div>
        ))}
      </div>
      {canPrice && (
        <p className="mt-2 text-sm text-ink-muted">
          اضغط على السعر لتعديله. لمقاس بسعر مختلف، عدّله في جدول المقاسات.
        </p>
      )}
    </Card>
  );
}

function ProductActions({ product }: { product: Product }) {
  const refresh = useCatalogueRefresh();
  const navigate = useNavigate();
  const toggle = useMutation({
    mutationFn: async () => api.setProductActive(product.id, !product.isActive),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: async () => api.deleteProduct(product.id),
    onSuccess: async () => {
      await refresh();
      await navigate({
        to: '/categories/$categoryId',
        params: { categoryId: product.category.id },
      });
    },
  });
  return (
    <Card>
      <h2 className="mb-3 text-lg font-bold">المنتج</h2>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={toggle.isPending} onClick={() => toggle.mutate()}>
          {product.isActive ? 'إيقاف المنتج' : 'إعادة تفعيل المنتج'}
        </Button>
        <ConfirmButton
          variant="danger"
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        >
          حذف المنتج
        </ConfirmButton>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        الحذف ممكن فقط إذا لم يدخل المخزون أبداً؛ غير ذلك أوقفه.
      </p>
      {(toggle.isError || remove.isError) && (
        <div className="mt-3">
          <Alert>{errorText(toggle.error ?? remove.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

function SizesTable({
  variants,
  canWrite,
  canPrice,
}: {
  variants: Variant[];
  canWrite: boolean;
  canPrice: boolean;
}) {
  const refresh = useCatalogueRefresh();
  const [error, setError] = useState<unknown>(null);
  const run = (action: () => Promise<unknown>) => async () => {
    setError(null);
    try {
      await action();
      await refresh();
    } catch (e) {
      setError(e);
    }
  };
  const savePrice = (v: Variant, list: 'retail' | 'wholesale') => async (amount: string | null) => {
    await api.setPrices({ variantIds: [v.id], [list]: amount });
    await refresh();
  };

  return (
    <Card className="mt-4 overflow-x-auto p-0">
      <h2 className="p-3 text-lg font-bold">المقاسات</h2>
      <table className="w-full">
        <thead className="bg-blush text-sm text-ink-muted">
          <tr>
            <th className="p-3 text-start">المقاس</th>
            <th className="p-3 text-start">SKU</th>
            <th className="p-3 text-start">الباركود</th>
            <th className="p-3 text-start">المفرق</th>
            <th className="p-3 text-start">الجملة</th>
            {canWrite && <th className="p-3" />}
          </tr>
        </thead>
        <tbody>
          {variants.map((v) => (
            <tr key={v.id} className={`border-t border-stone ${v.isActive ? '' : 'opacity-50'}`}>
              <td className="tabular p-3 text-lg font-bold">{v.size ?? '—'}</td>
              <td className="p-3">
                <Code>{v.sku}</Code>
              </td>
              <td className="p-3">
                <Code>{v.barcode}</Code>
              </td>
              {(['retail', 'wholesale'] as const).map((list) => (
                <td key={list} className="tabular p-3">
                  <EditableAmount
                    // A size's own price is marked ★; the product's price shows muted.
                    text={formatPrice(v.prices[list]) + (v.ownPrices[list] ? ' ★' : '')}
                    initial={v.prices[list] ? fromMinorUnits(v.prices[list].amount) : ''}
                    label={list === 'retail' ? 'سعر المفرق' : 'سعر الجملة'}
                    editable={canPrice}
                    muted={!v.ownPrices[list]}
                    onSave={savePrice(v, list)}
                  />
                </td>
              ))}
              {canWrite && (
                <td className="p-2 text-end">
                  <Button
                    variant="ghost"
                    onClick={() => void run(async () => api.setVariantActive(v.id, !v.isActive))()}
                  >
                    {v.isActive ? 'إيقاف' : 'تفعيل'}
                  </Button>
                  <ConfirmButton
                    variant="ghost"
                    onConfirm={() => void run(async () => api.deleteVariant(v.id))()}
                  >
                    حذف
                  </ConfirmButton>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {canPrice && (
        <p className="p-3 text-sm text-ink-muted">
          ★ سعر خاص بهذا المقاس. احذف الرقم واحفظ ليعود إلى سعر المنتج.
        </p>
      )}
      {error !== null && (
        <div className="p-3">
          <Alert>{errorText(error)}</Alert>
        </div>
      )}
    </Card>
  );
}

/** More sizes for this design: the same product, a new barcode per size. */
function AddSizes({ product, variants }: { product: Product; variants: Variant[] }) {
  const refresh = useCatalogueRefresh();
  const { data: groups = [] } = useQuery(optionGroupsQuery);
  const { data: categories = [] } = useQuery(categoriesQuery);
  const [chosen, setChosen] = useState<string[]>([]);
  const category = categories.find((c) => c.id === product.category.id);
  const sizeGroup = groups.find((g) => g.key === 'SIZE' && category?.groupIds.includes(g.id));
  const have = new Set(
    variants.flatMap((v) => v.options.filter((o) => o.groupKey === 'SIZE').map((o) => o.valueId)),
  );

  const add = useMutation({
    mutationFn: async () =>
      api.generateProducts(product.category.id, {
        selections: [
          ...product.options.map((o) => ({ groupId: o.groupId, valueIds: [o.valueId] })),
          { groupId: sizeGroup!.id, valueIds: chosen },
        ],
      }),
    onSuccess: async () => {
      setChosen([]);
      await refresh();
    },
  });

  if (!sizeGroup) return null;
  const free = choosableValues(sizeGroup).filter((v) => !have.has(v.id));
  return (
    <Card className="mt-4">
      <h2 className="mb-3 text-lg font-bold">إضافة مقاسات</h2>
      {free.length === 0 ? (
        <p className="text-ink-muted">كل المقاسات موجودة. أضف قياساً جديداً من صفحة الخيارات.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {free.map((v) => (
            <Chip
              key={v.id}
              selected={chosen.includes(v.id)}
              onClick={() =>
                setChosen((c) => (c.includes(v.id) ? c.filter((x) => x !== v.id) : [...c, v.id]))
              }
            >
              {valueLabel(sizeGroup, v)}
            </Chip>
          ))}
          <Button disabled={!chosen.length || add.isPending} onClick={() => add.mutate()}>
            إضافة {chosen.length || ''} مقاس
          </Button>
        </div>
      )}
      {add.isError && (
        <div className="mt-3">
          <Alert>{errorText(add.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
