import { Alert, Button, Card, Code, Field, Input, PageTitle } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { errorText } from '../format';
import { can, meQuery, productsQuery, variantsQuery } from '../queries';

const route = getRouteApi('/app/products/$productId');

/** "قطني، كتان , صوف" → ['قطني', 'كتان', 'صوف'] — Arabic and Latin commas both work. */
const splitList = (text: string) =>
  text
    .split(/[,،]/)
    .map((s) => s.trim())
    .filter(Boolean);

export function ProductDetailPage() {
  const { productId } = route.useParams();
  const { data: user } = useQuery(meQuery);
  const { data: products = [] } = useQuery(productsQuery);
  const { data: variants = [] } = useQuery(variantsQuery(productId));
  const product = products.find((p) => p.id === productId);

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

      {can(user, 'products.write') && <GenerateVariants productId={productId} />}

      <Card className="mt-4 overflow-x-auto p-0">
        <table className="w-full">
          <thead className="bg-blush text-sm text-ink-muted">
            <tr>
              <th className="p-3 text-start">القماش</th>
              <th className="p-3 text-start">اللون</th>
              <th className="p-3 text-start">القياس</th>
              <th className="p-3 text-start">SKU</th>
              <th className="p-3 text-start">الباركود</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr key={v.id} className="border-t border-stone">
                <td className="p-3">{v.fabric}</td>
                <td className="p-3">{v.colour}</td>
                <td className="tabular p-3">{v.size}</td>
                <td className="p-3">
                  <Code>{v.sku}</Code>
                </td>
                <td className="p-3">
                  <Code>{v.barcode}</Code>
                </td>
              </tr>
            ))}
            {variants.length === 0 && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-ink-muted">
                  لا توجد أصناف بعد — أضف الأقمشة والألوان والقياسات
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
    </>
  );
}

function GenerateVariants({ productId }: { productId: string }) {
  const [fabrics, setFabrics] = useState('');
  const [colours, setColours] = useState('');
  const [sizes, setSizes] = useState('');
  const queryClient = useQueryClient();

  const generate = useMutation({
    mutationFn: async () =>
      api.generateVariants(productId, {
        fabrics: splitList(fabrics),
        colours: splitList(colours),
        sizes: splitList(sizes),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['variants', productId] });
      await queryClient.invalidateQueries({ queryKey: productsQuery.queryKey });
    },
  });

  const count = splitList(fabrics).length * splitList(colours).length * splitList(sizes).length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    generate.mutate();
  };

  return (
    <Card>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <p className="text-sm text-ink-muted">
          افصل بين القيم بفاصلة. يُنشأ صنف لكل تركيبة قماش × لون × قياس، والأصناف الموجودة لا تتكرر.
        </p>
        <div className="grid gap-3 md:grid-cols-3">
          <Field label="الأقمشة">
            <Input
              value={fabrics}
              onChange={(e) => setFabrics(e.target.value)}
              placeholder="قطني، كتان"
            />
          </Field>
          <Field label="الألوان">
            <Input
              value={colours}
              onChange={(e) => setColours(e.target.value)}
              placeholder="أبيض، أسود، بيج"
            />
          </Field>
          <Field label="القياسات">
            <Input
              value={sizes}
              onChange={(e) => setSizes(e.target.value)}
              placeholder="54، 56، 58، 60"
            />
          </Field>
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={count === 0 || generate.isPending}>
            إنشاء {count > 0 ? `${count} ` : ''}صنف
          </Button>
          {generate.isSuccess && (
            <span className="text-ok">
              أُنشئ {generate.data.created.length} صنف جديد
              {generate.data.existing.length > 0 &&
                ` (${generate.data.existing.length} موجود مسبقاً)`}
            </span>
          )}
        </div>
        {generate.isError && <Alert>{errorText(generate.error)}</Alert>}
      </form>
    </Card>
  );
}
