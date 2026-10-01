// «الشكاوى» — what patients reported over WhatsApp. OWNER and ADMIN only (complaints.read /
// complaints.manage, permissions.ts), same pairing as the audit log. Read plus one action: resolve.

import { useCallback, useEffect, useState } from "react";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Button } from "../../design-system/Button.tsx";
import { Select } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { loadComplaints, resolveComplaint, type ComplaintEntry, type ComplaintsQuery } from "./complaints-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

const PAGE_SIZE = 50;

export function ComplaintsPage({ authFetch }: { authFetch: AuthFetch }) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState<ComplaintsQuery>({ status: "OPEN" });
  const [offset, setOffset] = useState(0);
  const [entries, setEntries] = useState<ComplaintEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const page = await loadComplaints(authFetch, { ...query, limit: PAGE_SIZE, offset });
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

  const narrow = (next: Partial<ComplaintsQuery>): void => {
    setOffset(0);
    setQuery((current) => ({ ...current, ...next }));
  };

  const handleResolve = async (id: string): Promise<void> => {
    setResolvingId(id);
    try {
      await resolveComplaint(authFetch, id);
      await load();
    } catch {
      setFailed(true);
    } finally {
      setResolvingId(null);
    }
  };

  const stamp = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const columns: Column<ComplaintEntry>[] = [
    { key: "reference", header: t("complaints.reference"), render: (row) => <span className="numeric">{row.referenceNumber}</span> },
    {
      key: "at",
      header: t("complaints.when"),
      render: (row) => <span className="numeric">{stamp.format(new Date(row.createdAt))}</span>,
    },
    {
      key: "patient",
      header: t("complaints.patient"),
      render: (row) => (
        <span>
          {row.patientName}
          {row.patientPhone !== null ? <span className="ms-2 text-xs text-ink-subtle numeric">{row.patientPhone}</span> : null}
        </span>
      ),
    },
    {
      key: "description",
      header: t("complaints.description"),
      render: (row) => <span className="line-clamp-2 text-sm text-ink-muted">{row.description}</span>,
    },
    {
      key: "status",
      header: t("complaints.status"),
      render: (row) =>
        row.status === "OPEN" ? (
          <span className="text-sm font-medium text-warning">{t("complaints.status.open")}</span>
        ) : (
          <span className="text-xs text-ink-subtle">
            {t("complaints.status.resolved")}
            {row.resolvedByName !== null ? ` · ${row.resolvedByName}` : ""}
          </span>
        ),
    },
    {
      key: "action",
      header: "",
      render: (row) =>
        row.status === "OPEN" ? (
          <Button
            size="sm"
            variant="secondary"
            loading={resolvingId === row.id}
            onClick={() => void handleResolve(row.id)}
            data-testid={`complaint-resolve-${row.id}`}
          >
            {t("complaints.resolve")}
          </Button>
        ) : null,
    },
  ];

  return (
    <main className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("complaints.title")}</h1>
      <p className="mb-4 text-sm text-ink-muted">{t("complaints.subtitle")}</p>

      <Card title={t("complaints.filters")}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select
            label={t("complaints.filterStatus")}
            value={query.status ?? ""}
            data-testid="complaints-filter-status"
            options={[
              { value: "OPEN", label: t("complaints.status.open") },
              { value: "RESOLVED", label: t("complaints.status.resolved") },
            ]}
            onChange={(event) => narrow({ status: (event.target.value || undefined) as ComplaintsQuery["status"] })}
          />
        </div>
      </Card>

      <div className="mt-4">
        {failed ? (
          <p role="alert" className="text-sm text-danger" data-testid="complaints-failed">
            {t("complaints.loadFailed")}
          </p>
        ) : entries === null ? (
          <Spinner />
        ) : (
          <Card
            title={t("complaints.entries")}
            subtitle={t("complaints.showing").replace("{shown}", String(entries.length)).replace("{total}", String(total))}
            padded={false}
          >
            <div data-testid="complaints-table">
              <DataTable
                columns={columns}
                rows={entries}
                rowKey={(row) => row.id}
                caption={t("complaints.title")}
                empty={<EmptyState title={t("complaints.empty")} message="" />}
              />
            </div>
          </Card>
        )}
      </div>
    </main>
  );
}
