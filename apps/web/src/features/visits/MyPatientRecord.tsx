// One of the doctor's own patients, opened from «مرضاي» — R-B. The visits, and any one of them
// opened in full. Distinct from the reception patient card, which Q18 keeps free of clinical content.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card, EmptyState } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import {
  loadPatient,
  loadVisitHistory,
  type PatientProfile,
  type VisitHistoryEntry,
} from "../patients/patients-api.ts";
import { VisitDetailView } from "./VisitDetailView.tsx";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function MyPatientRecord({
  authFetch,
  patientId,
  onBack,
}: {
  authFetch: AuthFetch;
  patientId: string;
  onBack: () => void;
}) {
  const { t, locale } = useLocale();
  const [patient, setPatient] = useState<PatientProfile | null>(null);
  const [visits, setVisits] = useState<VisitHistoryEntry[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openAppointmentId, setOpenAppointmentId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [profile, history] = await Promise.all([
        loadPatient(authFetch, patientId),
        loadVisitHistory(authFetch, patientId),
      ]);
      setPatient(profile);
      setVisits(history);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [authFetch, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const day = new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  if (failed) {
    return (
      <EmptyState
        title={t("myPatients.recordFailed")}
        message=""
        action={<Button onClick={() => void load()}>{t("patients.retry")}</Button>}
      />
    );
  }

  if (patient === null || visits === null) return <Spinner />;

  // The visit is opened in place rather than on a route of its own: the doctor is reading a
  // history, and a full-page navigation per entry loses their place in it.
  if (openAppointmentId !== null) {
    return (
      <VisitDetailView appointmentId={openAppointmentId} onBack={() => setOpenAppointmentId(null)} />
    );
  }

  return (
    <section data-testid="my-patient-record">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold text-ink">{patient.fullNameAr}</h1>
          <p className="numeric text-sm text-ink-muted">{patient.phoneE164}</p>
        </div>
        <Button variant="secondary" size="sm" data-testid="back-to-my-patients" onClick={onBack}>
          {t("myPatients.back")}
        </Button>
      </div>

      <Card title={t("myPatients.visits")}>
        {visits.length === 0 ? (
          <p className="text-sm text-ink-muted">{t("patients.detail.noVisits")}</p>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="my-patient-visits">
            {visits.map((visit) => (
              <li key={visit.id}>
                <button
                  type="button"
                  disabled={visit.appointmentId === null}
                  data-testid={`open-visit-${visit.id}`}
                  onClick={() => setOpenAppointmentId(visit.appointmentId)}
                  className="flex w-full flex-wrap items-baseline justify-between gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-start hover:border-border-strong disabled:opacity-60"
                >
                  <span className="numeric text-sm text-ink">
                    {day.format(new Date(visit.visitDate))}
                  </span>
                  <span className="text-xs text-ink-muted">
                    {visit.serviceName ?? "—"}
                    <span className="ms-3">{visit.doctorName ?? "—"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
