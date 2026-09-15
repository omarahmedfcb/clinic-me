import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { NewPatientDialog } from "./NewPatientDialog.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { SearchField } from "../../design-system/fields.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { ageInYears } from "../../domain/age.ts";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import {
  loadPatientPage,
  PAGE_SIZE,
  searchPatients,
  type PatientSummary,
  type RecentPatient,
} from "./patients-api.ts";

/**
 * The patient book — Phase 4, ruled by the founder on 2026-09-03.
 *
 * His reason is the design: *"reception answering a phone call about a balance should not have to
 * open a booking dialog and abandon it. That's the definition of working around the system, and
 * it's the behaviour that produces duplicate records."* Until this screen, the only patient search
 * in the product was inside `BookAppointmentDialog`, so reaching a patient meant starting a booking
 * and abandoning it.
 *
 * ## Browse and search are one screen, and they are two different requests
 *
 * With an empty search box this is the book, ordered by who was seen most recently and paged.
 * Typing switches to `GET /patients?q=`, which ranks by trigram similarity. They are separate
 * endpoints under separate capabilities on purpose — the book is `patients.browse`, reception and
 * admin only; search is `patients.write`, which every staff role holds.
 *
 * **The list is not alphabetical, and that is a decision rather than an omission.**
 * `SCHEMA-DECISIONS.md` D19: under code-point ordering Latin sorts entirely before Arabic, so a
 * mixed list does not interleave — it pins the handful of English-named patients to the top and
 * reads as a bug. Ordering by last seen sidesteps the collation question, and is the more useful
 * order anyway, since the patient who telephones is usually one who was recently here.
 */
export function PatientsPage({ onOpen }: { onOpen: (patientId: string) => void }) {
  const { t, locale } = useLocale();
  const { authFetch, me } = useSession();

  /** Reception, admin and owner hold `patients.write`; a doctor does not create patients. */
  const canWritePatients = me.permissions["patients.write"] !== "none";

  const [intakeOpen, setIntakeOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<(RecentPatient | PatientSummary)[] | null>(null);
  const [total, setTotal] = useState(0);
  const [failed, setFailed] = useState(false);

  const searching = query.trim().length > 0;

  const load = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      if (query.trim().length > 0) {
        setRows(await searchPatients(authFetch, query.trim()));
        setTotal(0);
      } else {
        const page = await loadPatientPage(authFetch, offset);
        setRows(page.patients);
        setTotal(page.total);
      }
    } catch {
      setFailed(true);
    }
  }, [authFetch, query, offset]);

  useEffect(() => {
    // Debounced, so typing a name is one request per pause rather than one per keystroke.
    const timer = setTimeout(() => void load(), searching ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, searching]);

  const dateFormat = useMemo(
    () => new Intl.DateTimeFormat(intlLocale(locale), { year: "numeric", month: "short", day: "numeric" }),
    [locale],
  );

  const columns = useMemo<Column<RecentPatient | PatientSummary>[]>(
    () => [
      {
        key: "name",
        header: t("patients.column.name"),
        render: (row) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.fullNameAr}</span>
            {row.fullNameEn !== null && (
              <span className="text-xs text-ink-muted">{row.fullNameEn}</span>
            )}
            {/* D26. Shown on rows recorded before the fields were required, and on any completed
                badly since. Clears itself when the record is completed, because it is derived. */}
            {row.missingIntakeFields.length > 0 && (
              <span
                data-testid="incomplete-badge"
                title={t("patients.incomplete.title")}
                className="mt-0.5 inline-flex w-fit rounded-full bg-warning-soft px-2 py-0.5 text-[11px] text-warning"
              >
                {t("patients.incomplete")}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "phone",
        header: t("patients.column.phone"),
        render: (row) => <span className="numeric">{row.phoneE164}</span>,
      },
      {
        key: "age",
        header: t("patients.column.age"),
        align: "end",
        render: (row) => {
          const age = ageInYears(row.dateOfBirth, new Date());
          // Never a blank and never a zero — the founder's ruling. A blank reads as a rendering
          // fault and a zero reads as a newborn; both are worse than saying it was not recorded.
          return age === null ? (
            <span className="text-xs text-ink-subtle">{t("patients.ageUnknown")}</span>
          ) : (
            <span className="numeric">{age}</span>
          );
        },
      },
      {
        key: "insurance",
        header: t("patients.column.insurance"),
        render: (row) => {
          const insurance = "insurance" in row ? row.insurance : undefined;
          // Three states again, and for the same reason as `lastSeen` above: undefined is "this row
          // came from search, which does not carry the field", null is "no policy recorded", and a
          // value is a policy whose standing still has to be shown — a lapsed insurer name printed
          // plainly would read as cover the patient does not have.
          if (insurance === undefined) return <span className="text-ink-subtle">—</span>;
          if (insurance === null) {
            return <span className="text-xs text-ink-subtle">{t("patients.insurance.none")}</span>;
          }
          const tone =
            insurance.standing === "ACTIVE"
              ? "bg-success-soft text-success"
              : insurance.standing === "FUTURE"
                ? "bg-info-soft text-info"
                : "bg-surface-sunken text-ink-muted";
          return (
            <div className="flex flex-col gap-0.5">
              <span className="text-sm">{insurance.insurerName}</span>
              <span className={`inline-flex w-fit rounded-full px-2 py-0.5 text-xs ${tone}`}>
                {t(`patients.insurance.${insurance.standing}` as TranslationKey)}
              </span>
            </div>
          );
        },
      },
      {
        key: "lastSeen",
        header: t("patients.column.lastSeen"),
        align: "end",
        render: (row) => {
          const lastSeenAt = "lastSeenAt" in row ? row.lastSeenAt : undefined;
          // Three states, not two. Undefined is "this row came from search, which does not carry
          // the field"; null is "never seen", which is a fact worth showing rather than a blank.
          if (lastSeenAt === undefined) return <span className="text-ink-subtle">—</span>;
          return lastSeenAt === null ? (
            <span className="text-xs text-ink-muted">{t("patients.neverSeen")}</span>
          ) : (
            <span className="numeric">{dateFormat.format(new Date(lastSeenAt))}</span>
          );
        },
      },
      {
        key: "open",
        header: t("patients.column.open"),
        align: "end",
        render: (row) => (
          <Button variant="secondary" onClick={() => onOpen(row.id)}>
            {t("patients.open")}
          </Button>
        ),
      },
    ],
    [t, dateFormat, onOpen],
  );

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const currentPage = Math.floor(offset / PAGE_SIZE);

  return (
    <div className="mx-auto max-w-5xl">
      <Card title={t("patients.title")} subtitle={t("patients.subtitle")} padded={false}>
        <div className="flex items-end gap-3 border-b border-border p-4">
          <div className="flex-1">
            <SearchField
              label={t("patients.search.label")}
              placeholder={t("patients.search.placeholder")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
            />
          </div>
          {canWritePatients && (
            <Button onClick={() => setIntakeOpen(true)}>{t("intake.new")}</Button>
          )}
        </div>

        {intakeOpen && (
          <NewPatientDialog
            initialName={query}
            onClose={() => setIntakeOpen(false)}
            onCreated={(id) => {
              setIntakeOpen(false);
              onOpen(id);
            }}
            onOpenExisting={(id) => {
              setIntakeOpen(false);
              onOpen(id);
            }}
          />
        )}

        {failed ? (
          <EmptyState
            title={t("patients.loadFailed")}
            message=""
            action={<Button onClick={() => void load()}>{t("patients.retry")}</Button>}
          />
        ) : rows === null ? (
          <div className="p-8">
            <Spinner />
          </div>
        ) : (
          <>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(row) => row.id}
              caption={t("patients.title")}
              empty={
                <EmptyState
                  title={searching ? t("patients.noMatches.title") : t("patients.empty.title")}
                  message={searching ? t("patients.noMatches.message") : t("patients.empty.message")}
                />
              }
            />

            {/* Paging belongs to the book only: search returns a ranked shortlist, not a page of one. */}
            {!searching && total > PAGE_SIZE && (
              <div className="flex items-center justify-between gap-4 border-t border-border p-4">
                <Button
                  variant="secondary"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  {t("patients.previous")}
                </Button>
                <span className="numeric text-sm text-ink-muted">
                  {t("patients.pageOf")
                    .replace("{page}", String(currentPage + 1))
                    .replace("{pages}", String(lastPage + 1))
                    .replace("{total}", String(total))}
                </span>
                <Button
                  variant="secondary"
                  disabled={currentPage >= lastPage}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  {t("patients.next")}
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
