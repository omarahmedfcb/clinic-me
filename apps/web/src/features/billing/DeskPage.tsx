// The desk — Phase 5 PR 9. The charge, its lines, the discount, the payer split, part-payments,
// the printed invoice and receipt. Reached from the payments screen and the appointment panel.

import { useCallback, useEffect, useState } from "react";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  applyDiscount,
  loadCharge,
  loadSplit,
  recordPayment,
  setPayerShare,
  type DeskCharge,
  type PayerSplit,
  type PaymentMethod,
  type Receipt,
} from "./billing-api.ts";
import { CreditPanel } from "./CreditPanel.tsx";
import { DeskChargeCard } from "./DeskChargeCard.tsx";
import { DeskDiscountCard } from "./DeskDiscountCard.tsx";
import { DeskPaymentCard } from "./DeskPaymentCard.tsx";
import { DeskSplitCard, type ShareMode } from "./DeskSplitCard.tsx";
import { ReceiptSheet } from "./ReceiptSheet.tsx";
import { InvoiceSheet } from "./InvoiceSheet.tsx";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function DeskPage({
  authFetch,
  chargeId,
  currency,
}: {
  authFetch: AuthFetch;
  chargeId: string;
  currency: string;
}) {
  const { t, locale } = useLocale();
  const [charge, setCharge] = useState<DeskCharge | null>(null);
  const [split, setSplit] = useState<PayerSplit | null>(null);
  const [discountMinor, setDiscountMinor] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [shareMode, setShareMode] = useState<ShareMode>("AMOUNT");
  const [payerShareMinor, setPayerShareMinor] = useState<number | null>(null);
  const [payerPercent, setPayerPercent] = useState("");
  const [amountMinor, setAmountMinor] = useState<number | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [printing, setPrinting] = useState<Receipt | null>(null);
  const [invoicing, setInvoicing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ code: string; params: Record<string, unknown> } | null>(null);

  const money = (minor: number): string => formatMinor(minor, currency, locale);

  const refresh = useCallback(async () => {
    const [next, nextSplit] = await Promise.all([
      loadCharge(authFetch, chargeId),
      loadSplit(authFetch, chargeId),
    ]);
    setCharge(next);
    setSplit(nextSplit);
    // **The collection box is prefilled with what is actually left to pay.** Reception's ordinary
    // act is "take all of it", and making them retype a figure the screen already knows is where a
    // wrong amount comes from. It stays editable downward for a part-payment.
    setAmountMinor(next === null || next.balanceMinor <= 0 ? null : next.balanceMinor);
  }, [authFetch, chargeId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** A refusal carries `{ code, params }`; the params are what make the sentence specific. */
  function say(code: string, params: Record<string, unknown>): string {
    const sentence = t(`refusal.${code}` as TranslationKey);
    return Object.entries(params).reduce(
      (text, [key, value]) =>
        text.replace(
          `{${key}}`,
          typeof value === "number" && key !== "actual" ? money(value) : String(value),
        ),
      sentence,
    );
  }

  async function onDiscount(): Promise<void> {
    if (discountMinor === null) return;
    setBusy(true);
    setFailure(null);
    const result = await applyDiscount(authFetch, chargeId, discountMinor, reason);
    setBusy(false);
    if (!result.ok) {
      setFailure({ code: result.code, params: result.params });
      return;
    }
    await refresh();
  }

  async function onSplit(): Promise<void> {
    if (shareToSend === null) return;
    setBusy(true);
    setFailure(null);
    const result = await setPayerShare(authFetch, chargeId, shareToSend);
    setBusy(false);
    if (!result.ok) {
      setFailure({ code: result.code, params: result.params });
      return;
    }
    setSplit(result.split);
    await refresh();
  }

  async function onPay(): Promise<void> {
    if (charge === null || amountMinor === null) return;
    setBusy(true);
    setFailure(null);
    const result = await recordPayment(authFetch, {
      chargeId,
      patientId: charge.patientId,
      appointmentId: null,
      amountMinor,
      method,
    });
    setBusy(false);
    if (!result.ok) {
      setFailure({ code: result.code, params: result.params });
      return;
    }
    await refresh();
    // Printed straight away: the patient is standing there, and a receipt they have to ask for is
    // a receipt half of them leave without.
    setPrinting(result.receipt);
  }

  if (charge === null) {
    return <p className="p-6 text-sm text-ink-muted">{t("desk.loading")}</p>;
  }

  // The percentage is of what the invoice charges after its discount — the figure a policy is
  // actually written against. Converted here so the wire and the database only ever see money.
  const shareBase = charge.subtotalMinor - charge.discountMinor;
  const percentAsMinor =
    payerPercent.trim() === "" || !Number.isFinite(Number(payerPercent))
      ? null
      : Math.round((shareBase * Number(payerPercent)) / 100);
  const shareToSend = shareMode === "PERCENT" ? percentAsMinor : payerShareMinor;

  // Refused before the round trip as well as by the server: a receptionist who has typed more than
  // the patient owes should be told by the button, not by a sentence arriving afterwards.
  const overBalance = amountMinor !== null && amountMinor > charge.balanceMinor;
  const hasCover = split !== null && split.payerName !== null;

  return (
    <main className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-lg font-semibold text-ink">{t("desk.title")}</h1>
      <p className="mb-4 text-sm text-ink-muted">{charge.patientName}</p>

      {failure !== null && (
        <p role="alert" className="mb-3 text-xs text-danger" data-testid="desk-failure">
          {say(failure.code, failure.params)}
        </p>
      )}

      <DeskChargeCard charge={charge} currency={currency} onPrintInvoice={() => setInvoicing(true)} />

      <div className="mt-4">
        <DeskDiscountCard
          charge={charge}
          currency={currency}
          discountMinor={discountMinor}
          onDiscountMinor={setDiscountMinor}
          reason={reason}
          onReason={setReason}
          busy={busy}
          onApply={() => void onDiscount()}
        />
      </div>

      {/*
        **No input on an impossible action.** A patient with no policy has nobody to split with, so
        the section states that and offers nothing — a box that can only ever be refused is worse
        than no box, because it reads as a thing the clinic could do and simply did not.
      */}
      <div className="mt-4">
        <DeskSplitCard
          payerName={split?.payerName}
          hasCover={hasCover}
          currency={currency}
          shareMode={shareMode}
          onShareMode={setShareMode}
          payerShareMinor={payerShareMinor}
          onPayerShareMinor={setPayerShareMinor}
          payerPercent={payerPercent}
          onPayerPercent={setPayerPercent}
          percentAsMinor={percentAsMinor}
          shareToSend={shareToSend}
          busy={busy}
          onSet={() => void onSplit()}
        />
      </div>

      <div className="mt-4">
        <DeskPaymentCard
          charge={charge}
          currency={currency}
          amountMinor={amountMinor}
          onAmountMinor={setAmountMinor}
          method={method}
          onMethod={setMethod}
          overBalance={overBalance}
          busy={busy}
          onPay={() => void onPay()}
          onPrint={setPrinting}
        />
      </div>

      {/* Credit at the desk: the balance, and spending it against this bill. Refunding is the
          patient card's, because the desk is where money is taken. */}
      <div className="mt-4">
        <CreditPanel
          authFetch={authFetch}
          patientId={charge.patientId}
          currency={currency}
          chargeId={chargeId}
          chargeBalanceMinor={charge.balanceMinor}
          onChanged={() => void refresh()}
        />
      </div>

      {printing !== null && (
        <ReceiptSheet
          authFetch={authFetch}
          charge={charge}
          receipt={printing}
          currency={currency}
          onDone={() => setPrinting(null)}
        />
      )}
      {invoicing && (
        <InvoiceSheet
          authFetch={authFetch}
          charge={charge}
          currency={currency}
          onClose={() => setInvoicing(false)}
        />
      )}
    </main>
  );
}
