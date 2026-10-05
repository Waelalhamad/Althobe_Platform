import {
  Alert,
  Button,
  Card,
  Chip,
  Code,
  Field,
  Input,
  PageTitle,
  Select,
} from '@althobe/ui/components';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api, type Category } from '../api';
import { errorText } from '../format';
import { can, categoriesQuery, meQuery, optionGroupsQuery } from '../queries';
import { useCatalogueRefresh } from './catalogue-parts';

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

  return (
    <>
      <PageTitle>المنتجات</PageTitle>
      <p className="mb-4 text-ink-muted">
        اختر تصنيفاً لترى منتجاته أو تضيف منتجات جديدة. كل منتج تصميم واحد، ومقاساته داخله.
      </p>
      {can(user, 'products.write') && <CreateCategory categories={categories} />}
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
                <td className="p-3 text-sm">{c.isActive ? 'فعّال' : 'موقوف'}</td>
              </tr>
            ))}
            {!isLoading && categories.length === 0 && (
              <tr>
                <td colSpan={4} className="p-6 text-center text-ink-muted">
                  لا توجد تصنيفات بعد — أضف أول تصنيف (مثل ثوب)
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function CreateCategory({ categories }: { categories: Category[] }) {
  const { data: groups = [] } = useQuery(optionGroupsQuery);
  const refresh = useCatalogueRefresh();
  const navigate = useNavigate();
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
        <div className="grid items-end gap-3 md:grid-cols-2">
          <Field label="اسم التصنيف" hint="الرمز يُقترح تلقائياً ويمكن تعديله">
            <Input
              required
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              placeholder="ثوب، طقم…"
            />
          </Field>
          <Field label="داخل تصنيف (اختياري)">
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
