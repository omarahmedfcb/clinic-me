// The printed receipt — Phase 5 PR 9. English, on the letterhead, like every other printed sheet
// (Q45): receipt number, receipt date, and the clinic's tax registration number.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  loadClinicIdentity,
  loadLogo,
  type ClinicIdentity,
} from "../visits/clinic-identity-api.ts";
import { Letterhead } from "../visits/print-blocks.tsx";
import { EN, printedDate } from "../visits/print-english.ts";
import { PRINT_STYLESHEET } from "../visits/print-styles.ts";
import type { DeskCharge, Receipt } from "./billing-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Minor units to a plain decimal. The sheet is English, so the grouping is too (Q45). */
function printedAmount(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

/**
 * One sheet per receipt.
 *
 * The tax registration number is printed whether or not the clinic has filled it — when it has not,
 * the line is omitted rather than printed empty, which is the rule the letterhead already follows.
 * **No e-receipt integration:** this is structure only, as ruled.
 */
export function ReceiptSheet({
  authFetch,
  charge,
  receipt,
  currency,
}: {
  authFetch: AuthFetch;
  charge: DeskCharge;
  receipt: Receipt;
  currency: string;
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

  const host = usePrintHost();
  if (host === null) return null;

  return createPortal(
    <>
      <style>{PRINT_STYLESHEET}</style>
      <article className="print-sheet mb-8 bg-white p-6 text-black" dir="ltr" lang="en">
        <Letterhead clinic={clinic} logo={logo} />
        <h2 className="mt-4 text-center text-base font-bold tracking-wide">RECEIPT</h2>

        <section className="mt-4 grid grid-cols-3 gap-x-6 gap-y-2 border border-neutral-400 p-3">
          <div>
            <span className="block text-[10px] uppercase tracking-wide text-neutral-600">
              Receipt No.
            </span>
            <span className="text-sm">{receipt.receiptNumber}</span>
          </div>
          <div>
            <span className="block text-[10px] uppercase tracking-wide text-neutral-600">
              {EN.date}
            </span>
            <span className="text-sm">{printedDate(receipt.receiptDate)}</span>
          </div>
          <div>
            <span className="block text-[10px] uppercase tracking-wide text-neutral-600">Method</span>
            <span className="text-sm">{receipt.method}</span>
          </div>
        </section>

        <section className="mt-2 border border-neutral-400 p-3">
          <span className="block text-[10px] uppercase tracking-wide text-neutral-600">
            Received from
          </span>
          <span className="text-sm">{charge.patientName}</span>
        </section>

        <table className="mt-4 w-full border-collapse text-sm">
          <tbody>
            <tr className="border-b border-neutral-300">
              <td className="py-1">Invoice total</td>
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
                <td className="py-1">Payer share</td>
                <td className="py-1 text-end">{printedAmount(-charge.payerShareMinor, currency)}</td>
              </tr>
            )}
            <tr className="border-b border-black font-semibold">
              <td className="py-1">Amount received</td>
              <td className="py-1 text-end">{printedAmount(receipt.amountMinor, currency)}</td>
            </tr>
            <tr>
              <td className="py-1">Balance</td>
              <td className="py-1 text-end">{printedAmount(charge.balanceMinor, currency)}</td>
            </tr>
          </tbody>
        </table>

        {receipt.collectedBy !== null && (
          <p className="mt-6 text-xs">{`Received by: ${receipt.collectedBy}`}</p>
        )}

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

/**
 * A `div` appended to `document.body`, which **is** `#print-root`.
 *
 * The same shape `PrintDocuments` uses, and for the same reason: the stylesheet hides everything
 * with `body > *:not(#print-root)`, so a sheet rendered inside `#root` is hidden along with its
 * ancestor and the paper comes out blank (Q43).
 */
function usePrintHost(): HTMLElement | null {
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
    };
  }, []);

  return host;
}
