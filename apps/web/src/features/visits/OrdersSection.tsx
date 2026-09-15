// What the visit orders: investigations and the prescription — Q24, with Q8's autocomplete.
// Both are saved explicitly: a list being edited row by row must not autosave a half-typed line.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { TextInput, Textarea } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import {
  loadInvestigations,
  loadPrescription,
  saveInvestigations,
  savePrescription,
  suggestMedications,
  type InvestigationLine,
  type PrescriptionLine,
} from "./draft-api.ts";

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

export function InvestigationsSection({ authFetch, appointmentId, visitId }: Props) {
  const { t } = useLocale();
  const [freeText, setFreeText] = useState("");
  const [items, setItems] = useState<InvestigationLine[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadInvestigations(authFetch, appointmentId, visitId).then((value) => {
      if (cancelled || value === null) return;
      setFreeText(value.freeText ?? "");
      setItems(value.items);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, visitId]);

  async function save(): Promise<void> {
    setSaving(true);
    // A blank name is a row the doctor started and abandoned, not a request.
    const kept = items.filter((item) => item.name.trim() !== "");
    const value = await saveInvestigations(authFetch, appointmentId, visitId, {
      freeText: freeText === "" ? null : freeText,
      items: kept,
    });
    setSaving(false);
    if (value !== null) setItems(value.items);
  }

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-ink">{t("investigations.title")}</h2>

      {items.length === 0 && <p className="text-xs text-ink-subtle">{t("investigations.empty")}</p>}

      {items.map((item, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[2fr_2fr_auto] sm:items-end">
          <TextInput
            label={t("investigations.name")}
            value={item.name}
            onChange={(event) =>
              setItems(items.map((row, at) => (at === index ? { ...row, name: event.target.value } : row)))
            }
          />
          <TextInput
            label={t("investigations.notes")}
            value={item.notes ?? ""}
            onChange={(event) =>
              setItems(
                items.map((row, at) =>
                  at === index ? { ...row, notes: event.target.value === "" ? null : event.target.value } : row,
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

      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setItems([...items, { ...EMPTY_INVESTIGATION }])}>
          {t("investigations.add")}
        </Button>
        <Button size="sm" loading={saving} onClick={() => void save()}>
          {t("profile.add")}
        </Button>
      </div>
    </section>
  );
}

export function PrescriptionSection({ authFetch, appointmentId, visitId }: Props) {
  const { t } = useLocale();
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<PrescriptionLine[]>([]);
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    void loadPrescription(authFetch, appointmentId, visitId).then((value) => {
      if (cancelled || value === null) return;
      setNotes(value.notes ?? "");
      setItems(value.items);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, visitId]);

  async function save(): Promise<void> {
    setSaving(true);
    const kept = items.filter((item) => item.medicationName.trim() !== "");
    const value = await savePrescription(authFetch, appointmentId, visitId, {
      notes: notes === "" ? null : notes,
      items: kept,
    });
    setSaving(false);
    if (value !== null) setItems(value.items);
  }

  const setLine = (index: number, patch: Partial<PrescriptionLine>): void =>
    setItems(items.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-ink">{t("prescription.title")}</h2>

      {items.length === 0 && <p className="text-xs text-ink-subtle">{t("prescription.empty")}</p>}

      {items.map((item, index) => (
        <div key={index} className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr_auto] sm:items-end">
          <TextInput
            label={t("prescription.medication")}
            list="medication-suggestions"
            value={item.medicationName}
            onChange={(event) => {
              setLine(index, { medicationName: event.target.value });
              void suggestMedications(authFetch, appointmentId, event.target.value).then(setSuggestions);
            }}
          />
          {/* Q45: strength and form identify the product, quantity is what the pharmacist
              dispenses. Null rather than "" when blank, so an untouched field stays absent. */}
          <TextInput
            label={t("prescription.strength")}
            value={item.strength ?? ""}
            onChange={(event) => setLine(index, { strength: event.target.value === "" ? null : event.target.value })}
          />
          <TextInput
            label={t("prescription.form")}
            value={item.form ?? ""}
            onChange={(event) => setLine(index, { form: event.target.value === "" ? null : event.target.value })}
          />
          <TextInput
            label={t("prescription.dose")}
            value={item.dose}
            onChange={(event) => setLine(index, { dose: event.target.value })}
          />
          <TextInput
            label={t("prescription.frequency")}
            value={item.frequency}
            onChange={(event) => setLine(index, { frequency: event.target.value })}
          />
          <TextInput
            label={t("prescription.duration")}
            value={item.duration}
            onChange={(event) => setLine(index, { duration: event.target.value })}
          />
          <TextInput
            label={t("prescription.quantity")}
            value={item.quantity ?? ""}
            onChange={(event) => setLine(index, { quantity: event.target.value === "" ? null : event.target.value })}
          />
          <Button size="sm" variant="ghost" onClick={() => setItems(items.filter((_, at) => at !== index))}>
            {t("prescription.remove")}
          </Button>
        </div>
      ))}

      {/* A native datalist: the suggestions are this clinic's own prescribing history and nothing
          more (Q8), so there is no ranking to build and nothing to look authoritative. */}
      <datalist id="medication-suggestions" aria-label={t("prescription.suggestions")}>
        {suggestions.map((name) => (
          <option key={name} value={name} />
        ))}
      </datalist>

      <Textarea
        label={t("prescription.notes")}
        rows={2}
        value={notes}
        onChange={(event) => setNotes(event.target.value)}
      />

      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={() => setItems([...items, { ...EMPTY_MEDICATION }])}>
          {t("prescription.add")}
        </Button>
        <Button size="sm" loading={saving} onClick={() => void save()}>
          {t("profile.add")}
        </Button>
      </div>
    </section>
  );
}
