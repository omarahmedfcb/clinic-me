// The four sheets, and the listener that prints one of them when a button asks — Q9, Q29, Q46.
// Browser print by ruling. "Save as PDF" is the browser's, and there is no PDF service here.

import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n/locale-context.tsx";
import { recordPrescriptionPrinted } from "./clinic-identity-api.ts";
import {
  loadInvestigations,
  loadPatientHeader,
  loadPrescription,
  type DraftField,
  type PatientHeader,
  type VisitInvestigations,
  type VisitPrescription,
} from "./draft-api.ts";
import { PrintDocuments } from "./PrintDocuments.tsx";
import { PRINT_SHEET_EVENT, type SheetKind } from "./print-sheet-event.ts";
import type { TranslationKey } from "../../i18n/strings.ts";
import { recordSickLeavePrinted, type SickLeave } from "./sick-leave-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface Props {
  authFetch: AuthFetch;
  appointmentId: string;
  visitId: string;
  doctorId: string;
  /** What is on the screen right now, so the sheet matches what the doctor is looking at. */
  text: Partial<Record<DraftField, string>>;
  followUpDate: string | null;
  /** Lifted from the sick-leave section, so the sheets need no second fetch of it. */
  sickLeave: SickLeave;
}

const EMPTY_PRESCRIPTION: VisitPrescription = {
  prescriptionId: null,
  notes: null,
  items: [],
  printedCount: 0,
};

export function PrintSection({
  authFetch,
  appointmentId,
  visitId,
  doctorId,
  text,
  followUpDate,
  sickLeave,
}: Props) {
  const { t } = useLocale();
  const [patient, setPatient] = useState<PatientHeader | null>(null);
  const [prescription, setPrescription] = useState<VisitPrescription>(EMPTY_PRESCRIPTION);
  const [investigations, setInvestigations] = useState<VisitInvestigations>({
    freeText: null,
    items: [],
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [header, script, orders] = await Promise.all([
        loadPatientHeader(authFetch, appointmentId),
        loadPrescription(authFetch, appointmentId, visitId),
        loadInvestigations(authFetch, appointmentId, visitId),
      ]);
      if (cancelled) return;
      setPatient(header);
      if (script !== null) setPrescription(script);
      if (orders !== null) setInvestigations(orders);
    })();
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, visitId]);

  // The newest closure, so the one listener below never prints with stale props.
  const handler = useRef<(kind: SheetKind) => Promise<void>>(async () => undefined);
  handler.current = async (kind) => {
    // The sheets were loaded when the screen opened; edits saved since must be on the paper.
    if (kind === "prescription") {
      const fresh = await loadPrescription(authFetch, appointmentId, visitId);
      if (fresh !== null) setPrescription(fresh);
      // Recorded before the dialog opens: its outcome is not observable (Q9 counts presses).
      await recordPrescriptionPrinted(authFetch, appointmentId, visitId);
    }
    if (kind === "investigations") {
      const fresh = await loadInvestigations(authFetch, appointmentId, visitId);
      if (fresh !== null) setInvestigations(fresh);
    }
    if (kind === "sickLeave") await recordSickLeavePrinted(authFetch, appointmentId, visitId);

    // Two frames: the sheet re-renders with the fresh data before the dialog snapshots the page.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    // Q43: "save as PDF" names the file after the document title, so it carries the document and
    // the patient. Restored afterwards so the tab does not keep a patient's name in it.
    const previous = document.title;
    document.title = `${t(`print.${kind === "sickLeave" ? "report" : kind}` as TranslationKey)} — ${patient?.fullNameAr ?? ""}`.trim();
    document.body.dataset["printSheet"] = kind;
    try {
      window.print();
    } finally {
      delete document.body.dataset["printSheet"];
      document.title = previous;
    }
  };

  useEffect(() => {
    const listener = (event: Event): void => {
      void handler.current((event as CustomEvent<SheetKind>).detail);
    };
    window.addEventListener(PRINT_SHEET_EVENT, listener);
    return () => window.removeEventListener(PRINT_SHEET_EVENT, listener);
  }, []);

  if (patient === null) return null;

  return (
    <>
      <PrintDocuments
        authFetch={authFetch}
        visit={{
          patient,
          doctorId,
          visitDate: new Date().toISOString(),
          complaint: text.complaint ?? null,
          diagnosis: text.diagnosis ?? null,
          treatmentPlan: text.treatmentPlan ?? null,
          prescription,
          investigations,
          followUpDate,
          sickLeave,
        }}
      />
    </>
  );
}
