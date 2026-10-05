import { Alert, Button, Card, Chip, Field, Input, PageTitle } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText } from '../format';
import { PhotoThumb } from '../photo';
import { can, meQuery, optionGroupsQuery, productsQuery } from '../queries';

export function ProductsPage() {
  const { data: user } = useQuery(meQuery);
  const { data: products = [], isLoading } = useQuery(productsQuery);

  return (
    <>
      <PageTitle>المنتجات</PageTitle>
      {can(user, 'products.write') && <CreateProduct />}
      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full text-start">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="w-16 p-3" />
              <th className="p-3 text-start">الرمز</th>
              <th className="p-3 text-start">الاسم</th>
              <th className="p-3 text-start">عدد الأصناف</th>
              <th className="p-3 text-start">الحالة</th>
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr
                key={p.id}
                className={`border-t border-stone hover:bg-surface ${p.isActive ? '' : 'opacity-60'}`}
              >
                <td className="p-2">
                  <PhotoThumb id={p.mainPhotoId} size={44} />
                </td>
                <td className="p-3">
                  <Link
                    to="/products/$productId"
                    params={{ productId: p.id }}
                    className="font-mono text-brand"
                    dir="ltr"
                  >
                    {p.code}
                  </Link>
                </td>
                <td className="p-3 font-medium">{p.nameAr}</td>
                <td className="tabular p-3">{p.variantCount}</td>
                <td className="p-3 text-sm">{p.isActive ? 'فعّال' : 'موقوف'}</td>
              </tr>
            ))}
            {isLoading && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-ink-muted">
                  جارٍ التحميل…
                </td>
              </tr>
            )}
            {!isLoading && products.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-ink-muted">
                  لا توجد منتجات بعد
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function CreateProduct() {
  const { data: groups = [] } = useQuery(optionGroupsQuery);
  const active = groups.filter((g) => g.isActive);
  const [nameAr, setNameAr] = useState('');
  // null = untouched: every active type, which is what most products use.
  const [picked, setPicked] = useState<string[] | null>(null);
  const groupIds = picked ?? active.map((g) => g.id);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const create = useMutation({
    // The code is generated (P-0001, P-0002, …).
    mutationFn: async () => api.createProduct({ nameAr, groupIds }),
    onSuccess: async (product) => {
      await queryClient.invalidateQueries({ queryKey: productsQuery.queryKey });
      await navigate({ to: '/products/$productId', params: { productId: product.id } });
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
        <div className="max-w-xl">
          <Field label="اسم المنتج" hint="رمز المنتج يُنشأ تلقائياً (P-0001، P-0002…)">
            <Input
              required
              value={nameAr}
              onChange={(e) => setNameAr(e.target.value)}
              placeholder="ثوب، كلابية…"
            />
          </Field>
        </div>
        <div>
          <span className="text-sm font-medium text-ink-muted">
            أنواع الخيارات لهذا المنتج (يمكن تعديلها لاحقاً)
          </span>
          <div className="mt-1 flex flex-wrap gap-2">
            {active.map((g) => (
              <Chip key={g.id} selected={groupIds.includes(g.id)} onClick={() => toggle(g.id)}>
                {g.nameAr}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <Button type="submit" disabled={create.isPending || groupIds.length === 0}>
            إضافة منتج
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
