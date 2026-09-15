// The fixed header on the visit screen — Q21, because the doctor was working on an anonymous record.
// Everything here comes from the safety summary, which already carried it. One endpoint, not two.

import { useEffect, useState } from "react";
import { ageInYears } from "../../domain/age.ts";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { loadPatientHeader, type PatientHeader as Header } from "./draft-api.ts";
import { CompleteIntakeCard } from "./CompleteIntakeCard.tsx";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function PatientHeader({
  authFetch,
  appointmentId,
}: {
  authFetch: AuthFetch;
  appointmentId: string;
}) {
  const { t, locale } = useLocale();
  const [header, setHeader] = useState<Header | null>(null);
  // Bumped after the doctor completes the intake fields, so the badge and the age re-derive from
  // the server rather than from what this screen believes it just saved.
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void loadPatientHeader(authFetch, appointmentId).then((value) => {
      if (!cancelled) setHeader(value);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, reloads]);

  if (header === null) return null;

  const years = ageInYears(header.dateOfBirth ?? null, new Date());
  const age = years === null ? t("header.ageUnknown") : t("header.age").replace("{years}", String(years));
  const gender =
    header.gender === null ? null : t(`header.gender.${header.gender}` as TranslationKey);

  return (
    <header
      data-testid="patient-header"
      className="sticky top-0 z-10 mb-4 rounded-xl border border-border bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="text-lg font-semibold text-ink">{header.fullNameAr}</h1>
        <span className="text-sm text-ink-muted">{age}</span>
        {gender !== null && <span className="text-sm text-ink-muted">{gender}</span>}
        <span dir="ltr" className="text-sm text-ink-muted">
          {header.phoneE164}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span>{t("header.visits").replace("{count}", String(header.visitCount))}</span>
        <span>
          {header.lastVisitAt === null
            ? t("header.noVisits")
            : t("header.lastVisit").replace("{at}", new Date(header.lastVisitAt).toLocaleDateString(intlLocale(locale)))}
        </span>
        <span>
          {header.coverage.standing === "NONE"
            ? t("header.coverage.NONE")
            : t(`header.coverage.${header.coverage.standing}` as TranslationKey).replace(
                "{insurer}",
                header.coverage.insurerName ?? "",
              )}
        </span>
      </div>

      {/* The doctor has the patient in front of them, so they may fill the three fields that makes
          possible — through reception's own endpoint, and nothing else on the record. */}
      <CompleteIntakeCard
        authFetch={authFetch}
        patientId={header.patientId}
        missing={header.missingIntakeFields}
        dateOfBirth={header.dateOfBirth}
        gender={header.gender}
        phoneE164={header.phoneE164}
        onSaved={() => setReloads((n) => n + 1)}
      />

      {/* An empty list is not a negative finding: `allergiesReviewedAt` is what tells "none known"
          from "nobody asked", and the two must not read the same. */}
      {header.allergies.length > 0 ? (
        <p
          role="alert"
          data-testid="allergy-alert"
          className="mt-2 rounded-lg bg-danger-soft px-3 py-1.5 text-sm font-semibold text-danger"
        >
          {t("header.allergies").replace(
            "{list}",
            header.allergies.map((allergy) => allergy.substance).join("، "),
          )}
        </p>
      ) : (
        <p className="mt-2 text-xs text-ink-subtle">
          {header.allergiesReviewedAt === null
            ? t("header.allergiesNotReviewed")
            : t("header.noAllergies")}
        </p>
      )}
    </header>
  );
}
