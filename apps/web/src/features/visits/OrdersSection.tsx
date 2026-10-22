// What the visit orders: investigations and the prescription — Q24, with Q8's autocomplete.
// Both are saved explicitly: a list being edited row by row must not autosave a half-typed line.

import { useEffect, useRef, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { DrugNameField } from "./DrugNameField.tsx";
import { PrintSheetButton } from "./PrintSheetButton.tsx";
import { TextInput, Textarea } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import {
  loadInvestigations,
  loadPrescription,
  saveInvestigations,
  savePrescription,
  type InvestigationLine,
  type PrescriptionLine,
} from "./draft-api.ts";
import { usePendingSave } from "./pending-saves.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface Props {
  authFetch: AuthFetch;
  appointmentId: string;
  visitId: string;
}

const EMPTY_INVESTIGATION: InvestigationLine = { name: "", notes: null };
const EMPTY_MEDICATION: PrescriptionLine = {
  medicationName: "",
  strength: null,
  form: null,
  quantity: null,
  dose: "",
  frequency: "",
  duration: "",
  instructions: null,
};

export function InvestigationsSection({
  authFetch,
  appointmentId,
  visitId,
}: Props) {
  const { t } = useLocale();
  const [freeText, setFreeTextRaw] = useState("");
  const [items, setItemsRaw] = useState<InvestigationLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // True once the doctor has changed something that is not saved yet.
  const changed = useRef(false);

  const setFreeText = (next: string): void => {
    changed.current = true;
    setSaved(false);
    setFreeTextRaw(next);
  };
  const setItems = (next: InvestigationLine[]): void => {
    changed.current = true;
    setSaved(false);
    setItemsRaw(next);
  };

  useEffect(() => {
    let cancelled = false;
    void loadInvestigations(authFetch, appointmentId, visitId).then((value) => {
      if (cancelled || value === null) return;
      setFreeTextRaw(value.freeText ?? "");
      setItemsRaw(value.items);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, visitId]);

  async function save(): Promise<boolean> {
    setSaving(true);
    // A blank name is a row the doctor started and abandoned, not a request.
    const kept = items.filter((item) => item.name.trim() !== "");
    const value = await saveInvestigations(authFetch, appointmentId, visitId, {
      freeText: freeText === "" ? null : freeText,
      items: kept,
    });
    setSaving(false);
    if (value === null) return false;
    changed.current = false;
    setItemsRaw(value.items);
    setSaved(true);
    return true;
  }

  // Ending the visit saves what is still unsaved: a finished visit refuses these writes.
  usePendingSave(visitId, async () => (changed.current ? save() : true));

  // What is on the screen is what prints: unsaved rows are saved first. A refused save (the visit is
  // already finished) still prints what was saved.
  async function saveFirst(): Promise<boolean> {
    if (changed.current) await save();
    return true;
  }

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-ink">
        {t("investigations.title")}
      </h2>

      {items.length === 0 && (
        <p className="text-xs text-ink-subtle">{t("investigations.empty")}</p>
      )}

      {items.map((item, index) => (
        <div
          key={index}
          className="grid gap-2 sm:grid-cols-[2fr_2fr_auto] sm:items-end"
        >
          <TextInput
            label={t("investigations.name")}
            value={item.name}
            onChange={(event) =>
              setItems(
                items.map((row, at) =>
                  at === index ? { ...row, name: event.target.value } : row,
                ),
              )
            }
          />
          <TextInput
            label={t("investigations.notes")}
            value={item.notes ?? ""}
            onChange={(event) =>
              setItems(
                items.map((row, at) =>
                  at === index
                    ? {
                        ...row,
                        notes:
                          event.target.value === "" ? null : event.target.value,
                      }
                    : row,
                ),
              )
            }
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setItems(items.filter((_, at) => at !== index))}
          >
            {t("investigations.remove")}
          </Button>
        </div>
      ))}

      <Textarea
        label={t("investigations.freeText")}
        rows={2}
        value={freeText}
        onChange={(event) => setFreeText(event.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setItems([...items, { ...EMPTY_INVESTIGATION }])}
        >
          {t("investigations.add")}
        </Button>
        <Button size="sm" loading={saving} onClick={() => void save()}>
          {t("investigations.save")}
        </Button>
        {saved && (
          <span role="status" className="self-center text-xs text-ink-muted">
            {t("investigations.saved")}
          </span>
        )}
        <PrintSheetButton kind="investigations" onBeforePrint={saveFirst} />
      </div>
    </section>
  );
}

export function PrescriptionSection({
  authFetch,
  appointmentId,
  visitId,
}: Props) {
  const { t } = useLocale();
  const [notes, setNotesRaw] = useState("");
  const [items, setItemsRaw] = useState<PrescriptionLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // True once the doctor has changed something that is not saved yet.
  const changed = useRef(false);

  const setNotes = (next: string): void => {
    changed.current = true;
    setSaved(false);
    setNotesRaw(next);
  };
  const setItems = (next: PrescriptionLine[]): void => {
    changed.current = true;
    setSaved(false);
    setItemsRaw(next);
  };

  useEffect(() => {
    let cancelled = false;
    void loadPrescription(authFetch, appointmentId, visitId).then((value) => {
      if (cancelled || value === null) return;
      setNotesRaw(value.notes ?? "");
      setItemsRaw(value.items);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, visitId]);

  async function save(): Promise<boolean> {
    setSaving(true);
    const kept = items.filter((item) => item.medicationName.trim() !== "");
    const value = await savePrescription(authFetch, appointmentId, visitId, {
      notes: notes === "" ? null : notes,
      items: kept,
    });
    setSaving(false);
    if (value === null) return false;
    changed.current = false;
    setItemsRaw(value.items);
    setSaved(true);
    return true;
  }

  // Ending the visit saves what is still unsaved: a finished visit refuses these writes.
  usePendingSave(visitId, async () => (changed.current ? save() : true));

  // What is on the screen is what prints: unsaved rows are saved first. A refused save (the visit is
  // already finished) still prints what was saved.
  async function saveFirst(): Promise<boolean> {
    if (changed.current) await save();
    return true;
  }

  const setLine = (index: number, patch: Partial<PrescriptionLine>): void =>
    setItems(
      items.map((row, at) => (at === index ? { ...row, ...patch } : row)),
    );

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-ink">
        {t("prescription.title")}
      </h2>

      {items.length === 0 && (
        <p className="text-xs text-ink-subtle">{t("prescription.empty")}</p>
      )}

      {items.map((item, index) => (
        <div
          key={index}
          className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_auto] sm:items-end"
        >
          <DrugNameField
            label={t("prescription.medication")}
            value={item.medicationName}
            authFetch={authFetch}
            appointmentId={appointmentId}
            onChange={(name) => setLine(index, { medicationName: name })}
          />
          {/* Q45: strength and form identify the product, quantity is what the pharmacist
              dispenses. Null rather than "" when blank, so an untouched field stays absent. */}
          <TextInput
            label={t("prescription.strength")}
            value={item.strength ?? ""}
            onChange={(event) =>
              setLine(index, {
                strength: event.target.value === "" ? null : event.target.value,
              })
            }
          />
          <TextInput
            label={t("prescription.form")}
            value={item.form ?? ""}
            onChange={(event) =>
              setLine(index, {
                form: event.target.value === "" ? null : event.target.value,
              })
            }
          />
          <TextInput
            label={t("prescription.dose")}
            value={item.dose}
            onChange={(event) => setLine(index, { dose: event.target.value })}
          />
          <TextInput
            label={t("prescription.frequency")}
            value={item.frequency}
            onChange={(event) =>
              setLine(index, { frequency: event.target.value })
            }
          />
          <TextInput
            label={t("prescription.duration")}
            value={item.duration}
            onChange={(event) =>
              setLine(index, { duration: event.target.value })
            }
          />
          <TextInput
            label={t("prescription.quantity")}
            value={item.quantity ?? ""}
            onChange={(event) =>
              setLine(index, {
                quantity: event.target.value === "" ? null : event.target.value,
              })
            }
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setItems(items.filter((_, at) => at !== index))}
          >
            {t("prescription.remove")}
          </Button>
        </div>
      ))}

      <Textarea
        label={t("prescription.notes")}
        rows={2}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />

      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setItems([...items, { ...EMPTY_MEDICATION }])}
        >
          {t("prescription.add")}
        </Button>
        <Button size="sm" loading={saving} onClick={() => void save()}>
          {t("prescription.save")}
        </Button>
        {saved && (
          <span role="status" className="self-center text-xs text-ink-muted">
            {t("prescription.saved")}
          </span>
        )}
        <PrintSheetButton kind="prescription" onBeforePrint={saveFirst} />
      </div>
    </section>
  );
}
