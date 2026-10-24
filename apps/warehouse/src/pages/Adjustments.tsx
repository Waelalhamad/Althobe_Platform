import { Alert, Button, Card, Chip, EmptyState, PageTitle, useToast } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type AdjustmentRequest } from '../api';
import { ADJUSTMENT_REASON, errorText, formatMoney } from '../format';
import { PAGES } from '../help';
import { can, meQuery } from '../queries';

/**
 * طلبات التعديل (developer report F-03): adjustments past the limit wait here until someone other
 * than the asker accepts or refuses them. Nothing changes in stock or the books before that.
 */
export function AdjustmentsPage() {
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['adjustments', status],
    queryFn: async () => api.adjustmentRequests(status),
  });
  return (
    <>
      <PageTitle intro={PAGES.adjustments}>طلبات التعديل</PageTitle>
      <div className="mb-4 flex gap-2">
        {(
          [
            ['PENDING', 'بانتظار الموافقة'],
            ['APPROVED', 'انوافق عليها'],
            ['REJECTED', 'انرفضت'],
          ] as const
        ).map(([k, label]) => (
          <Chip key={k} selected={status === k} onClick={() => setStatus(k)}>
            {label}
          </Chip>
        ))}
      </div>
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      {!isLoading && rows.length === 0 && (
        <EmptyState title={status === 'PENDING' ? 'ما في طلبات بالانتظار' : 'ما في شي هون'}>
          أي زيادة بالمخزون، أو نقص أكتر من 3 قطع أو 50 $، بتطلع هون لحتى يوافق عليها شخص غير يلي
          طلبها.
        </EmptyState>
      )}
      <div className="flex flex-col gap-3">
        {rows.map((r) => (
          <RequestCard key={r.id} request={r} />
        ))}
      </div>
    </>
  );
}

function RequestCard({ request: r }: { request: AdjustmentRequest }) {
  const { data: user } = useQuery(meQuery);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const mine = user?.id === r.requestedById;
  // The asker decides their own only when nobody else may approve (re-audit 2026-10-24).
  const canDecide =
    can(user, 'inventory.adjust.approve') && (!mine || r.decideAlone) && r.status === 'PENDING';
  const decide = useMutation({
    mutationFn: async (d: 'approve' | 'reject') => api.decideAdjustment(r.id, d, undefined, key),
    onSuccess: async (_x, d) => {
      setKey(crypto.randomUUID());
      toast(d === 'approve' ? 'تمت الموافقة — تعدّل المخزون' : 'انرفض الطلب');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['adjustments'] }),
        queryClient.invalidateQueries({ queryKey: ['balances'] }),
      ]);
    },
  });
  const reason = ADJUSTMENT_REASON[r.reasonCode];
  return (
    <Card className="flex flex-wrap items-center gap-4">
      <div className="min-w-56 flex-1">
        <div className="font-bold">
          {r.variant ? `${r.variant.product.nameAr} · ${r.variant.title}` : '—'}
        </div>
        <div className="text-sm text-ink-muted">
          {r.location} · {reason?.label} (على حساب {reason?.account}){r.note && ` · ${r.note}`}
        </div>
        <div className="text-sm text-ink-muted">
          طلبه {r.requestedBy} · {new Date(r.requestedAt).toLocaleString('ar-SY-u-nu-latn')}
          {r.decidedBy && ` · قرّره ${r.decidedBy}`}
        </div>
      </div>
      <div className={`tabular text-2xl font-bold ${r.delta < 0 ? 'text-bad' : 'text-ok'}`}>
        {r.delta > 0 ? `+${r.delta}` : r.delta}
      </div>
      {r.valueEstimate !== null && (
        <div className="tabular text-ink-muted">≈ {formatMoney(r.valueEstimate)}</div>
      )}
      {canDecide && (
        <div className="flex gap-2">
          <Button disabled={decide.isPending} onClick={() => decide.mutate('approve')}>
            موافقة
          </Button>
          <Button
            variant="secondary"
            disabled={decide.isPending}
            onClick={() => decide.mutate('reject')}
          >
            رفض
          </Button>
        </div>
      )}
      {mine && !r.decideAlone && r.status === 'PENDING' && (
        <span className="text-sm text-ink-muted">بانتظار موافقة شخص تاني</span>
      )}
      {decide.isError && (
        <div className="w-full">
          <Alert>{errorText(decide.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
