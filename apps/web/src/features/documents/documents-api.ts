// The patient's documents page talks to one public endpoint. No session: the token in the address is the
// whole credential, and it is never sent anywhere but this API.

import type { DeskCharge } from "../billing/billing-api.ts";
import type { PrintableVisit } from "../visits/PrintDocuments.tsx";
import type { ClinicIdentity, DoctorPrintIdentity } from "../visits/clinic-identity-api.ts";
import type { PatientHeader } from "../visits/draft-api.ts";

export type DocumentKind = "prescription" | "report" | "investigations" | "sickLeave" | "invoice";

/** Mirrors the API's `PublicVisitDocuments`: the paper the patient would have been handed, and nothing else. */
export interface PublicVisitDocuments {
  visitDate: string;
  currency: string;
  clinic: ClinicIdentity;
  doctor: DoctorPrintIdentity;
  images: { logo: string | null; signature: string | null; stamp: string | null };
  patient: Pick<
    PatientHeader,
    "patientId" | "fileNumber" | "fullNameAr" | "fullNameEn" | "nameSearchLatin" | "dateOfBirth" | "gender" | "phoneE164"
  >;
  complaint: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  followUpDate: string | null;
  prescription: PrintableVisit["prescription"];
  investigations: PrintableVisit["investigations"];
  sickLeave: PrintableVisit["sickLeave"];
  invoice: Pick<
    DeskCharge,
    | "chargeId"
    | "issuedOn"
    | "patientFileNumber"
    | "patientName"
    | "lines"
    | "subtotalMinor"
    | "discountMinor"
    | "payerShareMinor"
    | "patientShareMinor"
    | "paidMinor"
    | "balanceMinor"
  > | null;
}

export type LoadResult = { ok: true; documents: PublicVisitDocuments } | { ok: false };

/** `render` is set by the PDF renderer, so a server printing the page is not counted as a patient reading it. */
export async function loadDocuments(token: string, render: boolean): Promise<LoadResult> {
  try {
    const response = await fetch(
      `/api/public/visit-documents/${encodeURIComponent(token)}${render ? "?render=1" : ""}`,
      { headers: { accept: "application/json" }, referrerPolicy: "no-referrer" },
    );
    if (!response.ok) return { ok: false };
    return { ok: true, documents: (await response.json()) as PublicVisitDocuments };
  } catch {
    return { ok: false };
  }
}

export function pdfUrl(token: string, kind: DocumentKind): string {
  return `/api/public/visit-documents/${encodeURIComponent(token)}/pdf/${kind}`;
}

/** The sheets want a doctor-side `PatientHeader`; the fields a patient's page has no use for are empty. */
export function toPrintable(documents: PublicVisitDocuments): PrintableVisit {
  return {
    patient: {
      ...documents.patient,
      missingIntakeFields: [],
      allergies: [],
      allergiesReviewedAt: null,
      coverage: { standing: "NONE" },
      visitCount: 0,
      lastVisitAt: null,
    },
    doctorId: documents.doctor.doctorId,
    visitDate: documents.visitDate,
    diagnosis: documents.diagnosis,
    treatmentPlan: documents.treatmentPlan,
    complaint: documents.complaint,
    prescription: documents.prescription,
    investigations: documents.investigations,
    followUpDate: documents.followUpDate,
    sickLeave: documents.sickLeave,
  };
}
