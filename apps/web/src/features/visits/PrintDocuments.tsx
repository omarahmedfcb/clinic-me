// The documents a visit produces, on the clinic's letterhead — Q9, Q29, Q45, Q46.
// Browser print by ruling: no PDF service, no new dependency, and "save as PDF" is the browser's.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  loadClinicIdentity,
  loadDoctorPrintIdentity,
  loadLogo,
  loadSignature,
  loadStamp,
  type ClinicIdentity,
  type DoctorPrintIdentity,
} from "./clinic-identity-api.ts";
import { Letterhead, PatientBlock, PrintFooter, SignatureBlock, VisitBlock } from "./print-blocks.tsx";
import { EN, printedDate, sickLeaveEnd } from "./print-english.ts";
import { PRINT_STYLESHEET } from "./print-styles.ts";
import type { InvestigationLine, PatientHeader, PrescriptionLine } from "./draft-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface PrintableVisit {
  patient: PatientHeader;
  doctorId: string;
  visitDate: string;
  diagnosis: string | null;
  treatmentPlan: string | null;
  complaint: string | null;
  prescription: { notes: string | null; items: PrescriptionLine[] };
  investigations: { freeText: string | null; items: InvestigationLine[] };
  followUpDate: string | null;
  /** Q46. Null days means no certificate, and that sheet is then not printed at all. */
  sickLeave: { days: number | null; from: string | null; note: string | null };
}

interface Props {
  authFetch: AuthFetch;
  visit: PrintableVisit;
}

interface Branding {
  clinic: ClinicIdentity | null;
  doctor: DoctorPrintIdentity | null;
  logo: string | null;
  signature: string | null;
  stamp: string | null;
}

/**
 * Everything the sheets need, fetched once.
 *
 * Object URLs are revoked on unmount. A leaked one holds the image bytes for the life of the tab,
 * and this component remounts every time a visit is opened.
 */
function useBranding(authFetch: AuthFetch, doctorId: string): Branding {
  const [branding, setBranding] = useState<Branding>({
    clinic: null,
    doctor: null,
    logo: null,
    signature: null,
    stamp: null,
  });

  useEffect(() => {
    let cancelled = false;
    const urls: string[] = [];

    void (async () => {
      const [clinic, doctor] = await Promise.all([
        loadClinicIdentity(authFetch),
        loadDoctorPrintIdentity(authFetch, doctorId),
      ]);
      const [logo, signature, stamp] = await Promise.all([
        clinic?.hasLogo === true ? loadLogo(authFetch) : Promise.resolve(null),
        doctor?.hasSignature === true ? loadSignature(authFetch, doctorId) : Promise.resolve(null),
        doctor?.hasStamp === true ? loadStamp(authFetch, doctorId) : Promise.resolve(null),
      ]);
      for (const url of [logo, signature, stamp]) if (url !== null) urls.push(url);
      if (cancelled) {
        for (const url of urls) URL.revokeObjectURL(url);
        return;
      }
      setBranding({ clinic, doctor, logo, signature, stamp });
    })();

    return () => {
      cancelled = true;
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [authFetch, doctorId]);

  return branding;
}

/** The prescription as a table — Q45 names its seven columns. */
function PrescriptionTable({ items }: { items: PrescriptionLine[] }) {
  return (
    <table className="mt-3 w-full border-collapse text-sm">
      <thead>
        <tr className="border-y border-black text-start text-[10px] uppercase tracking-wide">
          <th className="w-8 py-1 pe-2">{EN.no}</th>
          <th className="py-1 pe-2">{EN.medication}</th>
          <th className="py-1 pe-2">{EN.strength}</th>
          <th className="py-1 pe-2">{EN.form}</th>
          <th className="py-1 pe-2">{EN.dosage}</th>
          <th className="py-1 pe-2">{EN.duration}</th>
          <th className="py-1">{EN.quantity}</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, index) => (
          <tr key={index} className="print-line border-b border-neutral-300 align-top">
            <td className="py-1 pe-2">{index + 1}</td>
            <td className="py-1 pe-2 font-semibold">{item.medicationName}</td>
            <td className="py-1 pe-2">{item.strength ?? ""}</td>
            <td className="py-1 pe-2">{item.form ?? ""}</td>
            <td className="py-1 pe-2">
              {[item.dose, item.frequency].filter((part) => part !== "").join(" · ")}
              {item.instructions != null && item.instructions !== "" && (
                <span className="block text-xs">{item.instructions}</span>
              )}
            </td>
            <td className="py-1 pe-2">{item.duration}</td>
            <td className="py-1">{item.quantity ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The sheets, always rendered — Q29 names three and Q46 adds a fourth.
 *
 * A sheet with nothing to say still prints its letterhead and says so, rather than being dropped:
 * the doctor chooses what to hand over, and a document that silently disappears is one they discover
 * is missing at the counter. The sick-leave certificate is the exception, and deliberately: an
 * unissued certificate is not an empty document, it is not a document.
 */
export function PrintDocuments({ authFetch, visit }: Props) {
  const branding = useBranding(authFetch, visit.doctorId);

  const sheet = (title: string, body: React.ReactNode) => (
    <article className="print-sheet mb-8 bg-white p-6 text-black" dir="ltr" lang="en">
      <Letterhead clinic={branding.clinic} logo={branding.logo} />
      <h2 className="mt-4 text-center text-base font-bold tracking-wide">{title}</h2>
      <PatientBlock patient={visit.patient} />
      <VisitBlock visitDate={visit.visitDate} doctor={branding.doctor} />
      {body}
      <SignatureBlock doctor={branding.doctor} signature={branding.signature} stamp={branding.stamp} />
      <PrintFooter clinic={branding.clinic} />
    </article>
  );

  /**
   * **A portal to `document.body`, and this is the whole of the blank-print bug.**
   *
   * The stylesheet hides the application with `body > *:not(#print-root)`. `index.html` mounts React
   * into `<div id="root">`, so this subtree was a *descendant* of `#root` rather than a child of
   * `body` — the rule therefore hid `#root`, and `#print-root` inside it. `display: none` on an
   * ancestor removes the whole subtree, and no `!important` on a descendant can bring it back, which
   * is why the sheet came out blank while every element it names was present in the DOM.
   *
   * The alternative was a selector matching `#root` too. Rejected: it makes the stylesheet depend on
   * the shape of the host page, and the next person to wrap the app in a provider div breaks printing
   * again with nothing failing. A portal makes the markup match the selector instead.
   */
  const host = usePrintHost();
  if (host === null) return null;

  const leave = visit.sickLeave;

  // Rendered *into* the host, which is itself `#print-root`. A wrapper div here would make the
  // sheet a grandchild of body, and `body > *:not(#print-root)` would hide the wrapper and the
  // sheet with it — the same bug one level down. Caught by the structural guard, not by review.
  return createPortal(
    <>
      <style>{PRINT_STYLESHEET}</style>

      {sheet(
        EN.prescription,
        <>
          {visit.prescription.items.length === 0 ? (
            <p className="mt-3 text-sm">{EN.nothingPrescribed}</p>
          ) : (
            <PrescriptionTable items={visit.prescription.items} />
          )}
          {visit.followUpDate !== null && (
            <p className="mt-4 text-sm">
              <span className="font-semibold">{`${EN.followUp}: `}</span>
              {printedDate(visit.followUpDate)}
            </p>
          )}
          {visit.prescription.notes != null && visit.prescription.notes !== "" && (
            <p className="mt-2 whitespace-pre-wrap text-sm">
              <span className="font-semibold">{`${EN.notes}: `}</span>
              {visit.prescription.notes}
            </p>
          )}
        </>,
      )}

      {sheet(
        EN.report,
        <dl className="mt-3 grid gap-2 text-sm">
          {(
            [
              [EN.complaint, visit.complaint],
              [EN.diagnosis, visit.diagnosis],
              [EN.plan, visit.treatmentPlan],
            ] as [string, string | null][]
          ).map(([label, value]) => (
            <div key={label} className="print-line">
              <dt className="text-[10px] uppercase tracking-wide text-neutral-600">{label}</dt>
              <dd className="whitespace-pre-wrap">{value ?? EN.notRecorded}</dd>
            </div>
          ))}
          {visit.followUpDate !== null && (
            <div className="print-line">
              <dt className="text-[10px] uppercase tracking-wide text-neutral-600">{EN.followUp}</dt>
              <dd>{printedDate(visit.followUpDate)}</dd>
            </div>
          )}
        </dl>,
      )}

      {sheet(
        EN.investigations,
        visit.investigations.items.length === 0 && visit.investigations.freeText === null ? (
          <p className="mt-3 text-sm">{EN.nothingRequested}</p>
        ) : (
          <>
            <ol className="mt-3 grid gap-2">
              {visit.investigations.items.map((item, index) => (
                <li key={index} className="print-line text-sm">
                  <span className="font-semibold">{item.name}</span>
                  {item.notes != null && item.notes !== "" && ` — ${item.notes}`}
                </li>
              ))}
            </ol>
            {visit.investigations.freeText !== null && (
              <p className="mt-3 whitespace-pre-wrap text-sm">{visit.investigations.freeText}</p>
            )}
          </>
        ),
      )}

      {leave.days !== null &&
        leave.from !== null &&
        sheet(
          EN.sickLeave,
          <>
            <p className="mt-4 text-sm">{EN.sickLeaveSentence}</p>
            <div className="mt-4 grid grid-cols-3 gap-x-6 border border-neutral-400 p-3 text-sm">
              <div>
                <span className="block text-[10px] uppercase tracking-wide text-neutral-600">
                  {EN.sickLeaveDays}
                </span>
                <span>{leave.days}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wide text-neutral-600">
                  {EN.sickLeaveFrom}
                </span>
                <span>{printedDate(leave.from)}</span>
              </div>
              <div>
                <span className="block text-[10px] uppercase tracking-wide text-neutral-600">
                  {EN.sickLeaveTo}
                </span>
                <span>{sickLeaveEnd(leave.from, leave.days)}</span>
              </div>
            </div>
            {leave.note != null && leave.note !== "" && (
              <p className="mt-3 whitespace-pre-wrap text-sm">{leave.note}</p>
            )}
          </>,
        )}
    </>,
    host,
  );
}

/**
 * A `div` appended to `document.body` for the life of the component.
 *
 * Created in an effect rather than at module scope so that nothing is appended to a document that
 * may not exist yet, and removed on unmount so a screen opened twice does not leave two print roots
 * behind — two would both match the allow-list and print everything twice.
 */
function usePrintHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const created = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = document.createElement("div");
    // The host **is** the print root: the stylesheet's allow-list names a direct child of body.
    element.id = "print-root";
    element.setAttribute("data-testid", "print-root");
    document.body.appendChild(element);
    created.current = element;
    setHost(element);
    return () => {
      element.remove();
      created.current = null;
      setHost(null);
    };
  }, []);

  return host;
}
