// Booking and moving, both through a dialog — Phase 5 PR 13, and deliberately not a drag.
// The slot comes from the engine and travels as a signed token, so no screen names a time itself.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select } from "../../design-system/fields.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { SearchField } from "../../design-system/fields.tsx";
import { searchPatients, type PatientSummary } from "../patients/patients-api.ts";
import { loadServices, type Service } from "../services/services-api.ts";
import { book, loadSlots, moveAppointment, type DayBooking, type Slot } from "./book-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function SlotDialog({
  authFetch,
  date,
  doctors,
  moving,
  prefer,
  onClose,
  onDone,
}: {
  authFetch: AuthFetch;
  date: string;
  doctors: { id: string; name: string }[];
  /** The booking being moved, or null when making a new one. */
  moving: DayBooking | null;
  /** The free hour this was opened from: whose it is, and when it starts. */
  prefer?: { doctorId: string; fromIso: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const { t, locale } = useLocale();
  const [services, setServices] = useState<Service[]>([]);
  const [doctorId, setDoctorId] = useState(moving?.doctorId ?? prefer?.doctorId ?? doctors[0]?.id ?? "");
  const [serviceId, setServiceId] = useState(moving?.serviceId ?? "");
  const [patientId, setPatientId] = useState<string | null>(null);
  const [patientQuery, setPatientQuery] = useState("");
  const [matches, setMatches] = useState<PatientSummary[]>([]);
  const [patientName, setPatientName] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string; params: Record<string, unknown> } | null>(null);

  useEffect(() => {
    void loadServices(authFetch)
      .then((all) => {
        const active = all.filter((service) => service.isActive);
        setServices(active);
        setServiceId((current) => (current === "" ? (active[0]?.id ?? "") : current));
      })
      .catch(() => undefined);
  }, [authFetch]);

  useEffect(() => {
    let cancelled = false;
    if (doctorId === "" || serviceId === "") return;
    void loadSlots(authFetch, { doctorId, serviceId, date }).then((found) => {
      if (cancelled) return;
      setSlots(found);
      // Opened from a free hour: that hour's first slot starts chosen, so the click that opened
      // the dialog is not repeated. Still a slot the server offered, never a time named here.
      const inHour =
        prefer === undefined
          ? undefined
          : found.find((slot) => {
              const from = Date.parse(prefer.fromIso);
              const at = Date.parse(slot.startsAt);
              return at >= from && at < from + 3_600_000;
            });
      setChosen(inHour?.slotToken ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, doctorId, serviceId, date, prefer?.fromIso]);

  const say = (code: string, params: Record<string, unknown>): string =>
    Object.entries(params).reduce(
      (text, [key, value]) => text.replace(`{${key}}`, String(value)),
      t(`refusal.${code}` as TranslationKey),
    );

  const ready = chosen !== null && (moving !== null || patientId !== null);

  async function submit(): Promise<void> {
    if (chosen === null) return;
    setBusy(true);
    setFailure(null);
    const result =
      moving === null
        ? await book(authFetch, { slotToken: chosen, patientId: patientId ?? "" })
        : await moveAppointment(authFetch, moving.appointmentId, chosen);
    setBusy(false);
    if (!result.ok) {
      // A lost race is the ordinary outcome here, not an error: somebody booked that slot between
      // the list being drawn and this click. The sentence says so, and the list reloads.
      setFailure({ code: result.code, params: result.params });
      void loadSlots(authFetch, { doctorId, serviceId, date }).then(setSlots);
      setChosen(null);
      return;
    }
    onDone();
  }

  const time = (iso: string): string =>
    new Date(iso).toLocaleTimeString(intlLocale(locale), {
      hour: "2-digit",
      minute: "2-digit",
    });

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={moving === null ? t("book.newBooking") : t("book.moveTitle")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t("book.cancel")}
          </Button>
          <Button loading={busy} disabled={!ready} data-testid="confirm-slot" onClick={() => void submit()}>
            {moving === null ? t("book.confirmBooking") : t("book.confirmMove")}
          </Button>
        </div>
      }
    >
      <div className="grid gap-3">
        {moving !== null && (
          <p className="text-sm text-ink-muted" data-testid="moving-summary">
            {`${moving.patientName} — ${time(moving.startsAt)}`}
          </p>
        )}

        {/* A small search rather than a shared picker: this is the first screen to need one, and a
            component extracted for a single caller is a guess about the second. */}
        {moving === null && (
          <div className="grid gap-1">
            <SearchField
              label={t("book.patient")}
              value={patientQuery}
              data-testid="patient-search"
              onChange={(event) => {
                const next = event.target.value;
                setPatientQuery(next);
                setPatientId(null);
                setPatientName("");
                if (next.trim().length < 2) {
                  setMatches([]);
                  return;
                }
                void searchPatients(authFetch, next.trim())
                  .then(setMatches)
                  .catch(() => setMatches([]));
              }}
            />
            {patientId !== null ? (
              <p className="text-sm text-ink" data-testid="patient-chosen">
                {patientName}
              </p>
            ) : (
              <ul className="grid gap-1" data-testid="patient-matches">
                {matches.slice(0, 5).map((patient) => (
                  <li key={patient.id}>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`patient-${patient.id}`}
                      onClick={() => {
                        setPatientId(patient.id);
                        setPatientName(patient.fullNameAr);
                      }}
                    >
                      {patient.fullNameAr}
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <Select
          label={t("book.doctor")}
          value={doctorId}
          options={doctors.map((doctor) => ({ value: doctor.id, label: doctor.name }))}
          data-testid="slot-doctor"
          onChange={(event) => setDoctorId(event.target.value)}
        />
        <Select
          label={t("book.service")}
          value={serviceId}
          options={services.map((service) => ({ value: service.id, label: service.nameAr }))}
          data-testid="slot-service"
          onChange={(event) => setServiceId(event.target.value)}
        />

        <div>
          <p className="mb-1 text-xs text-ink-muted">{t("book.pickSlot")}</p>
          {slots.length === 0 ? (
            <p className="text-sm text-ink-muted" data-testid="no-slots">
              {t("book.noSlots")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2" data-testid="slots">
              {slots.map((slot) => (
                <Button
                  key={slot.slotToken}
                  size="sm"
                  variant={chosen === slot.slotToken ? "secondary" : "ghost"}
                  aria-pressed={chosen === slot.slotToken}
                  data-testid={`slot-${slot.startsAt}`}
                  onClick={() => setChosen(slot.slotToken)}
                >
                  <span className="numeric">{time(slot.startsAt)}</span>
                </Button>
              ))}
            </div>
          )}
        </div>

        {failure !== null && (
          <p role="alert" className="text-xs text-danger" data-testid="slot-failure">
            {say(failure.code, failure.params)}
          </p>
        )}
      </div>
    </Modal>
  );
}
