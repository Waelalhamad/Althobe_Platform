import { Alert, Button, Card, Chip, Input, PageTitle } from '@althobe/ui/components';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type Move, type OptionGroup } from '../api';
import { errorText, splitList } from '../format';
import { can, meQuery, optionGroupsQuery } from '../queries';

// The owner's lists: القصة، الزر، السحاب، الكم، القماش، اللون، القياس — and any type added later.
// Values are hidden, never deleted, so variants that already use them stay intact.

export function OptionsPage() {
  const { data: user } = useQuery(meQuery);
  const { data: groups = [], isLoading } = useQuery(optionGroupsQuery);
  const editable = can(user, 'products.write');

  return (
    <>
      <PageTitle>خيارات المنتجات</PageTitle>
      <p className="mb-4 text-ink-muted">
        هذه القوائم تُستخدم عند إضافة أصناف المنتج. الترتيب هنا هو ترتيب الوصف في الشاشات والملصقات.
        القيمة المخفية لا تظهر للأصناف الجديدة، والأصناف الموجودة لا تتأثر.
      </p>
      {isLoading && <p className="text-ink-muted">جارٍ التحميل…</p>}
      <div className="flex flex-col gap-4">
        {groups.map((group, i) => (
          <GroupCard
            key={group.id}
            group={group}
            editable={editable}
            first={i === 0}
            last={i === groups.length - 1}
          />
        ))}
      </div>
      {editable && <AddGroup />}
    </>
  );
}

/** One mutation shape for every edit on this page: run it, then refresh everything that shows options. */
function useOptionEdit() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    // A rename changes every variant's description, so every cached list is stale.
    onSuccess: async () => queryClient.invalidateQueries(),
  });
}

function GroupCard({
  group,
  editable,
  first,
  last,
}: {
  group: OptionGroup;
  editable: boolean;
  first: boolean;
  last: boolean;
}) {
  const edit = useOptionEdit();
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [newValues, setNewValues] = useState('');
  const selectedValue = group.values.find((v) => v.id === selected);
  const visible = group.values.filter((v) => editable || v.isActive);

  const moveGroup = (move: Move) =>
    edit.mutate(async () => api.updateOptionGroup(group.id, { move }));

  const addValues = (event: FormEvent) => {
    event.preventDefault();
    const values = splitList(newValues);
    if (!values.length) return;
    // Several at once: "أبيض، أسود، بيج" adds three values.
    edit.mutate(async () => {
      for (const value of values) await api.addOptionValue(group.id, value);
      setNewValues('');
    });
  };

  return (
    <Card className={group.isActive ? '' : 'opacity-60'}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {renaming ? (
          <RenameForm
            initial={group.nameAr}
            onCancel={() => setRenaming(false)}
            onSave={(nameAr) =>
              edit.mutate(async () => {
                await api.updateOptionGroup(group.id, { nameAr });
                setRenaming(false);
              })
            }
          />
        ) : (
          <h2 className="text-lg font-bold">
            {group.nameAr}
            {!group.isActive && <span className="ms-2 text-sm text-warn">(مخفي)</span>}
          </h2>
        )}
        {editable && !renaming && (
          <div className="ms-auto flex flex-wrap gap-1">
            <Button variant="ghost" onClick={() => setRenaming(true)}>
              تعديل الاسم
            </Button>
            <Button
              variant="ghost"
              aria-label="تقديم"
              disabled={first || edit.isPending}
              onClick={() => moveGroup('up')}
            >
              ▲
            </Button>
            <Button
              variant="ghost"
              aria-label="تأخير"
              disabled={last || edit.isPending}
              onClick={() => moveGroup('down')}
            >
              ▼
            </Button>
            <Button
              variant="ghost"
              disabled={edit.isPending}
              onClick={() =>
                edit.mutate(async () =>
                  api.updateOptionGroup(group.id, { isActive: !group.isActive }),
                )
              }
            >
              {group.isActive ? 'إخفاء النوع' : 'إظهار النوع'}
            </Button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {visible.map((v) => (
          <Chip
            key={v.id}
            selected={v.id === selected}
            disabled={!editable}
            className={v.isActive ? '' : 'line-through opacity-60'}
            onClick={() => setSelected(v.id === selected ? null : v.id)}
          >
            {v.valueAr}{' '}
            <span dir="ltr" className="font-mono text-xs opacity-70">
              {v.code}
            </span>
          </Chip>
        ))}
        {visible.length === 0 && <span className="text-ink-muted">لا توجد قيم بعد</span>}
      </div>

      {editable && selectedValue && (
        <ValueActions
          key={selectedValue.id}
          valueAr={selectedValue.valueAr}
          code={selectedValue.code}
          isActive={selectedValue.isActive}
          first={group.values[0]?.id === selectedValue.id}
          last={group.values.at(-1)?.id === selectedValue.id}
          busy={edit.isPending}
          onUpdate={(patch) =>
            edit.mutate(async () => api.updateOptionValue(selectedValue.id, patch))
          }
        />
      )}

      {editable && (
        <form onSubmit={addValues} className="mt-3 flex gap-2">
          <Input
            value={newValues}
            onChange={(e) => setNewValues(e.target.value)}
            placeholder={`إضافة إلى ${group.nameAr} — افصل بين عدة قيم بفاصلة`}
          />
          <Button type="submit" variant="secondary" disabled={!newValues.trim() || edit.isPending}>
            إضافة
          </Button>
        </form>
      )}
      {edit.isError && (
        <div className="mt-3">
          <Alert>{errorText(edit.error)}</Alert>
        </div>
      )}
    </Card>
  );
}

function ValueActions({
  valueAr,
  code,
  isActive,
  first,
  last,
  busy,
  onUpdate,
}: {
  valueAr: string;
  code: string;
  isActive: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  onUpdate: (patch: { valueAr?: string; code?: string; isActive?: boolean; move?: Move }) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [recoding, setRecoding] = useState(false);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-blush p-2">
      {recoding ? (
        <>
          <span className="text-sm">
            رمز SKU (حروف لاتينية وأرقام، حتى 6) — الأصناف الجديدة فقط:
          </span>
          <RenameForm
            initial={code}
            onCancel={() => setRecoding(false)}
            onSave={(next) => {
              onUpdate({ code: next.toUpperCase() });
              setRecoding(false);
            }}
          />
        </>
      ) : renaming ? (
        <RenameForm
          initial={valueAr}
          onCancel={() => setRenaming(false)}
          onSave={(next) => {
            onUpdate({ valueAr: next });
            setRenaming(false);
          }}
        />
      ) : (
        <>
          <span className="font-medium">«{valueAr}»</span>
          <Button variant="secondary" onClick={() => setRenaming(true)}>
            تعديل الاسم
          </Button>
          <Button variant="secondary" onClick={() => setRecoding(true)}>
            الرمز: <span dir="ltr">{code}</span>
          </Button>
          <Button
            variant="secondary"
            aria-label="تقديم"
            disabled={first || busy}
            onClick={() => onUpdate({ move: 'up' })}
          >
            ▶
          </Button>
          <Button
            variant="secondary"
            aria-label="تأخير"
            disabled={last || busy}
            onClick={() => onUpdate({ move: 'down' })}
          >
            ◀
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => onUpdate({ isActive: !isActive })}
          >
            {isActive ? 'إخفاء' : 'إظهار'}
          </Button>
        </>
      )}
    </div>
  );
}

function RenameForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex flex-1 gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (value.trim() && value.trim() !== initial) onSave(value.trim());
        else onCancel();
      }}
    >
      <Input autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      <Button type="submit">حفظ</Button>
      <Button variant="ghost" onClick={onCancel}>
        إلغاء
      </Button>
    </form>
  );
}

function AddGroup() {
  const edit = useOptionEdit();
  const [nameAr, setNameAr] = useState('');
  return (
    <Card className="mt-4">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          edit.mutate(async () => {
            await api.createOptionGroup(nameAr.trim());
            setNameAr('');
          });
        }}
      >
        <span className="font-medium">نوع خيار جديد:</span>
        <div className="min-w-48 flex-1">
          <Input
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            placeholder="مثال: الياقة"
          />
        </div>
        <Button type="submit" disabled={!nameAr.trim() || edit.isPending}>
          إضافة النوع
        </Button>
      </form>
      {edit.isError && (
        <div className="mt-3">
          <Alert>{errorText(edit.error)}</Alert>
        </div>
      )}
    </Card>
  );
}
