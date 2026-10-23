import {
  Alert,
  Button,
  Card,
  Chip,
  ConfirmButton,
  Input,
  NextStep,
  PageTitle,
  useToast,
} from '@althobe/ui/components';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, type Move, type OptionGroup, type OptionValue } from '../api';
import { errorText, splitList, valueLabel } from '../format';
import { PAGES } from '../help';
import { can, meQuery, optionGroupsQuery } from '../queries';
import { TermHint } from './Help';

// The owner's lists: القصة، الزر، السحاب، الكم، القماش، اللون، القياس — and any type added later.
// Hidden values stay on existing products; a value or type that no product uses can be deleted.

export function OptionsPage() {
  const { data: user } = useQuery(meQuery);
  const { data: groups = [], isLoading } = useQuery(optionGroupsQuery);
  const editable = can(user, 'products.write');

  return (
    <>
      <PageTitle intro={PAGES.options}>
        خيارات المنتجات <TermHint term="option" />
      </PageTitle>
      <p className="mb-4 text-sm text-ink-muted">
        اضغط على أي قيمة لتعديلها أو ترتيبها أو إضافة تفاصيل لها <TermHint term="detail" /> أو
        إخفائها <TermHint term="stopped" /> أو حذفها <TermHint term="deleted" />. الترتيب هنا هو
        ترتيب الوصف في الشاشات والملصقات.
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
      {editable && groups.length > 0 && (
        <NextStep
          action={
            <Link
              to="/products"
              className="rounded-lg bg-brand px-4 py-2 font-semibold text-white hover:bg-brand-dark"
            >
              التصنيفات ←
            </Link>
          }
        >
          بعد تجهيز القوائم، أنشئ التصنيفات (ثوب، طقم) وابنِ منتجاتها.
        </NextStep>
      )}
    </>
  );
}

/** One mutation shape for every edit on this page: run it, then refresh everything that shows options. */
function useOptionEdit() {
  const queryClient = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    // A rename changes every variant's description, so every cached list is stale.
    onSuccess: async () => {
      toast('تم الحفظ');
      await queryClient.invalidateQueries();
    },
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
  const siblingsOf = (value: OptionValue) =>
    group.values.filter((v) => v.parentId === value.parentId);
  const depthOf = (value: OptionValue) => {
    let depth = 1;
    for (let p = value.parentId; p; depth++)
      p = group.values.find((v) => v.id === p)?.parentId ?? null;
    return depth;
  };

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
            {group.key !== 'SIZE' && (
              <ConfirmButton
                variant="ghost"
                disabled={edit.isPending}
                onConfirm={() => edit.mutate(async () => api.deleteOptionGroup(group.id))}
              >
                حذف النوع
              </ConfirmButton>
            )}
          </div>
        )}
      </div>

      {/* Top-level values, then a row of details under each value that has them. */}
      {[null, ...visible.map((v) => v.id)].map((parentId) => {
        const row = visible.filter((v) => v.parentId === parentId);
        if (parentId !== null && row.length === 0) return null;
        const heading = parentId && group.values.find((v) => v.id === parentId);
        return (
          <div
            key={parentId ?? 'top'}
            className={`flex flex-wrap items-center gap-2 ${heading ? 'mt-2 ps-4' : ''}`}
          >
            {heading && (
              <span className="text-sm text-ink-muted">↲ تفاصيل {valueLabel(group, heading)}:</span>
            )}
            {row.map((v) => (
              <Chip
                key={v.id}
                selected={v.id === selected}
                disabled={!editable}
                className={v.isActive ? '' : 'line-through opacity-60'}
                onClick={() => setSelected(v.id === selected ? null : v.id)}
              >
                {v.valueAr}{' '}
                <span dir="ltr" className="font-mono text-xs text-ink-muted">
                  {v.code}
                </span>
              </Chip>
            ))}
            {parentId === null && row.length === 0 && (
              <span className="text-ink-muted">
                لا توجد قيم بعد — اكتبها في الحقل أدناه، وافصل بين عدة قيم بفاصلة.
              </span>
            )}
          </div>
        );
      })}

      {editable && selectedValue && (
        <ValueActions
          key={selectedValue.id}
          valueAr={selectedValue.valueAr}
          code={selectedValue.code}
          isActive={selectedValue.isActive}
          first={siblingsOf(selectedValue)[0]?.id === selectedValue.id}
          last={siblingsOf(selectedValue).at(-1)?.id === selectedValue.id}
          busy={edit.isPending}
          onUpdate={(patch) =>
            edit.mutate(async () => api.updateOptionValue(selectedValue.id, patch))
          }
          onDelete={() =>
            edit.mutate(async () => {
              await api.deleteOptionValue(selectedValue.id);
              setSelected(null);
            })
          }
          // Three levels at most: a detail of a detail takes no further details.
          onAddDetails={
            depthOf(selectedValue) < 3
              ? (names) =>
                  edit.mutate(async () => {
                    for (const name of names) {
                      await api.addOptionValue(group.id, name, selectedValue.id);
                    }
                  })
              : undefined
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
  onAddDetails,
  isActive,
  first,
  last,
  busy,
  onUpdate,
  onDelete,
}: {
  valueAr: string;
  code: string;
  isActive: boolean;
  first: boolean;
  last: boolean;
  busy: boolean;
  onUpdate: (patch: { valueAr?: string; code?: string; isActive?: boolean; move?: Move }) => void;
  onAddDetails: ((names: string[]) => void) | undefined;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [details, setDetails] = useState('');
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
          <ConfirmButton variant="danger" disabled={busy} onConfirm={onDelete}>
            حذف
          </ConfirmButton>
          {onAddDetails && (
            <form
              className="flex min-w-64 flex-1 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                const names = splitList(details);
                if (names.length) {
                  onAddDetails(names);
                  setDetails('');
                }
              }}
            >
              <Input
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={`تفاصيل تحت «${valueAr}»، مثل: مونس، مشخط، ساده`}
              />
              <Button type="submit" variant="secondary" disabled={!details.trim() || busy}>
                إضافة تفاصيل
              </Button>
            </form>
          )}
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
