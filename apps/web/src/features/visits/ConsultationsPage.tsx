// The «الكشوف» section: the doctor's open consultations, and a way back to the queue when there
// are none. The tab strip is the same component the visit screen uses, with its collapse rule off.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { loadOpenVisits, OpenVisitTabList, type OpenVisit } from "./OpenVisitTabs.tsx";
import { MyPatientsTab } from "./MyPatientsTab.tsx";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function ConsultationsPage({
  authFetch,
  onGoToQueue,
  /** «مرضاي» — R-B. Rendered as the second tab of the doctor's own section. */
  tab = "OPEN",
  onSelectTab,
  onOpenPatient,
}: {
  authFetch: AuthFetch;
  onGoToQueue: () => void;
  tab?: "OPEN" | "MINE";
  onSelectTab?: (next: "OPEN" | "MINE") => void;
  onOpenPatient?: (patientId: string) => void;
}) {
  const { t } = useLocale();
  const [visits, setVisits] = useState<OpenVisit[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadOpenVisits(authFetch).then((value) => {
      if (!cancelled) setVisits(value);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  const tabs = (
    <div className="mb-4 flex gap-2" role="tablist" aria-label={t("consultations.title")}>
      {(["OPEN", "MINE"] as const).map((value) => (
        <Button
          key={value}
          size="sm"
          role="tab"
          variant={tab === value ? "secondary" : "ghost"}
          aria-selected={tab === value}
          data-testid={`visits-tab-${value}`}
          onClick={() => onSelectTab?.(value)}
        >
          {t(value === "OPEN" ? "consultations.tab.open" : "myPatients.title")}
        </Button>
      ))}
    </div>
  );

  if (tab === "MINE") {
    return (
      <section className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-lg font-semibold text-ink">{t("myPatients.title")}</h1>
        {tabs}
        <MyPatientsTab authFetch={authFetch} onOpen={(id) => onOpenPatient?.(id)} />
      </section>
    );
  }

  // Null is "not asked yet" and [] is "asked, and there are none". Collapsing the two would flash
  // the empty state on every visit to the screen, which reads as "you have no patients".
  if (visits === null) {
    return <p className="text-sm text-ink-muted">{t("consultations.loading")}</p>;
  }

  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("consultations.title")}</h1>
      <p className="mb-4 text-sm text-ink-muted">{t("consultations.subtitle")}</p>
      {tabs}

      {visits.length === 0 ? (
        <div
          data-testid="no-open-consultations"
          className="rounded-xl border border-border bg-surface p-8 text-center"
        >
          <p className="text-sm text-ink">{t("consultations.empty.title")}</p>
          <p className="mt-2 text-sm text-ink-muted">{t("consultations.empty.body")}</p>
          <div className="mt-4">
            <Button variant="secondary" data-testid="go-to-queue" onClick={onGoToQueue}>
              {t("consultations.empty.action")}
            </Button>
          </div>
        </div>
      ) : (
        <OpenVisitTabList visits={visits} currentAppointmentId={null} />
      )}
    </section>
  );
}
