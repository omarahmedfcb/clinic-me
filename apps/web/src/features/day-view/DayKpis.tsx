// The four KPI cards above the timeline. Item 5 of the 2026-09-15 rebrand.

import { CheckCircle2, Clock, CalendarCheck, Users } from "lucide-react";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import type { DaySummary } from "./day-kpis.ts";

/**
 * Four numbers, in the order a receptionist reads them: who is here now, how much today holds,
 * what is slipping, what is done.
 *
 * `late` is the only one that can be alarming, and it is the only one tinted — in the brand gold
 * rather than in red, because a patient running ten minutes behind is a thing to notice, not a
 * failure. Red is reserved for refusals.
 */
const CARDS: {
  key: keyof DaySummary;
  label: TranslationKey;
  icon: typeof Users;
  tint: string;
}[] = [
  { key: "waiting", label: "day.kpi.waiting", icon: Users, tint: "text-primary" },
  { key: "total", label: "day.kpi.total", icon: CalendarCheck, tint: "text-ink" },
  { key: "late", label: "day.kpi.late", icon: Clock, tint: "text-warning" },
  { key: "completed", label: "day.kpi.completed", icon: CheckCircle2, tint: "text-success" },
];

export function DayKpis({ summary }: { summary: DaySummary }) {
  const { t } = useLocale();

  return (
    <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="day-kpis">
      {CARDS.map(({ key, label, icon: Icon, tint }) => (
        <div
          key={key}
          className="rounded-card border border-border bg-surface p-4"
          data-testid={`kpi-${key}`}
        >
          <div className="flex items-center gap-2">
            <Icon size={16} strokeWidth={1.75} aria-hidden="true" className={tint} />
            <span className="text-xs text-ink-muted">{t(label)}</span>
          </div>
          {/* `numeric` keeps the figure left-to-right and tabular inside the Arabic layout. */}
          <p className={`numeric mt-1 text-2xl font-semibold ${tint}`}>{summary[key]}</p>
        </div>
      ))}
    </div>
  );
}
