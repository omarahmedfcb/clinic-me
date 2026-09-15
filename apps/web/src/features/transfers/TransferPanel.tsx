import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { Select, Textarea } from "../../design-system/fields.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { interpolate } from "../../i18n/interpolate.tsx";
import type { DoctorSummary } from "../schedules/schedules-api.ts";
import { waitedMinutes, type Transfer } from "./transfers-api.ts";

/**
 * The transfer surfaces: the badge on a queue row, the request dialog, and the decision list.
 *
 * ## The patient never leaves the original doctor's queue
 *
 * `PHASE-3.md` Q16, and the founder's wording for it: **a patient physically present must appear in
 * exactly one queue at all times.** So a pending transfer is a *badge on the existing row*, never a
 * second list and never a move. Not zero queues, which is a patient nobody calls; not two, which is
 * two receptionists each assuming the other has them.
 */

/** How long it has waited, rendered. There is no timeout, so the elapsed time is the whole signal. */
export function TransferBadge({ transfer, now }: { transfer: Transfer; now: Date }) {
  const { t } = useLocale();
  const minutes = waitedMinutes(transfer.requestedAt, now);

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning"
      // A plain-text attribute cannot carry <bdi>, so the tooltip keeps the raw replace. It is the
      // one place the reordering is harmless: a tooltip is read on its own, not inside a sentence.
      title={t("transfer.badge.title").replace("{doctor}", transfer.toDoctorName)}
    >
      {interpolate(t("transfer.badge.pending"), { doctor: transfer.toDoctorName })}
      {" · "}
      <span className="numeric">{t("transfer.badge.waiting").replace("{minutes}", String(minutes))}</span>
    </span>
  );
}

interface RequestDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  doctors: DoctorSummary[];
  /** The doctor the patient is currently with — excluded, because a transfer to them is not one. */
  currentDoctorId: string;
  patientName: string;
  busy: boolean;
  onSubmit: (toDoctorId: string, reason: string) => void;
}

export function RequestTransferDialog({
  open,
  onOpenChange,
  doctors,
  currentDoctorId,
  patientName,
  busy,
  onSubmit,
}: RequestDialogProps) {
  const { t } = useLocale();
  const [toDoctorId, setToDoctorId] = useState("");
  const [reason, setReason] = useState("");

  const options = doctors
    .filter((doctor) => doctor.id !== currentDoctorId)
    .map((doctor) => ({ value: doctor.id, label: `${doctor.title} ${doctor.fullName} — ${doctor.specialty}` }));

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("transfer.request.title")}
      description={t("transfer.request.description").replace("{patient}", patientName)}
      /* Modal description is a string prop; the only substituted value is one name, alone at the
         end of the sentence, where isolation changes nothing. */
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("transfer.cancel")}
          </Button>
          <Button
            disabled={busy || toDoctorId === ""}
            onClick={() => onSubmit(toDoctorId, reason)}
          >
            {busy ? t("transfer.working") : t("transfer.request.submit")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label={t("transfer.request.toDoctor")}
          value={toDoctorId}
          onChange={(event) => setToDoctorId(event.target.value)}
          options={options}
          placeholder={t("transfer.request.pickDoctor")}
          required
        />
        {/* Optional on a request. A REJECTION's reason is required, and that is a different field. */}
        <Textarea
          label={t("transfer.request.reason")}
          hint={t("transfer.request.reasonHint")}
          rows={3}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
    </Modal>
  );
}

interface DecisionListProps {
  transfers: Transfer[];
  /** The caller's own doctor id, or null for reception. Only the receiving doctor may decide. */
  ownDoctorId: string | null;
  now: Date;
  busyId: string | null;
  onDecide: (transfer: Transfer, decision: "accept" | "reject", note: string) => void;
}

/**
 * Pending requests, from whichever side the viewer is on.
 *
 * Reception sees every open request and can act on none — that is the point of showing it to them:
 * *"reception initiated it; they need to see it sitting there unanswered."* The originating doctor
 * sees theirs going out. Only the receiving doctor gets buttons.
 */
export function TransferDecisionList({ transfers, ownDoctorId, now, busyId, onDecide }: DecisionListProps) {
  const { t } = useLocale();
  const [notes, setNotes] = useState<Record<string, string>>({});

  if (transfers.length === 0) return null;

  return (
    <Card title={t("transfer.pending.title")} subtitle={t("transfer.pending.subtitle")}>
      <ul className="flex flex-col">
        {transfers.map((transfer) => {
          const mine = ownDoctorId !== null && transfer.toDoctorId === ownDoctorId;
          const note = notes[transfer.id] ?? "";
          const busy = busyId === transfer.id;

          return (
            <li key={transfer.id} className="flex flex-col gap-2 border-b border-border py-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{transfer.patientName}</span>
                <span className="text-sm text-ink-muted">
                  {interpolate(t("transfer.pending.fromTo"), {
                    from: transfer.fromDoctorName,
                    to: transfer.toDoctorName,
                  })}
                </span>
                <span className="numeric rounded-full bg-warning-soft px-2 py-0.5 text-xs text-warning">
                  {t("transfer.badge.waiting").replace(
                    "{minutes}",
                    String(waitedMinutes(transfer.requestedAt, now)),
                  )}
                </span>
              </div>

              {transfer.reason !== null && (
                <p className="text-sm text-ink-muted">
                  {/* The label is interface language, the reason is whatever reception typed --
                      usually Arabic. Isolated so the colon stays with the label. */}
                  {t("transfer.pending.reason")}: <bdi>{transfer.reason}</bdi>
                </p>
              )}

              {mine ? (
                <div className="flex flex-col gap-2">
                  {/*
                    Required on reject, and the server refuses without it. Reception has to decide
                    whether to try another doctor or come and find you, and "no" does not say which.
                  */}
                  <Textarea
                    label={t("transfer.decide.note")}
                    hint={t("transfer.decide.noteHint")}
                    rows={2}
                    value={note}
                    onChange={(event) => setNotes((current) => ({ ...current, [transfer.id]: event.target.value }))}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={busy} onClick={() => onDecide(transfer, "accept", note)}>
                      {busy ? t("transfer.working") : t("transfer.decide.accept")}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy || note.trim().length === 0}
                      onClick={() => onDecide(transfer, "reject", note)}
                    >
                      {t("transfer.decide.reject")}
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-ink-muted">{t("transfer.pending.awaiting")}</p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
