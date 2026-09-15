import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { intlLocale } from "../../i18n/format.ts";
import type { DoctorSummary } from "../schedules/schedules-api.ts";
import { loadPatientById, loadServices, loadSlots, searchPatients, type PatientMatch, type ServiceOption, type Slot } from "./booking-api.ts";
import { NewPatientDialog } from "../patients/NewPatientDialog.tsx";

/**
 * Booking a new appointment, from the desk.
 *
 * ## Why the patient is chosen from a list and never assumed
 *
 * `PHASE-3.md` Q5 rules that a phone number may belong to two patients — a mother booking for her
 * child gives her own number — and that **the UI must never assume one match**. So every result is
 * shown with its phone, and nothing is selected until a human clicks. Taking the first row would
 * book the wrong person, and the mistake would surface in the consulting room.
 *
 * ## Why times come only from the server
 *
 * The slot list is whatever `/availability` returned, and booking sends back the **token** attached
 * to the chosen slot. This component never constructs or parses a time to send — with no field
 * naming a moment, there is nothing for the client to disagree with the offer in (`PHASE-2.md`
 * Q24). It formats the token's `start` for display only.
 */

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doctors: DoctorSummary[];
  /** Pinned for a DOCTOR, chosen for everyone else — the same rule as every other doctor control. */
  pinnedDoctorId: string | null;
  busy: boolean;
  authFetch: (path: string, init?: RequestInit) => Promise<Response>;
  onBook: (slot: Slot, patient: PatientMatch) => void;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function BookAppointmentDialog({
  open,
  onOpenChange,
  doctors,
  pinnedDoctorId,
  busy,
  authFetch,
  onBook,
}: Props) {
  const { t, locale } = useLocale();

  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PatientMatch[]>([]);
  const [searched, setSearched] = useState(false);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [patient, setPatient] = useState<PatientMatch | null>(null);

  const [services, setServices] = useState<ServiceOption[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [doctorId, setDoctorId] = useState(pinnedDoctorId ?? "");
  const [date, setDate] = useState(todayIso);

  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [loadingSlots, setLoadingSlots] = useState(false);

  useEffect(() => {
    if (!open) return;
    void loadServices(authFetch)
      .then(setServices)
      .catch(() => setServices([]));
  }, [authFetch, open]);

  // Pinned roles cannot change the doctor, so keep the field in step if the list arrives late.
  useEffect(() => {
    if (pinnedDoctorId !== null) setDoctorId(pinnedDoctorId);
  }, [pinnedDoctorId]);

  const search = useCallback(async (): Promise<void> => {
    setMatches(await searchPatients(authFetch, query));
    // Distinguishes "no results" from "you have not searched yet". Without it an untouched dialog
    // would offer to register a patient nobody has looked for.
    setSearched(true);
  }, [authFetch, query]);

  const fetchSlots = useCallback(async (): Promise<void> => {
    if (doctorId === "" || serviceId === "") return;
    setLoadingSlots(true);
    try {
      setSlots(await loadSlots(authFetch, doctorId, serviceId, date));
    } finally {
      setLoadingSlots(false);
    }
  }, [authFetch, date, doctorId, serviceId]);

  // Re-fetched whenever the three inputs change, because a stale slot list is an offer the server
  // will refuse -- and the refusal would arrive after the receptionist has told the patient a time.
  useEffect(() => {
    setSlots(null);
    void fetchSlots();
  }, [fetchSlots]);

  const clock = (iso: string): string =>
    new Date(iso).toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit" });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("booking.title")}
      description={t("booking.description")}
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          {t("transfer.cancel")}
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {/*
          Hidden once a patient is chosen. The selected-patient card below already carries a
          "change" action; showing both at once made the dialog read as though nothing had been
          selected, because the search box is the loudest thing on the screen and kept its meaning
          after it had stopped being true. "change" restores this, with the previous query and
          results intact, so a mis-click costs one tap rather than retyping a name.
        */}
        {patient === null && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <TextInput
                label={t("booking.patient")}
                hint={t("booking.patient.hint")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void search();
                  }
                }}
              />
            </div>
            <Button size="sm" onClick={() => void search()}>
              {t("booking.search")}
            </Button>
            {/*
              Q41: always beside the search, not only after an empty result.
              A receptionist with a walk-in in front of them already knows the patient is new, and
              making them search for someone they know is not there — to be offered the button —
              is a step that exists only because the button used to live inside the empty state.
              The duplicate risk the old placement guarded against is real, which is why the search
              is still the first thing on the row and this sits after it.
            */}
            <Button size="sm" variant="secondary" onClick={() => setIntakeOpen(true)}>
              {t("intake.new")}
            </Button>
          </div>
        )}

        {patient === null ? (
          <ul className="flex flex-col gap-1">
            {/* The gap this closes: a walk-in whose name was not already in the system could not be
                booked at all — the search returned nothing and the dialog offered no way forward. */}
            {searched && matches.length === 0 && (
              <li className="rounded-lg border border-dashed border-border px-3 py-3 text-center">
                <p className="text-sm text-ink-muted">{t("booking.noPatients")}</p>
              </li>
            )}
            {intakeOpen && (
              <NewPatientDialog
                initialName={query}
                onClose={() => setIntakeOpen(false)}
                onCreated={(id) => {
                  setIntakeOpen(false);
                  // Fetched by id, not searched for. Q32: this searched by id, and search matches
                  // name, phone and national ID — a UUID matched nothing, so the selection was
                  // silently null and the receptionist had to find the patient they just created.
                  void loadPatientById(authFetch, id).then((created) => {
                    if (created === null) return;
                    setMatches([created]);
                    setPatient(created);
                  });
                }}
              />
            )}
            {matches.map((match) => (
              <li key={match.id}>
                {/*
                  Every match, with its phone. Q5: two patients can share a number, so the phone is
                  shown beside the name -- it is the only thing that tells them apart on this screen.
                */}
                <button
                  type="button"
                  onClick={() => setPatient(match)}
                  className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm hover:border-border-strong"
                >
                  <bdi className="font-medium">{match.fullNameAr}</bdi>
                  <span className="numeric block text-xs text-ink-muted">{match.phoneE164}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="flex items-center justify-between rounded-lg border border-border bg-surface-sunken px-3 py-2">
            <div className="text-sm">
              <bdi className="font-medium">{patient.fullNameAr}</bdi>
              <span className="numeric block text-xs text-ink-muted">{patient.phoneE164}</span>
            </div>
            <Button size="sm" variant="secondary" onClick={() => setPatient(null)}>
              {t("booking.changePatient")}
            </Button>
          </div>
        )}

        {pinnedDoctorId === null && (
          <Select
            label={t("booking.doctor")}
            value={doctorId}
            onChange={(event) => setDoctorId(event.target.value)}
            options={doctors.map((d) => ({ value: d.id, label: `${d.title} ${d.fullName} — ${d.specialty}` }))}
            placeholder={t("transfer.request.pickDoctor")}
          />
        )}

        <Select
          label={t("booking.service")}
          value={serviceId}
          onChange={(event) => setServiceId(event.target.value)}
          options={services.map((s) => ({
            value: s.id,
            label: `${s.nameAr} — ${s.durationMinutes}${t("booking.minutesSuffix")}`,
          }))}
          placeholder={t("booking.pickService")}
        />

        <TextInput
          label={t("booking.date")}
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />

        <div>
          <span className="block text-sm font-medium text-ink">{t("booking.slots")}</span>
          {loadingSlots ? (
            <div className="py-4">
              <Spinner />
            </div>
          ) : slots === null || doctorId === "" || serviceId === "" ? (
            <p className="py-2 text-sm text-ink-muted">{t("booking.pickFirst")}</p>
          ) : slots.length === 0 ? (
            // An empty day and an unchosen service look identical unless they are worded apart.
            <p className="py-2 text-sm text-ink-muted">{t("booking.noSlots")}</p>
          ) : (
            <div className="flex flex-wrap gap-2 pt-2">
              {slots.map((slot) => (
                <Button
                  key={slot.token}
                  size="sm"
                  variant="secondary"
                  disabled={busy || patient === null}
                  onClick={() => patient !== null && onBook(slot, patient)}
                >
                  <span className="numeric">{clock(slot.start)}</span>
                </Button>
              ))}
            </div>
          )}
          {patient === null && slots !== null && slots.length > 0 && (
            <p className="pt-2 text-xs text-ink-subtle">{t("booking.needPatient")}</p>
          )}
        </div>
      </div>
    </Modal>
  );
}
