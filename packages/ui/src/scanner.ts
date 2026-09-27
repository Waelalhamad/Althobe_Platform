import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';

/**
 * Keyboard-wedge barcode scanners type the digits and press Enter (docs/barcode.md).
 * This keeps one scan input focused so scans always land in it, and gives the focus back after
 * any other field (quantity, cost) is done with.
 *
 *   const scan = useScanInput((code) => submit(code));
 *   <input {...scan.inputProps} />
 */
export function useScanInput(onScan: (code: string) => void, { enabled = true } = {}) {
  const ref = useRef<HTMLInputElement>(null);
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  const focus = useCallback(() => {
    if (enabled) ref.current?.focus({ preventScroll: true });
  }, [enabled]);

  // Reclaim focus whenever nothing else that takes typing is focused.
  useEffect(() => {
    if (!enabled) return;
    focus();
    const reclaim = () => {
      setTimeout(() => {
        const active = document.activeElement;
        const typing =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active instanceof HTMLSelectElement;
        if (!typing) focus();
      }, 0);
    };
    document.addEventListener('focusout', reclaim);
    document.addEventListener('click', reclaim);
    return () => {
      document.removeEventListener('focusout', reclaim);
      document.removeEventListener('click', reclaim);
    };
  }, [enabled, focus]);

  const inputProps = {
    ref,
    dir: 'ltr' as const,
    inputMode: 'numeric' as const,
    autoComplete: 'off',
    spellCheck: false,
    onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const code = toAsciiDigits(event.currentTarget.value.trim());
      event.currentTarget.value = '';
      if (code) onScanRef.current(code);
    },
  };

  return { inputProps, focus };
}

/** A fresh id per physical scan, so a double trigger pull is recognised as one scan. */
export function newScanId(): string {
  return crypto.randomUUID();
}

/**
 * A keyboard-wedge scanner types through the active Windows keyboard layout. Under an Arabic layout
 * some scanners produce Arabic-Indic (٠-٩) or Persian (۰-۹) digits; barcodes are ASCII.
 */
export function toAsciiDigits(text: string): string {
  return text.replace(/[\u0660-\u0669\u06F0-\u06F9]/g, (d) => String((d.charCodeAt(0) & 0xf) % 10));
}
