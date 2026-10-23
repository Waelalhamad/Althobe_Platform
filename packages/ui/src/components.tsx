import { createContext, useCallback, useContext, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  SelectHTMLAttributes,
} from 'react';

// Small, RTL-safe building blocks. Logical properties only (ms-/me-/ps-/pe-), never left/right.

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';

const variants: Record<Variant, string> = {
  primary: 'bg-brand text-white hover:bg-brand-dark disabled:bg-mauve',
  secondary: 'bg-white text-ink border border-stone hover:bg-blush disabled:text-mauve',
  danger: 'bg-white text-bad border border-bad hover:bg-bad-soft disabled:opacity-50',
  ghost: 'text-ink-muted hover:bg-blush',
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'md' | 'lg' }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed',
        size === 'lg' ? 'min-h-14 px-6 text-lg' : 'min-h-10 px-4',
        variants[variant],
        className,
      )}
    />
  );
}

// React 19 passes `ref` as an ordinary prop; it reaches the <input> through the spread.
export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      // Number fields otherwise render Arabic-Indic digits under lang="ar"; the app uses Latin
      // digits everywhere (tables, barcodes, SKUs).
      lang={props.type === 'number' ? 'en' : undefined}
      {...props}
      className={cx(
        'min-h-10 w-full rounded-lg border border-stone bg-white px-3 outline-none focus:border-brand focus:ring-2 focus:ring-blush',
        className,
      )}
    />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cx(
        'min-h-10 w-full rounded-lg border border-stone bg-white px-3 outline-none focus:border-brand',
        className,
      )}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-semibold text-ink">{label}</span>
      {children}
      {hint && <span className="text-sm text-ink-muted">{hint}</span>}
    </label>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx('rounded-xl border border-stone bg-white p-4 shadow-sm', className)}>
      {children}
    </div>
  );
}

export function Alert({
  tone = 'bad',
  children,
}: {
  tone?: 'bad' | 'ok' | 'warn';
  children: ReactNode;
}) {
  const tones = {
    bad: 'bg-bad-soft text-bad',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
  };
  return <div className={cx('rounded-lg px-4 py-3 font-medium', tones[tone])}>{children}</div>;
}

/** The page's name, its actions, and one sentence on what the page is for. */
export function PageTitle({
  children,
  actions,
  intro,
}: {
  children: ReactNode;
  actions?: ReactNode;
  intro?: ReactNode;
}) {
  return (
    <div className="mb-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{children}</h1>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      {intro && <p className="mt-1 max-w-3xl text-ink-muted">{intro}</p>}
    </div>
  );
}

/** A tappable choice; selected chips are filled. Finger-sized for tablets in the warehouse. */
export function Chip({
  selected = false,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      {...props}
      className={cx(
        'min-h-10 rounded-full border px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        selected
          ? 'border-brand bg-brand text-white'
          : 'border-stone bg-white text-ink hover:bg-blush',
        className,
      )}
    />
  );
}

/** Barcodes and SKUs read left-to-right even inside RTL text. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <span dir="ltr" className="tabular font-mono text-sm">
      {children}
    </span>
  );
}

/** Irreversible actions take two clicks: the first arms, the second confirms. */
export function ConfirmButton({
  onConfirm,
  children,
  ...props
}: Omit<Parameters<typeof Button>[0], 'onClick'> & { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  return (
    <Button
      {...props}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
          setTimeout(() => setArmed(false), 4000);
        }
      }}
    >
      {armed ? 'اضغط مرة أخرى للتأكيد' : children}
    </Button>
  );
}

/** What an empty list is for, and the one thing to do about it. */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-mauve bg-white px-6 py-8 text-center">
      <div className="text-3xl" aria-hidden>
        ✦
      </div>
      <h3 className="text-lg font-bold">{title}</h3>
      {children && <p className="max-w-xl text-ink-muted">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** The usual next step after this page, at its bottom. */
export function NextStep({ children, action }: { children: ReactNode; action: ReactNode }) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-blush px-4 py-3 print:hidden">
      <span className="font-medium">
        <span className="text-brand">التالي:</span> {children}
      </span>
      {action}
    </div>
  );
}

/** Stop and delete live here, at the bottom of a page, always with the same explanation. */
export function DangerZone({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mt-8 rounded-xl border border-bad/40 bg-white p-4">
      <h2 className="mb-1 font-bold text-bad">إيقاف وحذف</h2>
      <p className="mb-3 text-sm text-ink-muted">
        {note ??
          'الإيقاف يخفيه من الاستخدام الجديد ويحفظ تاريخه، ويمكن إعادته. الحذف نهائي، ومسموح فقط لما لم يدخل المخزون أبداً.'}
      </p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/** A small "؟" that opens a short explanation. <details> works with touch and keyboards. */
export function Hint({ children, label = 'ما هذا؟' }: { children: ReactNode; label?: string }) {
  return (
    <details className="relative inline-block align-middle">
      <summary
        aria-label={label}
        className="inline-flex size-5 cursor-pointer list-none items-center justify-center rounded-full bg-blush text-xs font-bold text-brand [&::-webkit-details-marker]:hidden"
      >
        ؟
      </summary>
      <div className="absolute start-0 top-6 z-20 w-64 rounded-lg border border-stone bg-white p-3 text-sm font-medium text-ink shadow-lg">
        {children}
      </div>
    </details>
  );
}

// ─── Toasts: what just happened, and what is next ─────────────────────────────────────────────

interface ToastItem {
  id: number;
  text: ReactNode;
}

const ToastContext = createContext<(text: ReactNode) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const show = useCallback((text: ReactNode) => {
    const id = Date.now() + Math.random();
    setItems((list) => [...list, { id, text }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), 6000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 print:hidden"
      >
        {items.map((t) => (
          <button
            type="button"
            key={t.id}
            onClick={() => setItems((list) => list.filter((x) => x.id !== t.id))}
            className="max-w-lg rounded-xl bg-ok px-5 py-3 text-start font-medium text-white shadow-lg"
          >
            ✓ {t.text}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Shows a success message for a few seconds. */
export function useToast() {
  return useContext(ToastContext);
}
