// The printed invoice — the charge as a document: lines, discount, insurer share, paid, remaining.
// English on the letterhead (Q45), and separate from the per-payment receipt, which prints its own.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { loadClinicIdentity, loadLogo, type ClinicIdentity } from "../visits/clinic-identity-api.ts";
import { Letterhead } from "../visits/print-blocks.tsx";
import { EN, printedDate } from "../visits/print-english.ts";
import { PRINT_STYLESHEET } from "../visits/print-styles.ts";
import type { DeskCharge } from "./billing-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Minor units to a plain decimal. The sheet is English, so the grouping is too (Q45). */
function printedAmount(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

/**
 * One sheet per charge.
 *
 * **The invoice number is the charge id**, which is what the desk, the payments screen and the
 * database all already agree on — inventing a second sequence would give the same document two
 * identities. The receipt keeps its own gapless number, because a receipt is a different document
 * about a different act.
 */
export function InvoiceSheet({
  authFetch,
  charge,
  currency,
  onClose,
}: {
  authFetch: AuthFetch;
  charge: DeskCharge;
  currency: string;
  onClose: () => void;
}) {
  const [clinic, setClinic] = useState<ClinicIdentity | null>(null);
  const [logo, setLogo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      const identity = await loadClinicIdentity(authFetch);
      const url = identity?.hasLogo === true ? await loadLogo(authFetch) : null;
      objectUrl = url;
      if (cancelled) {
        if (url !== null) URL.revokeObjectURL(url);
        return;
      }
      setClinic(identity);
      setLogo(url);
    })();
    return () => {
      cancelled = true;
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [authFetch]);

  const host = usePrintHost(onClose);
  if (host === null) return null;

  return createPortal(
    <>
      <style>{PRINT_STYLESHEET}</style>
      <article className="print-sheet mb-8 bg-white p-6 text-black" dir="ltr" lang="en">
        <Letterhead clinic={clinic} logo={logo} />
        <h2 className="mt-4 text-center text-base font-bold tracking-wide">INVOICE</h2>

        <section className="mt-4 grid grid-cols-3 gap-x-6 gap-y-2 border border-neutral-400 p-3">
          <Field label="Invoice No." value={charge.chargeId} />
          <Field label={EN.date} value={printedDate(charge.issuedOn)} />
          <Field label="File No." value={String(charge.patientFileNumber)} />
        </section>

        <section className="mt-2 border border-neutral-400 p-3">
          <span className="block text-[10px] uppercase tracking-wide text-neutral-600">Patient</span>
          <span className="text-sm">{charge.patientName}</span>
        </section>

        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-black text-start">
              <th className="py-1 text-start font-semibold">#</th>
              <th className="py-1 text-start font-semibold">Item</th>
              <th className="py-1 text-end font-semibold">Qty</th>
              <th className="py-1 text-end font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {charge.lines.map((line, index) => (
              <tr key={line.id} className="border-b border-neutral-300">
                <td className="py-1">{index + 1}</td>
                <td className="py-1">{line.nameSnapshot}</td>
                <td className="py-1 text-end">{line.quantity}</td>
                <td className="py-1 text-end">
                  {printedAmount(line.unitPriceMinor * line.quantity, currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="mt-4 w-full border-collapse text-sm">
          <tbody>
            <tr className="border-b border-neutral-300">
              <td className="py-1">Subtotal</td>
              <td className="py-1 text-end">{printedAmount(charge.subtotalMinor, currency)}</td>
            </tr>
            {charge.discountMinor > 0 && (
              <tr className="border-b border-neutral-300">
                <td className="py-1">Discount</td>
                <td className="py-1 text-end">{printedAmount(-charge.discountMinor, currency)}</td>
              </tr>
            )}
            {charge.payerShareMinor > 0 && (
              <tr className="border-b border-neutral-300">
                <td className="py-1">Insurer share</td>
                <td className="py-1 text-end">{printedAmount(-charge.payerShareMinor, currency)}</td>
              </tr>
            )}
            <tr className="border-b border-neutral-300">
              <td className="py-1">Patient owes</td>
              <td className="py-1 text-end">{printedAmount(charge.patientShareMinor, currency)}</td>
            </tr>
            <tr className="border-b border-neutral-300">
              <td className="py-1">Paid</td>
              <td className="py-1 text-end">{printedAmount(charge.paidMinor, currency)}</td>
            </tr>
            <tr className="border-b border-black font-semibold">
              <td className="py-1">Remaining</td>
              <td className="py-1 text-end">{printedAmount(charge.balanceMinor, currency)}</td>
            </tr>
          </tbody>
        </table>

        {clinic?.taxRegistrationNumber != null && clinic.taxRegistrationNumber !== "" && (
          <p className="mt-4 border-t border-neutral-400 pt-2 text-center text-[10px] text-neutral-600">
            {`Tax Reg. ${clinic.taxRegistrationNumber}`}
          </p>
        )}
      </article>
    </>,
    host,
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="block text-[10px] uppercase tracking-wide text-neutral-600">{label}</span>
      <span className="text-sm break-all">{value}</span>
    </div>
  );
}

/**
 * A `div` appended to `document.body`, which **is** `#print-root` (Q43).
 *
 * The stylesheet hides `body > *:not(#print-root)`, so a sheet rendered inside `#root` is hidden
 * along with its ancestor and the paper comes out blank. Unmounted on close, so the next print job
 * does not find two sheets.
 */
function usePrintHost(onClose: () => void): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  const created = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = document.createElement("div");
    element.id = "print-root";
    element.setAttribute("data-testid", "print-root");
    document.body.appendChild(element);
    created.current = element;
    setHost(element);
    return () => {
      element.remove();
      created.current = null;
      setHost(null);
      onClose();
    };
    // `onClose` is a fresh closure each render; including it would tear the host down mid-print.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return host;
}
