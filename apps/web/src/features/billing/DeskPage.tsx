// The desk — Phase 5 PR 9. The charge, its lines, the discount, the payer split, part-payments,
// the printed invoice and receipt. Reached from the payments screen and the appointment panel.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  applyDiscount,
  loadCharge,
  loadSplit,
  PAYMENT_METHODS,
  recordPayment,
  setPayerShare,
  type DeskCharge,
  type PayerSplit,
  type PaymentMethod,
  type Receipt,
} from "./billing-api.ts";
import { CreditPanel } from "./CreditPanel.tsx";
import { ReceiptSheet } from "./ReceiptSheet.tsx";
import { InvoiceSheet } from "./InvoiceSheet.tsx";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** What the insurer's share is being entered as. The wire only ever carries an amount. */
type ShareMode = "AMOUNT" | "PERCENT";

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

      <Card
        title={t("desk.lines")}
        actions={
          <Button size="sm" variant="secondary" data-testid="print-invoice" onClick={() => setInvoicing(true)}>
            {t("desk.printInvoice")}
          </Button>
        }
      >
        <ul className="flex flex-col gap-1" data-testid="charge-lines">
          {charge.lines.map((line) => (
            <li key={line.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-ink">
                {line.nameSnapshot}
                {line.quantity > 1 && <span className="numeric ms-2 text-ink-subtle">×{line.quantity}</span>}
                {line.adjustedBy !== null && (
                  <span className="ms-2 text-xs text-ink-subtle">
                    {`${t("desk.adjustedBy")} ${line.adjustedBy}`}
                    {line.adjustmentReason !== null && ` — ${line.adjustmentReason}`}
                  </span>
                )}
              </span>
              <span className="numeric text-ink">{money(line.unitPriceMinor * line.quantity)}</span>
            </li>
          ))}
        </ul>

        {/*
          **Negative amounts are formatted as negative numbers, never signed by hand.** `Intl` puts
          an LRM immediately before its own minus so the sign stays inside the number's
          left-to-right run; a `−` concatenated in front sits outside that run and, in an Arabic
          paragraph, renders detached from the figure it belongs to.
        */}
        <dl className="mt-4 grid gap-1 border-t border-border pt-3 text-sm">
          <Row label={t("desk.subtotal")} value={money(charge.subtotalMinor)} />
          {charge.discountMinor > 0 && (
            <Row label={t("desk.discount")} value={money(-charge.discountMinor)} testId="discount-row" />
          )}
          {charge.payerShareMinor > 0 && (
            <Row label={t("desk.payerShare")} value={money(-charge.payerShareMinor)} />
          )}
          <Row label={t("desk.patientShare")} value={money(charge.patientShareMinor)} />
          <Row label={t("desk.paid")} value={money(charge.paidMinor)} />
          <Row label={t("desk.balance")} value={money(charge.balanceMinor)} strong testId="balance" />
        </dl>
      </Card>

      <div className="mt-4">
        <Card title={t("desk.discountTitle")}>
          {charge.discountCeilingMinor !== null && (
            <p className="mb-2 text-xs text-ink-subtle" data-testid="ceiling-hint">
              {t("desk.ceilingHint").replace("{amount}", money(charge.discountCeilingMinor))}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <MoneyInput
              label={t("desk.discountAmount")}
              currency={currency}
              valueMinor={discountMinor}
              onChangeMinor={setDiscountMinor}
              data-testid="discount-amount"
            />
            <TextInput
              label={t("desk.discountReason")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          <div className="mt-3">
            <Button
              size="sm"
              loading={busy}
              // A discount with no reason is refused by the database; saying so before the round
              // trip is kinder than a refusal that arrives after the patient has been told a total.
              disabled={discountMinor === null || reason.trim() === ""}
              data-testid="apply-discount"
              onClick={() => void onDiscount()}
            >
              {t("desk.applyDiscount")}
            </Button>
          </div>
        </Card>
      </div>

      {/*
        **No input on an impossible action.** A patient with no policy has nobody to split with, so
        the section states that and offers nothing — a box that can only ever be refused is worse
        than no box, because it reads as a thing the clinic could do and simply did not.
      */}
      <div className="mt-4">
        <Card title={t("desk.splitTitle")} subtitle={split?.payerName ?? t("desk.noPayer")}>
          {!hasCover ? (
            <p className="text-sm text-ink-muted" data-testid="no-cover">
              {t("desk.noPayerExplain")}
            </p>
          ) : (
            <>
              <div className="mb-3 flex gap-2" role="group" aria-label={t("desk.shareMode")}>
                {(["AMOUNT", "PERCENT"] as const).map((mode) => (
                  <Button
                    key={mode}
                    size="sm"
                    variant={shareMode === mode ? "secondary" : "ghost"}
                    aria-pressed={shareMode === mode}
                    data-testid={`share-mode-${mode}`}
                    onClick={() => setShareMode(mode)}
                  >
                    {t(mode === "AMOUNT" ? "desk.shareAsAmount" : "desk.shareAsPercent")}
                  </Button>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                {shareMode === "AMOUNT" ? (
                  <MoneyInput
                    label={t("desk.payerShareAmount")}
                    currency={currency}
                    valueMinor={payerShareMinor}
                    onChangeMinor={setPayerShareMinor}
                    data-testid="payer-share-amount"
                  />
                ) : (
                  <TextInput
                    label={t("desk.payerSharePercent")}
                    numeric
                    inputMode="decimal"
                    value={payerPercent}
                    data-testid="payer-share-percent"
                    onChange={(event) => setPayerPercent(event.target.value)}
                  />
                )}
              </div>

              {shareMode === "PERCENT" && percentAsMinor !== null && (
                <p className="mt-2 text-xs text-ink-subtle" data-testid="percent-preview">
                  {t("desk.sharePreview")
                    .replace("{percent}", payerPercent.trim())
                    .replace("{amount}", money(percentAsMinor))}
                </p>
              )}

              <div className="mt-3">
                <Button
                  size="sm"
                  loading={busy}
                  disabled={shareToSend === null}
                  data-testid="set-split"
                  onClick={() => void onSplit()}
                >
                  {t("desk.setSplit")}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>

      <div className="mt-4">
        <Card title={t("desk.paymentTitle")}>
          <p className="mb-2 text-xs text-ink-subtle" data-testid="due-hint">
            {t("desk.dueHint").replace("{amount}", money(charge.balanceMinor))}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <MoneyInput
              label={t("desk.amount")}
              currency={currency}
              valueMinor={amountMinor}
              onChangeMinor={setAmountMinor}
              data-testid="payment-amount"
            />
            <Select
              label={t("desk.method")}
              value={method}
              options={PAYMENT_METHODS.map((value) => ({
                value,
                label: t(`payment.method.${value}` as TranslationKey),
              }))}
              onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            />
          </div>

          {/* **Refused, not said** — R-A. The server returns 422 either way; the button says so
              first, because a receptionist should learn it before the patient is told a total. */}
          {overBalance && (
            <p role="alert" className="mt-2 text-xs text-danger" data-testid="over-balance">
              {t("desk.overBalance").replace("{amount}", money(charge.balanceMinor))}
            </p>
          )}

          <div className="mt-3">
            <Button
              size="sm"
              loading={busy}
              disabled={amountMinor === null || amountMinor <= 0 || overBalance}
              data-testid="record-payment"
              onClick={() => void onPay()}
            >
              {t("desk.recordPayment")}
            </Button>
          </div>

          {charge.receipts.length > 0 && (
            <ul className="mt-4 flex flex-col gap-1 border-t border-border pt-3" data-testid="receipts">
              {charge.receipts.map((receipt) => (
                <li key={receipt.paymentId} className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-ink">
                    <span className="numeric">#{receipt.receiptNumber}</span>
                    <span className="ms-2 text-ink-subtle">
                      {t(`payment.method.${receipt.method}` as TranslationKey)}
                    </span>
                    <span className="numeric ms-2 text-ink-subtle">{receipt.receiptDate}</span>
                  </span>
                  <span className="flex items-baseline gap-3">
                    <span className="numeric text-ink">{money(receipt.amountMinor)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid={`print-${receipt.paymentId}`}
                      onClick={() => setPrinting(receipt)}
                    >
                      {t("print.button")}
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
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
        <ReceiptSheet authFetch={authFetch} charge={charge} receipt={printing} currency={currency} />
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

function Row({
  label,
  value,
  strong,
  testId,
}: {
  label: string;
  value: string;
  strong?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong === true ? "font-semibold text-ink" : "text-ink-muted"}>{label}</dt>
      <dd
        className={`numeric ${strong === true ? "font-semibold text-ink" : "text-ink"}`}
        data-testid={testId}
      >
        {value}
      </dd>
    </div>
  );
}
