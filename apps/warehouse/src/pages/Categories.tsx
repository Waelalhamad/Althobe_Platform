import {
  Alert,
  Button,
  Card,
  Chip,
  Code,
  EmptyState,
  Field,
  Input,
  PageTitle,
  Select,
  useToast,
} from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, type Category } from '../api';
import { errorText } from '../format';
import { PAGES } from '../help';
import { can, categoriesQuery, meQuery, optionGroupsQuery, productsQuery } from '../queries';
import { ProductsTable } from './Category';
import { useCatalogueRefresh } from './catalogue-parts';
import { TermHint } from './Help';

// ADR-011: categories (ثوب، طقم …) in a tree up to three levels; products live inside them.

/** Depth-first, with each category's level (0 at the top). */
export function categoryTree(categories: Category[]): { category: Category; level: number }[] {
  const walk = (parentId: string | null, level: number): { category: Category; level: number }[] =>
    categories
      .filter((c) => c.parentId === parentId)
      .flatMap((category) => [{ category, level }, ...walk(category.id, level + 1)]);
  return walk(null, 0);
}

/** "ثوب › صيفي" — a category with the ones above it. */
export function categoryPath(categories: Category[], id: string): string {
  const names: string[] = [];
  for (
    let c = categories.find((x) => x.id === id);
    c;
    c = categories.find((x) => x.id === c.parentId)
  ) {
    names.unshift(c.nameAr);
  }
  return names.join(' › ');
}

export function CategoriesPage() {
  const { data: user } = useQuery(meQuery);
  const { data: categories = [], isLoading } = useQuery(categoriesQuery);
  const tree = categoryTree(categories);
  const { data: groups = [] } = useQuery(optionGroupsQuery);
  const { data: products = [], isLoading: productsLoading } = useQuery(productsQuery());

  return (
    <>
      <PageTitle intro={PAGES.categories}>
        التصنيفات والمنتجات <TermHint term="category" />
      </PageTitle>
      {can(user, 'products.write') && <CreateCategory categories={categories} />}
      {!isLoading && categories.length === 0 ? (
        <div className="mt-4">
          <EmptyState title="لا توجد تصنيفات بعد">
            التصنيف مجموعة منتجات من نفس النوع، مثل ثوب أو طقم. اكتب اسمه في النموذج أعلاه واضغط
            «إضافة التصنيف»، ثم ستُنقل إلى صفحته لتبني منتجاته.
          </EmptyState>
        </div>
      ) : (
        <Card className="mt-4 overflow-x-auto p-0">
          <table className="w-full">
            <thead className="bg-blush text-sm text-ink-muted">
              <tr>
                <th className="p-3 text-start">التصنيف</th>
                <th className="p-3 text-start">الرمز</th>
                <th className="p-3 text-start">عدد المنتجات</th>
                <th className="p-3 text-start">الحالة</th>
              </tr>
            </thead>
            <tbody>
              {tree.map(({ category: c, level }) => (
                <tr
                  key={c.id}
                  className={`border-t border-stone hover:bg-surface ${c.isActive ? '' : 'opacity-60'}`}
                >
                  <td className="p-3" style={{ paddingInlineStart: `${0.75 + level * 1.5}rem` }}>
                    {level > 0 && <span className="text-ink-muted">↲ </span>}
                    <Link
                      to="/categories/$categoryId"
                      params={{ categoryId: c.id }}
                      className="font-bold text-brand"
                    >
                      {c.nameAr}
                    </Link>
                  </td>
                  <td className="p-3">
                    <Code>{c.code}</Code>
                  </td>
                  <td className="tabular p-3">{c.productCount}</td>
                  <td className="p-3 text-sm">
                    {c.isActive ? 'فعّال' : <span className="text-warn">موقوف</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {products.length > 0 && (
        <ProductsTable
          groups={groups}
          products={products}
          loading={productsLoading}
          canPrice={can(user, 'prices.write')}
          storageKey="all"
          showCategory
        />
      )}
    </>
  );
}

function CreateCategory({ categories }: { categories: Category[] }) {
  const { data: groups = [] } = useQuery(optionGroupsQuery);
  const refresh = useCatalogueRefresh();
  const navigate = useNavigate();
  const toast = useToast();
  const [nameAr, setNameAr] = useState('');
  const [parentId, setParentId] = useState('');
  // null = untouched: the parent's types, or every active type at the top level.
  const [picked, setPicked] = useState<string[] | null>(null);
  const parent = categories.find((c) => c.id === parentId);
  const groupIds = picked ?? parent?.groupIds ?? groups.filter((g) => g.isActive).map((g) => g.id);
  // Three levels at most: a category two levels down takes no sub-categories.
  const parents = categoryTree(categories).filter(({ level }) => level < 2);

  const create = useMutation({
    mutationFn: async () =>
      api.createCategory({ nameAr: nameAr.trim(), groupIds, ...(parentId ? { parentId } : {}) }),
    onSuccess: async (category) => {
      toast(`تم إنشاء التصنيف «${category.nameAr}» — التالي: اختر قيم منتجاته بالأسفل`);
      await refresh();
      await navigate({ to: '/categories/$categoryId', params: { categoryId: category.id } });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    create.mutate();
  };

  const toggle = (id: string) =>
    setPicked(groupIds.includes(id) ? groupIds.filter((g) => g !== id) : [...groupIds, id]);

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <h2 className="font-bold">تصنيف جديد</h2>
        <div className="grid items-start gap-3 md:grid-cols-2">
          <Field label="اسم التصنيف" hint="مثل ثوب أو طقم. رمزه في SKU يُنشأ تلقائياً من الاسم">
            <Input
              required
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              placeholder="ثوب، طقم…"
            />
          </Field>
          <Field
            label="داخل تصنيف (اختياري)"
            hint="اتركه «تصنيف رئيسي»، أو اختر تصنيفاً ليكون هذا فرعاً منه (ثوب ← صيفي)"
          >
            <Select
              value={parentId}
              onChange={(e) => {
                setParentId(e.target.value);
                setPicked(null);
              }}
            >
              <option value="">— تصنيف رئيسي —</option>
              {parents.map(({ category: c }) => (
                <option key={c.id} value={c.id}>
                  {categoryPath(categories, c.id)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div>
          <span className="text-sm font-medium text-ink-muted">
            أنواع الخيارات لمنتجات هذا التصنيف (يمكن تعديلها لاحقاً)
          </span>
          <div className="mt-1 flex flex-wrap gap-2">
            {groups
              .filter((g) => g.isActive)
              .map((g) => (
                <Chip key={g.id} selected={groupIds.includes(g.id)} onClick={() => toggle(g.id)}>
                  {g.nameAr}
                </Chip>
              ))}
          </div>
        </div>
        <div>
          <Button
            type="submit"
            disabled={create.isPending || !nameAr.trim() || groupIds.length === 0}
          >
            إضافة التصنيف
          </Button>
        </div>
      </form>
      {create.isError && (
        <div className="mt-3">
          <Alert>{errorText(create.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
