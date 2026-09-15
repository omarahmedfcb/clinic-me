// Sick leave on the visit screen — Q46. Days, a start date and an optional note; printed as its
// own page in the same job as the prescription, in English, on the letterhead.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { TextInput, Textarea } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { loadSickLeave, saveSickLeave, type SickLeave } from "./sick-leave-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function SickLeaveSection({
  authFetch,
  appointmentId,
  visitId,
  onChange,
}: {
  authFetch: AuthFetch;
  appointmentId: string;
  visitId: string;
  /** Lifted so the print sheets carry the certificate without fetching it a second time. */
  onChange: (leave: SickLeave) => void;
}) {
  const { t } = useLocale();
  const [days, setDays] = useState("");
  const [from, setFrom] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadSickLeave(authFetch, appointmentId, visitId).then((leave) => {
      if (cancelled) return;
      setDays(leave.days === null ? "" : String(leave.days));
      setFrom(leave.from ?? "");
      setNote(leave.note ?? "");
      onChange(leave);
    });
    return () => {
      cancelled = true;
    };
    // `onChange` deliberately omitted: it is a fresh closure on every render of the parent, and
    // including it would refetch the certificate on every keystroke elsewhere on the screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authFetch, appointmentId, visitId]);

  const parsedDays = Number(days);
  // `days` is a string from an input, and `Number("")` is 0 — the trap `birth-date.ts` records.
  const validDays = days.trim() !== "" && Number.isInteger(parsedDays) && parsedDays > 0;
  const ready = validDays && from !== "";

  async function persist(next: { days: number | null; from: string | null; note: string | null }) {
    setBusy(true);
    setFailed(false);
    const saved = await saveSickLeave(authFetch, appointmentId, visitId, next);
    setBusy(false);
    if (saved === null) {
      setFailed(true);
      return;
    }
    onChange(saved);
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4" data-testid="sick-leave">
      <h3 className="mb-1 text-sm font-semibold text-ink">{t("sickLeave.title")}</h3>
      <p className="mb-3 text-xs text-ink-subtle">{t("sickLeave.hint")}</p>

      {failed && (
        <p role="alert" className="mb-3 text-xs text-danger">
          {t("sickLeave.failed")}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput
          label={t("sickLeave.days")}
          type="number"
          numeric
          min={1}
          max={365}
          value={days}
          onChange={(event) => setDays(event.target.value)}
        />
        <TextInput
          label={t("sickLeave.from")}
          type="date"
          numeric
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
      </div>
      <div className="mt-3">
        <Textarea
          label={t("sickLeave.note")}
          rows={2}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          size="sm"
          disabled={!ready}
          loading={busy}
          data-testid="save-sick-leave"
          onClick={() =>
            void persist({ days: parsedDays, from, note: note.trim() === "" ? null : note.trim() })
          }
        >
          {t("settings.save")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={busy}
          data-testid="clear-sick-leave"
          onClick={() => {
            setDays("");
            setFrom("");
            setNote("");
            // All three clear together: the database refuses half a certificate, so the only way
            // to withdraw one is to remove it whole.
            void persist({ days: null, from: null, note: null });
          }}
        >
          {t("sickLeave.clear")}
        </Button>
      </div>
    </section>
  );
}
