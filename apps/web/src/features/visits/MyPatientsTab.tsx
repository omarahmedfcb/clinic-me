// «مرضاي» — R-B, 2026-09-14. The patients this doctor has treated, and search within them.
// The list refuses to render an empty state out of a failed read: "you have treated nobody" is a claim.

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { loadMyPatients, type MyPatient } from "./my-patients-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function MyPatientsTab({
  authFetch,
  onOpen,
}: {
  authFetch: AuthFetch;
  onOpen: (patientId: string) => void;
}) {
  const { t, locale } = useLocale();
  const [search, setSearch] = useState("");
  const [patients, setPatients] = useState<MyPatient[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    async (query: string) => {
      try {
        const page = await loadMyPatients(authFetch, { search: query });
        setPatients(page.patients);
        setFailed(false);
      } catch {
        setPatients(null);
        setFailed(true);
      }
    },
    [authFetch],
  );

  // Debounced, because search runs on every keystroke and a doctor's own list is small enough that
  // a round trip per letter would be all the screen ever does.
  useEffect(() => {
    const timer = setTimeout(() => void load(search), search === "" ? 0 : 250);
    return () => clearTimeout(timer);
  }, [load, search]);

  const day = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <section data-testid="my-patients">
      <p className="mb-3 text-sm text-ink-muted">{t("myPatients.subtitle")}</p>

      <TextInput
        label={t("myPatients.search")}
        value={search}
        data-testid="my-patients-search"
        onChange={(event) => setSearch(event.target.value)}
      />

      <div className="mt-4">
        {failed ? (
          <p role="alert" className="text-sm text-danger" data-testid="my-patients-failed">
            {t("myPatients.loadFailed")}
          </p>
        ) : patients === null ? (
          <Spinner />
        ) : patients.length === 0 ? (
          <EmptyState
            title={t(search.trim() === "" ? "myPatients.empty" : "myPatients.noMatch")}
            message=""
          />
        ) : (
          <ul className="flex flex-col gap-2" data-testid="my-patients-list">
            {patients.map((patient) => (
              <li key={patient.id}>
                <button
                  type="button"
                  data-testid={`my-patient-${patient.id}`}
                  onClick={() => onOpen(patient.id)}
                  className="flex w-full flex-wrap items-baseline justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-start hover:border-border-strong"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm text-ink">{patient.fullNameAr}</span>
                    <span className="numeric block text-xs text-ink-subtle">{patient.phoneE164}</span>
                  </span>
                  <span className="text-xs text-ink-muted">
                    <span className="numeric">{day.format(new Date(patient.lastVisitAt))}</span>
                    <span className="ms-3">
                      {t("myPatients.visitCount").replace("{count}", String(patient.visitCount))}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
