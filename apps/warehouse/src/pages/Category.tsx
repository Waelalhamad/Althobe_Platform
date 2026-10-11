import {
  Alert,
  Button,
  Card,
  Chip,
  Code,
  ConfirmButton,
  DangerZone,
  EmptyState,
  Field,
  Input,
  NextStep,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { api, type Category, type OptionGroup, type Product } from '../api';
import { errorText, formatPrice, fromMinorUnits } from '../format';
import { PAGES } from '../help';
import { PhotoThumb } from '../photo';
import {
  can,
  categoriesQuery,
  meQuery,
  optionGroupsQuery,
  productsQuery,
  variantsQuery,
} from '../queries';
import { categoryPath, categoryTree } from './Categories';
import { TermHint } from './Help';
import {
  EditableAmount,
  GroupPicker,
  MAX_COMBINATIONS,
  parsePrices,
  PriceField,
  typedPrices,
  useCatalogueRefresh,
  useChosen,
} from './catalogue-parts';

const route = getRouteApi('/app/categories/$categoryId');

const isSize = (g: OptionGroup) => g.key === 'SIZE';

export function CategoryPage() {
  const { categoryId } = route.useParams();
  const { data: user } = useQuery(meQuery);
  const { data: categories = [] } = useQuery(categoriesQuery);
  const { data: groups = [] } = useQuery(optionGroupsQuery);
  const { data: products = [], isLoading: productsLoading } = useQuery(productsQuery(categoryId));
  const category = categories.find((c) => c.id === categoryId);
  const categoryGroups = groups.filter((g) => category?.groupIds.includes(g.id));
  const canWrite = can(user, 'products.write');
  const canPrice = can(user, 'prices.write');

  return (
    <>
      <PageTitle
        intro={PAGES.category}
        actions={
          <Link to="/labels" search={{ categoryId, productId: undefined }}>
            <Button variant="secondary">طباعة الملصقات</Button>
          </Link>
        }
      >
        {category ? categoryPath(categories, category.id) : '…'} <Code>{category?.code}</Code>
      </PageTitle>
      <Link to="/products" className="mb-4 inline-block text-sm text-brand underline">
        ← كل التصنيفات
      </Link>

      {category && !category.isActive && (
        <div className="mb-4">
          <Alert tone="warn">
            هذا التصنيف موقوف: منتجاته لا تُستلم ولا تُباع، ولا تُضاف منتجات جديدة حتى يُعاد تفعيله.
          </Alert>
        </div>
      )}

      {canWrite && category && (
        <CategorySettings category={category} categories={categories} groups={groups} />
      )}
      {canWrite && category?.isActive && (
        <ProductBuilder categoryId={categoryId} groups={categoryGroups} canPrice={canPrice} />
      )}
      <ProductsTable
        groups={categoryGroups}
        products={products}
        loading={productsLoading}
        canPrice={canPrice}
      />
      {products.length > 0 && (
        <NextStep
          action={
            <Link
              to="/labels"
              search={{ categoryId, productId: undefined }}
              className="rounded-lg bg-brand px-4 py-2 font-semibold text-white hover:bg-brand-dark"
            >
              طباعة الملصقات ←
            </Link>
          }
        >
          ضع الأسعار في الجدول (واضغط على المنتج لإضافة صوره)، ثم اطبع ملصقات هذا التصنيف.
        </NextStep>
      )}
      {canWrite && category && <CategoryDanger category={category} />}
    </>
  );
}

/** Stop, restart or delete the category, at the bottom of its page. */
function CategoryDanger({ category }: { category: Category }) {
  const refresh = useCatalogueRefresh();
  const navigate = useNavigate();
  const toast = useToast();
  const update = useMutation({
    mutationFn: async (isActive: boolean) => api.updateCategory(category.id, { isActive }),
    onSuccess: async (_, isActive) => {
      toast(isActive ? 'أُعيد تفعيل التصنيف' : 'أُوقف التصنيف — منتجاته لا تُستلم ولا تُباع');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: async () => api.deleteCategory(category.id),
    onSuccess: async () => {
      toast(`حُذف التصنيف «${category.nameAr}»`);
      await refresh();
      await navigate({ to: '/products' });
    },
  });
  return (
    <DangerZone note="الإيقاف يوقف استلام وبيع كل منتجاته ويحفظ تاريخها، ويمكن إعادته. الحذف فقط لتصنيف لم يدخل أي من منتجاته المخزون، وليس داخله تصنيفات فرعية.">
      <Button
        variant="secondary"
        disabled={update.isPending}
        onClick={() => update.mutate(!category.isActive)}
      >
        {category.isActive ? 'إيقاف التصنيف' : 'إعادة تفعيل التصنيف'}
      </Button>
      <ConfirmButton variant="danger" disabled={remove.isPending} onConfirm={() => remove.mutate()}>
        حذف التصنيف
      </ConfirmButton>
      {(update.isError || remove.isError) && (
        <div className="w-full">
          <Alert>{errorText(update.error ?? remove.error)}</Alert>
        </div>
      )}
    </DangerZone>
  );
}

/**
 * Pick values per option type and the sizes: one product per design, one size each. Designs and
 * sizes that already exist are not made twice.
 */
function ProductBuilder({
  categoryId,
  groups,
  canPrice,
}: {
  categoryId: string;
  groups: OptionGroup[];
  canPrice: boolean;
}) {
  const refresh = useCatalogueRefresh();
  const toast = useToast();
  const { data: variants = [] } = useQuery(variantsQuery({ categoryId }));
  const { chosen, toggle, setAll } = useChosen();
  const [retail, setRetail] = useState('');
  const [wholesale, setWholesale] = useState('');
  const prices = parsePrices(retail, wholesale);

  const designGroups = groups.filter((g) => !isSize(g));
  const sizeGroup = groups.find(isSize);
  const designs = designGroups.reduce<string[][]>(
    (acc, g) => acc.flatMap((combo) => (chosen[g.id] ?? []).map((id) => [...combo, id])),
    [[]],
  );
  const sizes = sizeGroup ? (chosen[sizeGroup.id] ?? []) : [''];
  const total = groups.length ? designs.length * sizes.length : 0;

  // What exists already: "<design value ids>|<size value id>".
  const existing = new Set(
    variants.map((v) => {
      const size = v.options.find((o) => o.groupKey === 'SIZE')?.valueId ?? '';
      const design = v.options.filter((o) => o.groupKey !== 'SIZE').map((o) => o.valueId);
      return `${[...design].sort().join(',')}|${size}`;
    }),
  );
  const already =
    total > MAX_COMBINATIONS
      ? 0
      : designs
          .flatMap((d) => sizes.map((s) => `${[...d].sort().join(',')}|${s}`))
          .filter((k) => existing.has(k)).length;
  const fresh = total - already;

  const generate = useMutation({
    mutationFn: async () => {
      const typed = typedPrices(prices);
      return api.generateProducts(categoryId, {
        selections: groups.map((g) => ({ groupId: g.id, valueIds: chosen[g.id] ?? [] })),
        ...(typed ? { prices: typed } : {}),
      });
    },
    onSuccess: async (result) => {
      toast(
        `أُنشئ ${result.created.length} مقاس في ${result.products.length} منتج — التالي: الأسعار في الجدول بالأسفل`,
      );
      await refresh();
    },
  });

  return (
    <Card>
      <h2 className="mb-1 text-lg font-bold">
        إضافة منتجات <TermHint term="product" />
      </h2>
      <p className="mb-4 text-sm text-ink-muted">
        اختر من كل نوع قيمة أو أكثر، ثم المقاسات. يُنشأ منتج لكل تصميم، وداخله مقاس لكل قياس اخترته،
        ولكل مقاس باركود خاص. الموجود لا يتكرر.
      </p>
      {groups.length === 0 && (
        <Alert tone="warn">لم تُحدَّد أنواع خيارات لهذا التصنيف — اخترها من «تعديل التصنيف».</Alert>
      )}
      <div className="flex flex-col gap-4">
        {groups.map((g) => (
          <GroupPicker
            key={g.id}
            group={g}
            chosen={chosen[g.id] ?? []}
            onToggle={(valueId) => toggle(g.id, valueId)}
            onSetAll={(ids) => setAll(g.id, ids)}
          />
        ))}
      </div>

      {canPrice && (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <PriceField label="سعر المفرق للمنتجات الجديدة" value={retail} onChange={setRetail} />
          <PriceField
            label="سعر الجملة للمنتجات الجديدة"
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
          {fresh > 0 ? `إنشاء ${fresh} مقاس` : 'إنشاء المنتجات'}
        </Button>
        <span className="text-ink-muted">
          {total === 0
            ? 'اختر من كل نوع قيمة واحدة على الأقل'
            : `${designs.length} تصميم × ${sizes.length} مقاس${already ? ` · ${already} موجود مسبقاً` : ''}`}
        </span>
        {total > MAX_COMBINATIONS && (
          <span className="font-medium text-bad">
            الحد {MAX_COMBINATIONS} في المرة الواحدة — قلّل الاختيارات
          </span>
        )}
        {total > 100 && total <= MAX_COMBINATIONS && (
          <span className="font-medium text-warn">عدد كبير — تأكد أنك تصنع كل هذه التصاميم</span>
        )}
        {generate.isSuccess && (
          <span className="text-ok">
            أُنشئ {generate.data.created.length} مقاس في {generate.data.products.length} منتج
          </span>
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

function ProductsTable({
  groups,
  products,
  loading,
  canPrice,
}: {
  groups: OptionGroup[];
  products: Product[];
  loading: boolean;
  canPrice: boolean;
}) {
  const refresh = useCatalogueRefresh();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const designGroups = groups.filter((g) => !isSize(g));
  const valueOf = (p: Product, groupId: string) =>
    p.options.find((o) => o.groupId === groupId)?.value ?? '—';
  const visible = products.filter((p) =>
    Object.entries(filters).every(([groupId, value]) => !value || valueOf(p, groupId) === value),
  );
  const savePrice =
    (product: Product, list: 'retail' | 'wholesale') => async (amount: string | null) => {
      await api.setProductPrices({ productIds: [product.id], [list]: amount });
      await refresh();
    };

  return (
    <Card className="mt-4 overflow-x-auto p-0">
      <div className="flex flex-wrap items-end gap-3 p-3">
        <h2 className="text-lg font-bold">المنتجات</h2>
        {designGroups.map((g) => {
          const values = [...new Set(products.map((p) => valueOf(p, g.id)))];
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
          {visible.length} من {products.length} منتج
        </span>
      </div>
      {canPrice && visible.length > 0 && <BulkProductPrices products={visible} />}
      <table className="w-full">
        <thead className="bg-blush text-sm text-ink-muted">
          <tr>
            <th className="w-16 p-3" />
            <th className="p-3 text-start">التصميم</th>
            <th className="p-3 text-start">
              الرمز <TermHint term="sku" />
            </th>
            <th className="p-3 text-start">
              المقاسات <TermHint term="size" />
            </th>
            <th className="p-3 text-start">
              المفرق <TermHint term="retail" />
            </th>
            <th className="p-3 text-start">
              الجملة <TermHint term="wholesale" />
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((p) => (
            <tr key={p.id} className={`border-t border-stone ${p.isActive ? '' : 'opacity-50'}`}>
              <td className="p-2">
                <PhotoThumb id={p.mainPhotoId} size={44} />
              </td>
              <td className="p-3">
                <Link
                  to="/products/$productId"
                  params={{ productId: p.id }}
                  className="font-medium text-brand"
                >
                  {p.title || p.category.nameAr}
                </Link>
                {!p.isActive && <span className="ms-2 text-sm text-warn">موقوف</span>}
              </td>
              <td className="p-3">
                <Code>{p.code}</Code>
              </td>
              <td className="tabular p-3">{p.variantCount}</td>
              {(['retail', 'wholesale'] as const).map((list) => (
                <td key={list} className="tabular p-3">
                  <EditableAmount
                    text={formatPrice(p.prices[list])}
                    initial={p.prices[list] ? fromMinorUnits(p.prices[list].amount) : ''}
                    label={list === 'retail' ? 'سعر المفرق' : 'سعر الجملة'}
                    editable={canPrice}
                    muted={!p.prices[list]}
                    onSave={savePrice(p, list)}
                  />
                </td>
              ))}
            </tr>
          ))}
          {loading && (
            <tr>
              <td colSpan={6} className="p-6 text-center text-ink-muted">
                جارٍ التحميل…
              </td>
            </tr>
          )}
          {!loading && products.length === 0 && (
            <tr>
              <td colSpan={6} className="p-3">
                <EmptyState title="لا توجد منتجات في هذا التصنيف بعد">
                  في «إضافة منتجات» أعلاه اختر من كل نوع قيمة أو أكثر، ثم المقاسات، واضغط «إنشاء».
                  يُنشأ كل تصميم كمنتج، وداخله مقاساته بباركود لكل مقاس.
                </EmptyState>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}

/** Same price for every product the filters show; an empty field leaves that price alone. */
function BulkProductPrices({ products }: { products: Product[] }) {
  const refresh = useCatalogueRefresh();
  const [retail, setRetail] = useState('');
  const [wholesale, setWholesale] = useState('');
  const typed = typedPrices(parsePrices(retail, wholesale));
  const toast = useToast();

  const apply = useMutation({
    mutationFn: async () =>
      api.setProductPrices({ productIds: products.map((p) => p.id), ...typed }),
    onSuccess: async () => {
      toast(`تم تسعير ${products.length} منتج`);
      setRetail('');
      setWholesale('');
      await refresh();
    },
  });

  return (
    <div className="mx-3 mb-3 flex flex-wrap items-end gap-3 rounded-lg bg-blush p-3">
      <span className="pb-2 font-medium">تسعير المنتجات المعروضة ({products.length}):</span>
      <PriceField label="المفرق" value={retail} onChange={setRetail} />
      <PriceField label="الجملة" value={wholesale} onChange={setWholesale} />
      <ConfirmButton disabled={!typed || apply.isPending} onConfirm={() => apply.mutate()}>
        تعيين السعر لـ {products.length} منتج
      </ConfirmButton>
      {apply.isError && <span className="pb-2 text-bad">{errorText(apply.error)}</span>}
    </div>
  );
}

/** Rename, recode, move in the tree, choose the option types. */
function CategorySettings({
  category,
  categories,
  groups,
}: {
  category: Category;
  categories: Category[];
  groups: OptionGroup[];
}) {
  const refresh = useCatalogueRefresh();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [nameAr, setNameAr] = useState(category.nameAr);
  const [code, setCode] = useState(category.code);
  const [parentId, setParentId] = useState(category.parentId ?? '');
  const [groupIds, setGroupIds] = useState(category.groupIds);
  // Hidden types stay listed only while the category still has them.
  const offered = groups.filter((g) => g.isActive || category.groupIds.includes(g.id));
  // Not under itself or its own branch.
  const inBranch = (id: string) => {
    for (
      let p = categories.find((x) => x.id === id);
      p;
      p = categories.find((x) => x.id === p.parentId)
    ) {
      if (p.id === category.id) return true;
    }
    return false;
  };
  const parents = categoryTree(categories).filter(
    ({ category: c, level }) => level < 2 && !inBranch(c.id),
  );

  const update = useMutation({
    mutationFn: async (patch: Parameters<typeof api.updateCategory>[1]) =>
      api.updateCategory(category.id, patch),
    onSuccess: async () => {
      toast('تم حفظ التصنيف');
      setOpen(false);
      await refresh();
    },
  });

  if (!open) {
    return (
      <div className="mb-4 flex justify-end">
        <Button variant="ghost" onClick={() => setOpen(true)}>
          تعديل التصنيف
        </Button>
      </div>
    );
  }

  return (
    <Card className="mb-4">
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="اسم التصنيف">
          <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} />
        </Field>
        <Field label="الرمز" hint="أول جزء من SKU — للمنتجات الجديدة فقط">
          <Input dir="ltr" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        </Field>
        <Field label="داخل تصنيف">
          <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">— تصنيف رئيسي —</option>
            {parents.map(({ category: c }) => (
              <option key={c.id} value={c.id}>
                {categoryPath(categories, c.id)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="mt-4">
        <span className="text-sm font-medium text-ink-muted">أنواع الخيارات لمنتجاته</span>
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
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          disabled={!nameAr.trim() || !code.trim() || groupIds.length === 0 || update.isPending}
          onClick={() =>
            update.mutate({
              nameAr: nameAr.trim(),
              groupIds,
              ...(code.trim() !== category.code ? { code: code.trim() } : {}),
              ...((parentId || null) !== category.parentId ? { parentId: parentId || null } : {}),
            })
          }
        >
          حفظ
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          إغلاق
        </Button>
      </div>
      {update.isError && (
        <div className="mt-3">
          <Alert>{errorText(update.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
