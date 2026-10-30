import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { createDoctor, type Doctor } from "./doctors-api.ts";

/**
 * Adding a doctor creates the whole person: name, phone (their login), and the doctor record.
 * A temporary password comes back once and is handed to the page, which shows it.
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The created row, and the temporary password ("" when the person already had an account elsewhere). */
  onCreated: (doctor: Doctor, temporaryPassword: string) => void;
}

export function AddDoctorDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useLocale();
  const { authFetch } = useSession();

  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset on close, so reopening after a mistake does not present the mistake again.
  useEffect(() => {
    if (open) return;
    setFullName("");
    setPhone("");
    setTitle("");
    setSpecialty("");
    setLicenseNumber("");
    setError(null);
  }, [open]);

  const complete = [fullName, phone, title, specialty, licenseNumber].every((value) => value.trim().length > 0);

  async function submit(): Promise<void> {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createDoctor(authFetch, {
        fullName: fullName.trim(),
        phone: phone.trim(),
        title: title.trim(),
        specialty: specialty.trim(),
        licenseNumber: licenseNumber.trim(),
      });
      if (result.ok) {
        onCreated(result.doctor, result.temporaryPassword);
        onOpenChange(false);
        return;
      }
      // The two refusals an admin can act on get the same sentences the Users screen uses.
      if (result.code === "ALREADY_A_MEMBER" || result.code === "INVALID_PHONE") {
        setError(
          Object.entries(result.params).reduce(
            (text, [key, value]) => text.replace(`{${key}}`, String(value)),
            t(`refusal.${result.code}` as TranslationKey),
          ),
        );
      } else {
        setError(result.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t("doctors.add.title")}
      description={t("doctors.add.subtitle")}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("doctors.cancel")}
          </Button>
          <Button disabled={!complete} loading={busy} onClick={() => void submit()}>
            {t("doctors.add.confirm")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {error !== null && (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        <TextInput label={t("staff.field.name")} required value={fullName} onChange={(event) => setFullName(event.target.value)} />
        <TextInput
          label={t("staff.field.phone")}
          hint={t("doctors.add.phoneHint")}
          required
          numeric
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
        />
        <TextInput
          label={t("doctors.field.title")}
          hint={t("doctors.field.titleHint")}
          required
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <TextInput
          label={t("doctors.field.specialty")}
          required
          value={specialty}
          onChange={(event) => setSpecialty(event.target.value)}
        />
        <TextInput
          label={t("doctors.field.license")}
          numeric
          required
          value={licenseNumber}
          onChange={(event) => setLicenseNumber(event.target.value)}
        />
      </div>
    </Modal>
  );
}
