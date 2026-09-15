// The print button, and the three sheets it prints — Q9, Q29.
// Browser print by ruling. "Save as PDF" is the browser's, and there is no PDF service here.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
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
import { printedPatientName } from "./print-english.ts";
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

  async function print(): Promise<void> {
    // The count is recorded before the dialog opens, because the dialog is modal and its outcome is
    // not observable: a browser reports nothing about whether paper came out. Q9 asks for a count of
    // sheets produced, and "the doctor pressed print" is the honest thing this can know.
    await recordPrescriptionPrinted(authFetch, appointmentId, visitId);
    // Q46: the certificate goes out in the same job, so it is counted in the same press. The route
    // refuses when no certificate exists, which is why this is unconditional and harmless.
    if (sickLeave.days !== null) {
      await recordSickLeavePrinted(authFetch, appointmentId, visitId);
    }

    // Q43: the document name and the patient, because "save as PDF" uses the document title as the
    // filename and every sheet this clinic produced would otherwise be called "Clinic OS". Restored
    // afterwards so the tab does not keep a patient's name in it.
    const previous = document.title;
    document.title = `${t("print.prescription")} — ${patient?.fullNameAr ?? ""}`.trim();
    try {
      window.print();
    } finally {
      document.title = previous;
    }
  }

  if (patient === null) return null;

  const printedName = printedPatientName(patient);

  return (
    <>
      <div className="mt-4">
        <Button data-testid="print-button" variant="secondary" onClick={() => void print()}>
          {t("print.button")}
        </Button>
        {/* Q45: the sheet is English, so the doctor is told which name will appear on it *before*
            the dialog opens. A transliteration is a guess, and the doctor is the only person who
            can catch a wrong one — after printing is too late. */}
        <p className="mt-2 text-xs text-ink-muted" data-testid="printed-name-preview">
          <span dir="ltr">{printedName.name}</span>
          {printedName.source === "transliteration" && (
            <span className="ms-2 text-warning">{t("print.nameTransliterated")}</span>
          )}
          {printedName.source === "arabic" && (
            <span className="ms-2 text-warning">{t("print.nameArabicFallback")}</span>
          )}
        </p>
      </div>

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
