// «تقارير المدفوعات» — Phase 5 PR 14. A day or a month: what came in, what is still owed, per
// doctor, plus the two things an admin oversees — price adjustments and discounts above the ceiling.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  loadPaymentsReport,
  type DoctorTotals,
  type PaymentsReport,
  type ReportPeriod,
} from "./reports-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function ReportsPage({ authFetch, currency }: { authFetch: AuthFetch; currency: string }) {
  const { t, locale } = useLocale();
  // **MONTH, not DAY** — ruled 2026-09-14. A day with no receipts yet is every morning and every
  // quiet day, and a screen that opens on zeroes reads as broken rather than as an answer.
  const [period, setPeriod] = useState<ReportPeriod>("MONTH");
  const [on, setOn] = useState("");
  const [report, setReport] = useState<PaymentsReport | null>(null);
  const [failed, setFailed] = useState(false);

  const money = (minor: number): string => formatMinor(minor, currency, locale);

  const load = useCallback(async () => {
    try {
      setReport(await loadPaymentsReport(authFetch, { period, on }));
      setFailed(false);
    } catch {
      setReport(null);
      setFailed(true);
    }
  }, [authFetch, period, on]);

  useEffect(() => {
    void load();
  }, [load]);

  // The period control and the date control move together: a `YYYY-MM-DD` sent as a month is a
  // refusal, and making the reader discover that by being refused would be a rude way to say it.
  const choosePeriod = (next: ReportPeriod): void => {
    setPeriod(next);
    setOn((current) =>
      current === "" ? "" : next === "MONTH" ? current.slice(0, 7) : `${current.slice(0, 7)}-01`,
    );
  };

  const doctorColumns: Column<DoctorTotals>[] = [
    { key: "doctor", header: t("reports.doctor"), render: (row) => row.doctorName },
    {
      key: "collected",
      header: t("reports.collected"),
      align: "end",
      render: (row) => <span className="numeric">{money(row.collectedMinor)}</span>,
    },
    {
      key: "charged",
      header: t("reports.charged"),
      align: "end",
      render: (row) => <span className="numeric">{money(row.chargedMinor)}</span>,
    },
    {
      key: "outstanding",
      header: t("reports.outstanding"),
      align: "end",
      render: (row) => <span className="numeric">{money(row.outstandingMinor)}</span>,
    },
    {
      key: "charges",
      header: t("reports.chargeCount"),
      align: "end",
      render: (row) => <span className="numeric">{row.charges}</span>,
    },
  ];

  return (
    <main className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("reports.title")}</h1>
      <p className="mb-4 text-sm text-ink-muted">{t("reports.subtitle")}</p>

      <Card title={t("reports.period")}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex gap-2" role="group" aria-label={t("reports.period")}>
            {(["DAY", "MONTH"] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={period === value ? "secondary" : "ghost"}
                aria-pressed={period === value}
                data-testid={`report-period-${value}`}
                onClick={() => choosePeriod(value)}
              >
                {t(`reports.period.${value}` as TranslationKey)}
              </Button>
            ))}
          </div>
          <div className="min-w-48">
            <TextInput
              label={t("reports.on")}
              type={period === "MONTH" ? "month" : "date"}
              numeric
              value={on}
              data-testid="report-on"
              onChange={(event) => setOn(event.target.value)}
            />
          </div>
        </div>
      </Card>

      <div className="mt-4">
        {failed ? (
          <p role="alert" className="text-sm text-danger" data-testid="report-failed">
            {t("reports.loadFailed")}
          </p>
        ) : report === null ? (
          <Spinner />
        ) : (
          <div className="flex flex-col gap-4" data-testid="report">
            {report.scope === "OWN" && (
              <p className="text-xs text-ink-muted" data-testid="report-own-scope">
                {t("reports.ownScope")}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Card title={t("reports.collected")} subtitle={t("reports.range").replace("{from}", report.from).replace("{to}", report.to)}>
                <p className="numeric text-2xl font-semibold text-ink" data-testid="report-collected">
                  {money(report.collectedMinor)}
                </p>
                <ul className="mt-3 flex flex-col gap-1" data-testid="report-by-method">
                  {report.byMethod.length === 0 ? (
                    <li className="text-sm text-ink-muted">{t("reports.none")}</li>
                  ) : (
                    report.byMethod.map((row) => (
                      <li key={row.method} className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="text-ink-muted">
                          {t(`payment.method.${row.method}` as TranslationKey)}
                        </span>
                        <span className="numeric text-ink">{money(row.totalMinor)}</span>
                      </li>
                    ))
                  )}
                </ul>
              </Card>

              {/* Not period-bounded, and the subtitle says so: a debt does not expire at midnight
                  on the last day of the month somebody happened to select. */}
              <Card title={t("reports.outstanding")} subtitle={t("reports.outstandingList")}>
                <p className="numeric text-2xl font-semibold text-ink" data-testid="report-outstanding">
                  {money(report.outstandingMinor)}
                </p>
              </Card>
            </div>

            <Card title={t("reports.byDoctor")} padded={false}>
              <div data-testid="report-by-doctor">
                <DataTable
                  columns={doctorColumns}
                  rows={report.byDoctor}
                  rowKey={(row) => row.doctorId}
                  caption={t("reports.byDoctor")}
                  empty={<EmptyState title={t("reports.none")} message="" />}
                />
              </div>
            </Card>

            <Card title={t("reports.outstandingList")} padded={false}>
              <div data-testid="report-outstanding-list">
                <DataTable
                  columns={[
                    { key: "patient", header: t("reports.patient"), render: (row) => row.patientName },
                    { key: "doctor", header: t("reports.doctor"), render: (row) => row.doctorName },
                    {
                      key: "issuedOn",
                      header: t("reports.issuedOn"),
                      render: (row) => <span className="numeric">{row.issuedOn}</span>,
                    },
                    {
                      key: "balance",
                      header: t("reports.balance"),
                      align: "end",
                      render: (row) => <span className="numeric">{money(row.balanceMinor)}</span>,
                    },
                  ]}
                  rows={report.outstanding}
                  rowKey={(row) => row.chargeId}
                  caption={t("reports.outstandingList")}
                  empty={<EmptyState title={t("reports.none")} message="" />}
                />
              </div>
            </Card>

            <Card title={t("reports.adjustments")} padded={false}>
              <div data-testid="report-adjustments">
                <DataTable
                  columns={[
                    { key: "patient", header: t("reports.patient"), render: (row) => row.patientName },
                    { key: "doctor", header: t("reports.doctor"), render: (row) => row.doctorName },
                    {
                      key: "amount",
                      header: t("reports.amount"),
                      align: "end",
                      render: (row) => <span className="numeric">{money(row.amountMinor)}</span>,
                    },
                    { key: "reason", header: t("reports.reason"), render: (row) => row.reason ?? "—" },
                  ]}
                  rows={report.adjustments}
                  rowKey={(row) => row.visitId}
                  caption={t("reports.adjustments")}
                  empty={<EmptyState title={t("reports.none")} message="" />}
                />
              </div>
            </Card>

            <Card title={t("reports.aboveCeiling")} padded={false}>
              <div data-testid="report-above-ceiling">
                <DataTable
                  columns={[
                    { key: "patient", header: t("reports.patient"), render: (row) => row.patientName },
                    { key: "doctor", header: t("reports.doctor"), render: (row) => row.doctorName },
                    {
                      key: "discount",
                      header: t("reports.discount"),
                      align: "end",
                      render: (row) => <span className="numeric">{money(row.discountMinor)}</span>,
                    },
                    { key: "reason", header: t("reports.reason"), render: (row) => row.reason ?? "—" },
                    {
                      key: "authorisedBy",
                      header: t("reports.authorisedBy"),
                      render: (row) => row.authorisedBy ?? "—",
                    },
                  ]}
                  rows={report.aboveCeiling}
                  rowKey={(row) => row.chargeId}
                  caption={t("reports.aboveCeiling")}
                  empty={<EmptyState title={t("reports.none")} message="" />}
                />
              </div>
            </Card>
          </div>
        )}
      </div>
    </main>
  );
}
