import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { FamilyLinks } from "./FamilyLinks.tsx";
import { AddCoverageForm } from "./AddCoverageForm.tsx";
import { EditPatientCard } from "./EditPatientCard.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { ageInYears } from "../../domain/age.ts";
import { formatMinor, intlLocale } from "../../i18n/format.ts";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import { CreditPanel } from "../billing/CreditPanel.tsx";
import {
  loadAppointmentHistory,
  loadHousehold,
  type Household,
  loadInsurance,
  loadBalance,
  loadPatient,
  loadVisitHistory,
  type AppointmentHistoryEntry,
  type OutstandingBalance,
  type PatientProfile,
  type Coverage,
  type PatientCoverage,
  type VisitHistoryEntry,
} from "./patients-api.ts";

/**
 * The patient detail screen — `PHASE-3.md` Q18, ruled by the founder on 2026-09-01 and unbuilt
 * until now. Its backend shipped across Phase 1 and PR #45; the screen did not exist on any branch.
 *
 * **On it, by ruling:** identity, contact, visit history *metadata*, appointment history,
 * outstanding balance. **Not on it, by the same ruling:** editing, clinical content, attachments.
 *
 * ## The §8 boundary is the point of this screen
 *
 * This is the first surface on which the clinical visibility split becomes visible to a user.
 * Reception sees visit **dates, doctor, service, status, follow-up** and never diagnosis, plan,
 * notes or prescription items — and the mechanism is that those live on different endpoints under
 * `visits.readContent`, which is NONE for OWNER, ADMIN and RECEPTIONIST. Nothing on this page
 * filters a clinical field out of a response; it never receives one.
 *
 * ## Two things deliberately absent
 *
 * **No edit controls.** Q18 says "not on it: editing" in as many words. `PATCH /patients/:id`
 * exists for reception to correct demographics, and wiring it here would be building past the
 * ruling — flagged for the founder rather than assumed either way.
 *
 * **No transfer state.** `PHASE-3.md` Q19 asks whether a pending transfer belongs on this screen
 * and is still OPEN. The recommendation there is yes; until it is ruled, a screen that showed it
 * would be inventing the answer.
 */

interface DetailData {
  patient: PatientProfile;
  balance: OutstandingBalance;
  appointments: AppointmentHistoryEntry[];
  visits: VisitHistoryEntry[];
  /** `null` when the caller lacks `patients.write` — the block is omitted, not an error. */
  insurance: PatientCoverage | null;
}

export function PatientDetailPage({ patientId, onBack }: { patientId: string; onBack: () => void }) {
  const { t, locale } = useLocale();
  const { me, authFetch } = useSession();
  // Q42: reception edits what it already reads. `patients.write` is the capability the API uses.
  const canWrite = me.permissions["patients.write"] !== "none";
  const [editing, setEditing] = useState(false);

  const [data, setData] = useState<DetailData | null>(null);
  const [failed, setFailed] = useState(false);
  /**
   * `null` covers two different things and the section says which: no household on this number, and
   * a patient recorded before intake linked records to households at all (D28). Legacy rows carry
   * no `contact_id`, so this must render, not throw.
   */
  const [household, setHousehold] = useState<Household | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      const [patient, balance, appointments, visits, insurance] = await Promise.all([
        loadPatient(authFetch, patientId),
        loadBalance(authFetch, patientId),
        loadAppointmentHistory(authFetch, patientId),
        loadVisitHistory(authFetch, patientId),
        loadInsurance(authFetch, patientId),
      ]);
      setData({ patient, balance, appointments, visits, insurance });
      // Separate from the Promise.all above: a household lookup that fails must not blank the whole
      // record. It returns null on any non-OK response, so this cannot reject.
      setHousehold(await loadHousehold(authFetch, patient.phoneE164));
    } catch {
      setFailed(true);
    }
  }, [authFetch, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(intlLocale(locale), { year: "numeric", month: "short", day: "numeric" }),
    [locale],
  );

  const appointmentColumns = useMemo<Column<AppointmentHistoryEntry>[]>(
    () => [
      {
        key: "date",
        header: t("patients.detail.date"),
        render: (row) => <span className="numeric">{dateFormat.format(new Date(row.scheduledStart))}</span>,
      },
      { key: "doctor", header: t("patients.detail.doctor"), render: (row) => row.doctorName ?? "—" },
      { key: "service", header: t("patients.detail.service"), render: (row) => row.serviceName ?? "—" },
      {
        key: "status",
        header: t("patients.detail.status"),
        render: (row) => t(`appointment.status.${row.status}` as TranslationKey),
      },
    ],
    [t, dateFormat],
  );

  const visitColumns = useMemo<Column<VisitHistoryEntry>[]>(
    () => [
      {
        key: "date",
        header: t("patients.detail.date"),
        render: (row) => <span className="numeric">{dateFormat.format(new Date(row.visitDate))}</span>,
      },
      { key: "doctor", header: t("patients.detail.doctor"), render: (row) => row.doctorName ?? "—" },
      { key: "service", header: t("patients.detail.service"), render: (row) => row.serviceName ?? "—" },
      {
        key: "followUp",
        header: t("patients.detail.followUp"),
        render: (row) =>
          row.followUpDate === null ? (
            "—"
          ) : (
            <span className="numeric">{dateFormat.format(new Date(row.followUpDate))}</span>
          ),
      },
    ],
    [t, dateFormat],
  );

  if (failed) {
    return (
      <EmptyState
        title={t("patients.detail.loadFailed")}
        message=""
        action={<Button onClick={() => void load()}>{t("patients.retry")}</Button>}
      />
    );
  }

  if (data === null) return <Spinner />;

  const { patient, balance, appointments, visits, insurance } = data;

  if (editing) {
    return (
      <div className="mx-auto flex max-w-5xl flex-col gap-4">
        <div>
          <Button variant="secondary" onClick={() => setEditing(false)}>
            {t("patients.detail.back")}
          </Button>
        </div>
        <EditPatientCard
          authFetch={authFetch}
          patient={patient}
          onSaved={() => {
            setEditing(false);
            void load();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-4">
      <div>
        <Button variant="secondary" onClick={onBack}>
          {t("patients.detail.back")}
        </Button>
      </div>

      <Card
        title={patient.fullNameAr}
        subtitle={patient.fullNameEn ?? undefined}
        actions={
          canWrite ? (
            <Button size="sm" variant="secondary" data-testid="edit-patient-button" onClick={() => setEditing(true)}>
              {t("patients.detail.editButton")}
            </Button>
          ) : undefined
        }
      >
        {/* Derived server-side from what is stored (D26), so completing the record clears it. */}
        {patient.missingIntakeFields.length > 0 && (
          <p
            data-testid="incomplete-badge"
            className="mb-3 inline-flex w-fit rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning"
          >
            {t("patients.incomplete")}
          </p>
        )}
        <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
          <Row label={t("patients.detail.phone")} value={patient.phoneE164} numeric />
          {patient.secondaryPhone !== null && (
            <Row label={t("patients.detail.phone2")} value={patient.secondaryPhone} numeric />
          )}
          {/*
            Both rows render unconditionally. The date of birth used to be hidden when absent, which
            is the failure the founder named: a missing row reads as a rendering fault rather than
            as "nobody recorded it", and the reader cannot tell which. Never a blank, never a zero.
          */}
          <Row
            label={t("patients.detail.dateOfBirth")}
            value={
              patient.dateOfBirth === null
                ? t("patients.ageUnknown")
                : dateFormat.format(new Date(patient.dateOfBirth))
            }
            numeric={patient.dateOfBirth !== null}
          />
          <Row
            label={t("patients.detail.age")}
            value={(() => {
              const age = ageInYears(patient.dateOfBirth, new Date());
              return age === null ? t("patients.ageUnknown") : String(age);
            })()}
            numeric={ageInYears(patient.dateOfBirth, new Date()) !== null}
          />
          {patient.gender !== null && (
            <Row
              label={t("patients.detail.gender")}
              value={t(`intake.gender.${patient.gender}` as TranslationKey)}
            />
          )}
          {patient.address !== null && <Row label={t("patients.detail.address")} value={patient.address} />}
          <Row
            label={t("patients.detail.status")}
            value={t(`patient.status.${patient.status}` as TranslationKey)}
          />
        </dl>
      </Card>

      {/*
        Insurance. The endpoint has existed since Phase 3 Q18 and nothing called it until now.

        **Lapsed cover is shown, not hidden.** A patient whose cover ended last month is a
        conversation reception has to have, and a screen saying only "no active policy" invites the
        reader to assume there never was one. Future cover is shown for the mirror reason: it is not
        a reason to refuse someone today, and it explains why they think they are covered.
      */}
      {insurance !== null && (
        <Card title={t("patients.detail.insurance")}>
          {insurance.active.length === 0 &&
          insurance.lapsed.length === 0 &&
          insurance.future.length === 0 ? (
            <p className="text-sm text-ink-subtle">{t("patients.insurance.none")}</p>
          ) : (
            <div className="flex flex-col gap-4">
              <CoverageGroup label={t("patients.insurance.ACTIVE")} rows={insurance.active} tone="success" />
              <CoverageGroup label={t("patients.insurance.FUTURE")} rows={insurance.future} tone="info" />
              <CoverageGroup label={t("patients.insurance.LAPSED")} rows={insurance.lapsed} tone="muted" />
            </div>
          )}
          {/* Q42. The route has existed since Phase 3 Q18 and nothing called it, so cover could be
              read and never recorded — reception had to ask someone with database access. */}
          {canWrite && (
            <AddCoverageForm authFetch={authFetch} patientId={patient.id} onAdded={() => void load()} />
          )}
        </Card>
      )}

      {/* Clinic credit — ruling 5. Shown to anyone who may read payments, because "do I have credit?"
          is asked at the desk; the refund is offered to whoever may record money, since giving it
          back is not a lesser act than taking it. */}
      {me.permissions["payments.read"] !== "none" && (
        <CreditPanel
          authFetch={authFetch}
          patientId={patient.id}
          currency={me.currency}
          allowRefund={me.permissions["payments.record"] !== "none"}
        />
      )}

      <Card title={t("family.title")}>
        <FamilyLinks patientId={data.patient.id} />
      </Card>

      <Card title={t("patients.family.title")}>
        {(() => {
          // Legacy patients have no contact row, so there is nothing to look up and nothing to
          // crash on. The two empty cases are worded apart: "no household on this number" is a
          // fact about today, "recorded before households existed" explains why there is no answer.
          const others = (household?.members ?? []).filter((m) => m.id !== data.patient.id);
          if (household === null) {
            return (
              <p className="text-sm text-ink-subtle" data-testid="family-empty">
                {t("patients.family.legacy")}
              </p>
            );
          }
          if (others.length === 0) {
            return (
              <p className="text-sm text-ink-subtle" data-testid="family-empty">
                {t("patients.family.none")}
              </p>
            );
          }
          return (
            <ul className="grid gap-2" data-testid="family-list">
              {others.map((member) => (
                <li key={member.id} className="flex items-center justify-between gap-3">
                  <span className="text-sm">{member.fullNameAr}</span>
                  <span className="text-xs text-ink-muted">
                    {t(`intake.rel.${member.relationshipToContact}` as TranslationKey)}
                  </span>
                </li>
              ))}
            </ul>
          );
        })()}
      </Card>

      <Card title={t("patients.detail.balance")}>
        {/*
          Zero with no payments at all is not "paid up" — nothing has ever been billed. Rendering
          both as the same reassuring zero is the kind of confident wrong answer this project keeps
          finding, so the two are worded differently.
        */}
        {balance.paymentCount === 0 ? (
          <p className="text-sm text-ink-muted">{t("patients.detail.balance.nothingBilled")}</p>
        ) : (
          <p className="numeric text-2xl font-semibold">
            {formatMinor(balance.outstandingMinor, me.currency, locale)}
          </p>
        )}
      </Card>

      <Card title={t("patients.detail.appointments")} padded={false}>
        <DataTable
          columns={appointmentColumns}
          rows={appointments}
          rowKey={(row) => row.id}
          caption={t("patients.detail.appointments")}
          empty={<EmptyState title={t("patients.detail.noAppointments")} message="" />}
        />
      </Card>

      <Card title={t("patients.detail.visits")} subtitle={t("patients.detail.visitsNote")} padded={false}>
        <DataTable
          columns={visitColumns}
          rows={visits}
          rowKey={(row) => row.id}
          caption={t("patients.detail.visits")}
          empty={<EmptyState title={t("patients.detail.noVisits")} message="" />}
        />
      </Card>
    </div>
  );
}

function Row({ label, value, numeric = false }: { label: string; value: string; numeric?: boolean }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={numeric ? "numeric text-sm" : "text-sm"}>{value}</dd>
    </div>
  );
}

/**
 * One standing's worth of policies, or nothing at all when there are none.
 *
 * Renders no heading for an empty group rather than an empty section: "no lapsed cover" is not a
 * fact worth a line of a screen, whereas "no cover at all" is — and that one is said once, above.
 */
function CoverageGroup({
  label,
  rows,
  tone,
}: {
  label: string;
  rows: Coverage[];
  tone: "success" | "info" | "muted";
}) {
  const { t } = useLocale();
  if (rows.length === 0) return null;

  const badge =
    tone === "success"
      ? "bg-success-soft text-success"
      : tone === "info"
        ? "bg-info-soft text-info"
        : "bg-surface-sunken text-ink-muted";

  return (
    <div>
      <span className={`inline-flex w-fit rounded-full px-2 py-0.5 text-xs ${badge}`}>{label}</span>
      <ul className="mt-2 flex flex-col gap-2">
        {rows.map((row) => (
          <li key={row.coverageId} className="rounded border border-border p-2 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">{row.insurerName}</span>
              {/* `numeric` so a policy number reads left-to-right inside Arabic text. */}
              <span className="numeric text-xs text-ink-muted">{row.policyNumber}</span>
            </div>
            <div className="numeric text-xs text-ink-subtle">
              {row.validFrom} — {row.validTo ?? t("patients.insurance.openEnded")}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
