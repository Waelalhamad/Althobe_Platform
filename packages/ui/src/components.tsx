import { useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
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

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
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
      <span className="text-sm font-medium text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-xs text-mauve">{hint}</span>}
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

export function PageTitle({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-bold">{children}</h1>
      {actions && <div className="flex gap-2">{actions}</div>}
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
