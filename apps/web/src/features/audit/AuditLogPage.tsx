// «سجل التدقيق» — Phase 5 PR 11. Who did what, when, to which record. Read-only, admin and owner.
// No control on this screen writes anything: the log is append-only and this is a window onto it.

import { useCallback, useEffect, useState } from "react";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  loadAuditFilters,
  loadAuditLog,
  type AuditEntry,
  type AuditFilterOptions,
  type AuditQuery,
} from "./audit-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

const PAGE_SIZE = 50;

export function AuditLogPage({ authFetch }: { authFetch: AuthFetch }) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState<AuditQuery>({});
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [options, setOptions] = useState<AuditFilterOptions>({ actors: [], entityTypes: [] });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void loadAuditFilters(authFetch)
      .then(setOptions)
      .catch(() => setOptions({ actors: [], entityTypes: [] }));
  }, [authFetch]);

  const load = useCallback(async () => {
    try {
      const page = await loadAuditLog(authFetch, { ...query, limit: PAGE_SIZE, offset });
      setEntries(page.entries);
      setTotal(page.total);
      setFailed(false);
    } catch {
      setEntries(null);
      setFailed(true);
    }
  }, [authFetch, query, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  // A filter change starts the list again: keeping the offset would land the reader on page three
  // of a result that now has one page, which reads as an empty log.
  const narrow = (next: Partial<AuditQuery>): void => {
    setOffset(0);
    setQuery((current) => ({ ...current, ...next }));
  };

  const stamp = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const columns: Column<AuditEntry>[] = [
    {
      key: "at",
      header: t("audit.when"),
      render: (row) => <span className="numeric">{stamp.format(new Date(row.at))}</span>,
    },
    {
      key: "who",
      header: t("audit.who"),
      render: (row) => (
        <span>
          {row.actorName ?? "—"}
          <span className="ms-2 text-xs text-ink-subtle">{row.actorRole}</span>
        </span>
      ),
    },
    {
      key: "action",
      header: t("audit.action"),
      render: (row) => t(`audit.action.${row.action}` as TranslationKey),
    },
    { key: "entityType", header: t("audit.record"), render: (row) => row.entityType },
    {
      key: "changed",
      header: t("audit.changed"),
      // Names, never values. The screen cannot show a value because the API never sends one.
      render: (row) =>
        row.changedFields.length === 0 ? (
          <span className="text-ink-subtle">—</span>
        ) : (
          <span className="text-xs text-ink-muted">{row.changedFields.join("، ")}</span>
        ),
    },
    {
      key: "entityId",
      header: t("audit.recordId"),
      render: (row) => <span className="numeric text-xs text-ink-subtle">{row.entityId.slice(0, 8)}</span>,
    },
  ];

  return (
    <main className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("audit.title")}</h1>
      <p className="mb-4 text-sm text-ink-muted">{t("audit.subtitle")}</p>

      <Card title={t("audit.filters")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label={t("audit.filterPerson")}
            placeholder={t("audit.anyone")}
            value={query.actorUserId ?? ""}
            data-testid="audit-filter-person"
            options={options.actors.map((actor) => ({
              value: actor.userId,
              label: `${actor.fullName} · ${actor.role}`,
            }))}
            onChange={(event) => narrow({ actorUserId: event.target.value })}
          />
          <Select
            label={t("audit.filterRecord")}
            placeholder={t("audit.anyRecord")}
            value={query.entityType ?? ""}
            data-testid="audit-filter-record"
            options={options.entityTypes.map((value) => ({ value, label: value }))}
            onChange={(event) => narrow({ entityType: event.target.value })}
          />
          <TextInput
            label={t("audit.from")}
            type="date"
            numeric
            value={query.from ?? ""}
            data-testid="audit-filter-from"
            onChange={(event) => narrow({ from: event.target.value })}
          />
          <TextInput
            label={t("audit.to")}
            type="date"
            numeric
            value={query.to ?? ""}
            data-testid="audit-filter-to"
            onChange={(event) => narrow({ to: event.target.value })}
          />
        </div>
      </Card>

      <div className="mt-4">
        {failed ? (
          <p role="alert" className="text-sm text-danger" data-testid="audit-failed">
            {t("audit.loadFailed")}
          </p>
        ) : entries === null ? (
          <Spinner />
        ) : (
          <Card
            title={t("audit.entries")}
            subtitle={t("audit.showing")
              .replace("{shown}", String(entries.length))
              .replace("{total}", String(total))}
            padded={false}
          >
            <div data-testid="audit-table">
              <DataTable
                columns={columns}
                rows={entries}
                rowKey={(row) => row.id}
                caption={t("audit.title")}
                empty={<EmptyState title={t("audit.empty")} message="" />}
              />
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
