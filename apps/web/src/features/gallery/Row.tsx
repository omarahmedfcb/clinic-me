import type { ReactNode } from "react";

/**
 * One labelled row of specimens. The label sits on the inline-start side (right in Arabic) at a
 * fixed width so every row's specimens line up down the page — misalignment between rows makes it
 * much harder to spot that one variant is a pixel taller than the others.
 */
export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <span className="w-32 shrink-0 text-xs font-medium text-ink-subtle">{label}</span>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}
