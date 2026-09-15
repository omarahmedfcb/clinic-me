import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { cx } from "../lib/cx.ts";

/**
 * Toasts.
 *
 * Hand-rolled rather than Radix Toast: there is no focus to trap and no dialog semantics to get
 * right, so the whole primitive is a positioned list plus `role="status"`, and a dependency would
 * buy nothing. The live region is `polite`, never `assertive` — a saved-successfully message must
 * not interrupt a doctor mid-sentence in a screen reader.
 *
 * Positioned with `end-0` -- Tailwind's utility for `inset-inline-end` -- so toasts stack in the
 * top-LEFT corner in Arabic and the top-RIGHT in English, always on the side the eye leaves the
 * line on. Not `inset-inline-end-*`: that spelling is not a utility and generates no rule.
 */

export type ToastTone = "success" | "error" | "info";

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  push: (tone: ToastTone, message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error("useToast must be used inside <ToastProvider>.");
  return api;
}

const TONES: Record<ToastTone, string> = {
  success: "bg-success-soft border-success/30 text-success",
  error: "bg-danger-soft border-danger/30 text-danger",
  info: "bg-info-soft border-info/30 text-info",
};

const ICONS: Record<ToastTone, ReactNode> = {
  success: <path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />,
  error: <path d="M8 4.5v4.5M8 11.4v.1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />,
  info: <path d="M8 7.2v4.3M8 4.6v.1" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />,
};

let nextId = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const push = useCallback((tone: ToastTone, message: string) => {
    const id = nextId++;
    setItems((current) => [...current, { id, tone, message }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4000);
  }, []);

  const api = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed top-0 end-0 z-50 flex flex-col gap-2 p-4"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cx(
              "pointer-events-auto flex items-center gap-2.5 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg",
              "animate-[toast-in_160ms_ease-out] w-[min(22rem,calc(100vw-2rem))]",
              TONES[item.tone],
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="shrink-0">
              {ICONS[item.tone]}
            </svg>
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
