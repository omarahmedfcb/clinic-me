// One audit event: a transaction, collapsed to who, when and how many changes. Expanded, its rows are
// listed with no numbers: they happened at one instant, and an ordinal would claim a sequence.

import { useState } from "react";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import type { AuditEvent } from "./audit-api.ts";

export function AuditEventRow({ event, stamp }: { event: AuditEvent; stamp: Intl.DateTimeFormat }) {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const count = event.entryCount;
  const more = event.entryCount - event.entries.length;
  const plural = new Intl.PluralRules(intlLocale(locale)).select(count);
  const changes = t(`audit.changes.${plural}` as TranslationKey).replace("{count}", String(count));

  return (
    <li className="border-b border-border last:border-b-0" data-testid="audit-event">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-start hover:bg-surface-sunken"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="numeric text-sm text-ink">{stamp.format(new Date(event.at))}</span>
        <span className="text-sm text-ink">
          {event.actorName ?? "—"}
          <span className="ms-2 text-xs text-ink-subtle">{event.actorRole}</span>
        </span>
        <span className="text-xs text-ink-muted" data-testid="audit-event-count">{changes}</span>
        {event.reach === null ? null : (
          <span
            className="rounded bg-surface-sunken px-2 py-0.5 text-xs text-ink-subtle"
            data-testid="audit-event-reach"
          >
            {t(`audit.reach.${event.reach}`)}
          </span>
        )}
      </button>

      {open ? (
        <ul className="list-none bg-surface-sunken/40 px-4 pb-3" data-testid="audit-event-entries">
          {event.entries.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-baseline gap-x-3 py-1 text-sm" data-testid="audit-entry">
              <span className="text-ink">{t(`audit.action.${entry.action}` as TranslationKey)}</span>
              <span className="text-ink-muted">{entry.entityType}</span>
              <span className="numeric text-xs text-ink-subtle">{entry.entityId.slice(0, 8)}</span>
              {entry.changedFields.length === 0 ? null : (
                <span className="text-xs text-ink-muted">{entry.changedFields.join("، ")}</span>
              )}
            </li>
          ))}
          {more > 0 ? (
            <li className="pt-2 text-xs text-ink-muted" data-testid="audit-event-more">
              {t("audit.more").replace("{count}", String(more))}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}
