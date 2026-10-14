// What a patient sees when they open their documents link.
//
// ## This is a new reader of clinical data, so it is a new, narrow DTO -- not a reuse of the doctor's
//
// Every clinical endpoint in this API sits behind `visits.readContent`, which a receptionist does not
// hold: the desk must never see a diagnosis. This reader has no user at all -- its credential is a link
// the patient was sent -- so it cannot borrow that gate and must not borrow those DTOs, which carry
// fields a patient's browser has no business receiving (the doctor's private notes, the medical history,
// the visit's revision counter, who adjusted a price and why).
//
// What it returns is exactly what the four printed sheets and the invoice already print, and nothing
// else. The test for adding a field here is "is it on the paper the patient would have been handed?".
//
// The link names a visit. The visit names the patient and the clinic. There is no `patientId` or
// `tenantId` in any request a caller can influence, so there is nothing to tamper with: the only input
// is a token, and everything else is derived from it.

import { createHash } from "node:crypto";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { calendarDayIn } from "../appointments/domain/zoned-time.ts";
import type { CallerContext } from "../appointments/appointments.service.ts";
import type { StorageProvider } from "../attachments/storage/storage-provider.ts";
import { getDeskCharge } from "../billing/desk.ts";
import { visitScope } from "../clinical/visit-scope.ts";
import { readBrandingImage } from "../clinic-identity/clinic-identity.service.ts";
import { recordLinkView } from "./visit-document-links.ts";

export const DOCUMENT_KINDS = ["prescription", "report", "investigations", "sickLeave", "invoice"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isDocumentKind(value: string): value is DocumentKind {
  return (DOCUMENT_KINDS as readonly string[]).includes(value);
}

export interface PublicVisitDocuments {
  visitDate: string;
  currency: string;
  clinic: {
    name: string;
    address: string;
    phone: string;
    secondaryPhone: string | null;
    taxRegistrationNumber: string | null;
    commercialRegisterNumber: string | null;
    email: string | null;
    whatsappPhone: string | null;
    printedWorkingHours: string | null;
    tagline: string | null;
    nameEn: string | null;
    addressEn: string | null;
    hasLogo: boolean;
  };
  doctor: {
    doctorId: string;
    printedName: string | null;
    printedNameEn: string | null;
    title: string;
    syndicateNumber: string | null;
    licenseNumber: string;
    hasSignature: boolean;
    hasStamp: boolean;
  };
  /** Images as data URIs: a patient's browser holds no session, so it cannot ask the authenticated image routes. */
  images: { logo: string | null; signature: string | null; stamp: string | null };
  patient: {
    patientId: string;
    fileNumber: number;
    fullNameAr: string;
    fullNameEn: string | null;
    nameSearchLatin: string | null;
    dateOfBirth: string | null;
    gender: string | null;
    phoneE164: string;
  };
  complaint: string | null;
  diagnosis: string | null;
  treatmentPlan: string | null;
  followUpDate: string | null;
  prescription: {
    notes: string | null;
    items: {
      medicationName: string;
      strength: string | null;
      form: string | null;
      quantity: string | null;
      dose: string;
      frequency: string;
      duration: string;
      instructions: string | null;
    }[];
  };
  investigations: { freeText: string | null; items: { name: string; notes: string | null }[] };
  sickLeave: { days: number | null; from: string | null; note: string | null };
  /** Null when the clinic recorded no charge for this visit. Rendered live: it shows what has been paid *now*. */
  invoice: PublicInvoice | null;
}

export interface PublicInvoice {
  chargeId: string;
  issuedOn: string;
  patientFileNumber: number;
  patientName: string;
  lines: { id: string; nameSnapshot: string; unitPriceMinor: number; quantity: number }[];
  subtotalMinor: number;
  discountMinor: number;
  payerShareMinor: number;
  patientShareMinor: number;
  paidMinor: number;
  balanceMinor: number;
}

/**
 * The caller the shared clinic-identity and desk readers expect. They use `tenantId` and `actor` only; the
 * role is a label and `membershipId` is empty because no membership is acting -- a link is.
 */
function linkCaller(tenantId: string, actor: ActorContext): CallerContext & { membershipId: string } {
  return { tenantId, actor, role: "AI_AGENT", membershipId: "" };
}

const dataUri = (image: { bytes: Buffer; mimeType: string } | null): string | null =>
  image === null ? null : `data:${image.mimeType};base64,${image.bytes.toString("base64")}`;

const isoDay = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));

/** Null when the visit is gone or not completed: a link to a visit that is not finished shows nothing. */
export async function loadVisitDocuments(
  tenantId: string,
  visitId: string,
  storage: StorageProvider,
): Promise<PublicVisitDocuments | null> {
  const actor = await systemActor();
  const caller = linkCaller(tenantId, actor);

  const core = await withTenant(tenantId, actor, async (tx) => {
    const visit = await tx.visit.findFirst({
      // A link opens finished visits only. `visitScope` is spread as well, so this reader obeys the same rule
      // as every other reader of `visits`: a draft is never returned, whoever is asking.
      where: { id: visitId, status: "COMPLETED", ...visitScope({ actor }) },
      select: {
        id: true,
        doctorId: true,
        complaint: true,
        diagnosis: true,
        treatmentPlan: true,
        followUpDate: true,
        sickLeaveDays: true,
        sickLeaveFrom: true,
        sickLeaveNote: true,
        investigations: true,
        completedAt: true,
        appointment: { select: { scheduledStart: true } },
        patient: {
          select: {
            id: true,
            fileNumber: true,
            fullNameAr: true,
            fullNameEn: true,
            nameSearchLatin: true,
            dateOfBirth: true,
            gender: true,
            phoneE164: true,
          },
        },
        doctor: {
          select: {
            id: true,
            printedName: true,
            printedNameEn: true,
            title: true,
            syndicateNumber: true,
            licenseNumber: true,
            signatureStorageKey: true,
            stampStorageKey: true,
            membership: { select: { user: { select: { fullName: true } } } },
          },
        },
      },
    });
    if (visit === null) return null;

    const tenant = await tx.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        name: true,
        address: true,
        phone: true,
        secondaryPhone: true,
        taxRegistrationNumber: true,
        commercialRegisterNumber: true,
        email: true,
        whatsappPhone: true,
        printedWorkingHours: true,
        tagline: true,
        nameEn: true,
        addressEn: true,
        logoStorageKey: true,
        currency: true,
        timezone: true,
      },
    });

    const prescription = await tx.prescription.findFirst({
      where: { visitId },
      orderBy: { issuedAt: "desc" },
      select: {
        notes: true,
        items: {
          orderBy: { sortOrder: "asc" },
          select: {
            medicationName: true,
            strength: true,
            form: true,
            quantity: true,
            dose: true,
            frequency: true,
            duration: true,
            instructions: true,
          },
        },
      },
    });

    const investigations = await tx.visitInvestigation.findMany({
      where: { visitId },
      orderBy: { sortOrder: "asc" },
      select: { name: true, notes: true },
    });
    const charge = await tx.visitCharge.findFirst({ where: { visitId }, select: { id: true } });

    return { visit, tenant, prescription, investigations, freeText: visit.investigations, chargeId: charge?.id ?? null };
  });
  if (core === null) return null;

  const { visit, tenant } = core;

  // The invoice goes through the desk reader that the billing screen uses, so the figures come from
  // `visit_charge_balances` and not from arithmetic done here (D7). Only what the sheet prints is kept.
  let invoice: PublicInvoice | null = null;
  if (core.chargeId !== null) {
    const result = await getDeskCharge(linkCaller(tenantId, actor), core.chargeId);
    if (result.ok) {
      const charge = result.value;
      invoice = {
        chargeId: charge.chargeId,
        issuedOn: charge.issuedOn,
        patientFileNumber: charge.patientFileNumber,
        patientName: charge.patientName,
        lines: charge.lines.map((line) => ({
          id: line.id,
          nameSnapshot: line.nameSnapshot,
          unitPriceMinor: line.unitPriceMinor,
          quantity: line.quantity,
        })),
        subtotalMinor: charge.subtotalMinor,
        discountMinor: charge.discountMinor,
        payerShareMinor: charge.payerShareMinor,
        patientShareMinor: charge.patientShareMinor,
        paidMinor: charge.paidMinor,
        balanceMinor: charge.balanceMinor,
      };
    }
  }

  const [logo, signature, stamp] = await Promise.all([
    tenant.logoStorageKey === null ? null : readBrandingImage(caller, storage, { kind: "logo" }),
    visit.doctor.signatureStorageKey === null
      ? null
      : readBrandingImage(caller, storage, { kind: "signature", doctorId: visit.doctor.id }),
    visit.doctor.stampStorageKey === null
      ? null
      : readBrandingImage(caller, storage, { kind: "stamp", doctorId: visit.doctor.id }),
  ]);

  const day = calendarDayIn(visit.completedAt ?? visit.appointment.scheduledStart, tenant.timezone);

  return {
    visitDate: day,
    currency: tenant.currency,
    clinic: {
      name: tenant.name,
      address: tenant.address,
      phone: tenant.phone,
      secondaryPhone: tenant.secondaryPhone,
      taxRegistrationNumber: tenant.taxRegistrationNumber,
      commercialRegisterNumber: tenant.commercialRegisterNumber,
      email: tenant.email,
      whatsappPhone: tenant.whatsappPhone,
      printedWorkingHours: tenant.printedWorkingHours,
      tagline: tenant.tagline,
      nameEn: tenant.nameEn,
      addressEn: tenant.addressEn,
      hasLogo: logo !== null,
    },
    doctor: {
      doctorId: visit.doctor.id,
      printedName: visit.doctor.printedName ?? visit.doctor.membership.user.fullName,
      printedNameEn: visit.doctor.printedNameEn,
      title: visit.doctor.title,
      syndicateNumber: visit.doctor.syndicateNumber,
      licenseNumber: visit.doctor.licenseNumber,
      hasSignature: signature !== null,
      hasStamp: stamp !== null,
    },
    images: { logo: dataUri(logo), signature: dataUri(signature), stamp: dataUri(stamp) },
    patient: {
      patientId: visit.patient.id,
      fileNumber: visit.patient.fileNumber,
      fullNameAr: visit.patient.fullNameAr,
      fullNameEn: visit.patient.fullNameEn,
      nameSearchLatin: visit.patient.nameSearchLatin,
      dateOfBirth: isoDay(visit.patient.dateOfBirth),
      gender: visit.patient.gender,
      phoneE164: visit.patient.phoneE164,
    },
    complaint: visit.complaint,
    diagnosis: visit.diagnosis,
    treatmentPlan: visit.treatmentPlan,
    followUpDate: isoDay(visit.followUpDate),
    prescription: { notes: core.prescription?.notes ?? null, items: core.prescription?.items ?? [] },
    investigations: { freeText: core.freeText, items: core.investigations },
    sickLeave: { days: visit.sickLeaveDays, from: isoDay(visit.sickLeaveFrom), note: visit.sickLeaveNote },
    invoice,
  };
}

/** Bumps the view counter. Best-effort: a page load never fails because a counter could not be written. */
export async function recordView(tenantId: string, linkId: string, now: Date): Promise<void> {
  try {
    const actor = await systemActor();
    await withTenant(tenantId, actor, (tx) => recordLinkView(tx, linkId, now));
  } catch (error) {
    console.error("visit-documents: could not record a view", error);
  }
}

/**
 * What identifies a document's *contents*, so a cached PDF is reused only while the paper would come out
 * the same. A payment or a doctor's correction changes the payload, so it changes the hash and the next
 * download renders again.
 */
export function contentHash(documents: PublicVisitDocuments, kind: DocumentKind): string {
  const part = kind === "invoice" ? { invoice: documents.invoice, currency: documents.currency } : { ...documents, invoice: null };
  return createHash("sha256").update(JSON.stringify({ kind, part })).digest("hex").slice(0, 32);
}
