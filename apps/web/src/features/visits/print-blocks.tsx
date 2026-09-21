// The structured blocks every printed sheet is built from — Q45's clinical-form layout.
// English throughout and `dir="ltr"`: the paper does not follow the interface language.

import { PoweredBy } from "../../brand/Logo.tsx";
import { ageInYears } from "../../domain/age.ts";
import type { ClinicIdentity, DoctorPrintIdentity } from "./clinic-identity-api.ts";
import type { PatientHeader } from "./draft-api.ts";
import {
  EN,
  fileReference,
  printedDate,
  printedPatientName,
  printedSex,
  printedTime,
} from "./print-english.ts";

/** A labelled cell. The label is small and grey on screen and prints as plain black text. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="print-line">
      <span className="block text-[10px] uppercase tracking-wide text-neutral-600">{label}</span>
      <span className="block text-sm">{value === "" ? "—" : value}</span>
    </div>
  );
}

/**
 * The large letterhead: logo, clinic name, tagline, address, phones, email.
 *
 * English name and address when the clinic has filled them, Arabic otherwise. A clinic that has
 * not been through the settings screen still prints a usable sheet — refusing would make a
 * settings box a precondition for handing a patient a prescription.
 */
export function Letterhead({ clinic, logo }: { clinic: ClinicIdentity | null; logo: string | null }) {
  const name = clinic?.nameEn?.trim() || clinic?.name || "";
  const address = clinic?.addressEn?.trim() || clinic?.address || "";
  const phones = [clinic?.phone, clinic?.secondaryPhone, clinic?.whatsappPhone]
    .filter((value) => value != null && value !== "")
    .join("  ·  ");

  return (
    <header
      id="print-letterhead"
      className="print-letterhead flex items-start justify-between gap-6 border-b-2 border-black pb-3"
    >
      <div className="min-w-0">
        <h1 className="text-2xl font-bold leading-tight">{name}</h1>
        {clinic?.tagline != null && clinic.tagline !== "" && (
          <p className="text-xs italic">{clinic.tagline}</p>
        )}
        {address !== "" && <p className="mt-1 text-xs">{address}</p>}
        {phones !== "" && <p className="text-xs">{phones}</p>}
        {clinic?.email != null && clinic.email !== "" && <p className="text-xs">{clinic.email}</p>}
        {clinic?.printedWorkingHours != null && clinic.printedWorkingHours !== "" && (
          <p className="text-xs">{clinic.printedWorkingHours}</p>
        )}
      </div>
      {logo !== null && <img src={logo} alt="" className="h-20 w-auto shrink-0" />}
    </header>
  );
}

/** Name, date of birth, age, sex, file number, phone — the block Q45 specifies. */
export function PatientBlock({ patient }: { patient: PatientHeader }) {
  const { name } = printedPatientName(patient);
  const age = ageInYears(patient.dateOfBirth, new Date());

  return (
    <section className="mt-4 grid grid-cols-3 gap-x-6 gap-y-2 border border-neutral-400 p-3">
      <div className="col-span-2">
        <Field label={EN.name} value={name} />
      </div>
      <Field label={EN.fileNo} value={fileReference(patient)} />
      <Field label={EN.dob} value={printedDate(patient.dateOfBirth)} />
      <Field label={EN.age} value={age === null ? "" : `${age} ${EN.years}`} />
      <Field label={EN.sex} value={printedSex(patient.gender)} />
      <div className="col-span-3">
        <Field label={EN.phone} value={patient.phoneE164} />
      </div>
    </section>
  );
}

/** Date, time, doctor and licence number. */
export function VisitBlock({
  visitDate,
  doctor,
}: {
  visitDate: string;
  doctor: DoctorPrintIdentity | null;
}) {
  const doctorName = doctor?.printedNameEn?.trim() || doctor?.printedName?.trim() || "";
  return (
    <section className="mt-2 grid grid-cols-4 gap-x-6 gap-y-2 border border-neutral-400 p-3">
      <Field label={EN.date} value={printedDate(visitDate)} />
      <Field label={EN.time} value={printedTime(visitDate)} />
      <Field label={EN.doctor} value={doctorName} />
      <Field label={EN.licence} value={doctor?.licenseNumber ?? ""} />
    </section>
  );
}

/** Signature and stamp, above the footer rule. */
export function SignatureBlock({
  doctor,
  signature,
  stamp,
}: {
  doctor: DoctorPrintIdentity | null;
  signature: string | null;
  stamp: string | null;
}) {
  const name = doctor?.printedNameEn?.trim() || doctor?.printedName?.trim() || "";
  return (
    <footer id="print-signature" className="print-signature mt-8 flex items-end justify-between gap-6">
      <div>
        <p className="mb-6 text-[10px] uppercase tracking-wide text-neutral-600">{EN.signature}</p>
        <p className="border-t border-black pt-1 text-sm font-semibold">{name}</p>
        {doctor?.syndicateNumber != null && doctor.syndicateNumber !== "" && (
          <p className="text-xs">{`${EN.syndicate} ${doctor.syndicateNumber}`}</p>
        )}
      </div>
      <div className="flex items-end gap-4">
        {signature !== null && <img src={signature} alt="" className="h-14 w-auto" />}
        {stamp !== null && <img src={stamp} alt="" className="h-20 w-auto" />}
      </div>
    </footer>
  );
}

/** The strip at the foot of every sheet: whatever registration numbers the clinic has filled. */
export function PrintFooter({ clinic }: { clinic: ClinicIdentity | null }) {
  const parts = [
    clinic?.taxRegistrationNumber == null || clinic.taxRegistrationNumber === ""
      ? null
      : `Tax Reg. ${clinic.taxRegistrationNumber}`,
    clinic?.commercialRegisterNumber == null || clinic.commercialRegisterNumber === ""
      ? null
      : `Comm. Reg. ${clinic.commercialRegisterNumber}`,
  ].filter((part) => part !== null);

  /*
   * **The credit line renders even when the clinic has filled in neither registration number.**
   *
   * Before the rebrand this whole block returned null in that case, which was right when it held
   * only the clinic's own numbers. It now also carries "Powered by NOMED OS" (item 6), and a credit
   * that appears only on sheets from clinics with a commercial register is a credit that is missing
   * from most of them.
   *
   * The ordering is the point: the clinic's registrations lead, ours is a small line beneath. A
   * prescription is from a patient's doctor, not from us.
   */
  return (
    <div className="mt-3 border-t border-neutral-400 pt-2 text-center">
      {parts.length > 0 && <p className="text-[10px] text-neutral-600">{parts.join("   ·   ")}</p>}
      <p className={parts.length > 0 ? "mt-1" : ""}>
        <PoweredBy />
      </p>
    </div>
  );
}
