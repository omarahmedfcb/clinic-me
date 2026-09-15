import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { Drawer } from "../../design-system/overlays.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";
import { updateDoctor, type Doctor } from "./doctors-api.ts";
import { ImageField } from "../settings/ImageField.tsx";
import {
  loadSignature,
  loadStamp,
  removeSignature,
  removeStamp,
  uploadSignature,
  uploadStamp,
} from "../settings/settings-api.ts";
import { loadUserPhoto, removeUserPhoto, uploadUserPhoto } from "../staff/staff-api.ts";

/**
 * A doctor's details, and the only place room number and licence expiry can be set.
 *
 * Both columns shipped on 2026-09-05 and until now nothing wrote to either: the list rendered a
 * room column that was always "—" and a licence expiry that no screen could fill in. A column
 * nobody can populate is worse than an absent one, because it reads as data the clinic failed to
 * enter rather than a control that was never built.
 *
 * ## Blank clears the field, and that is why the two nullable fields are handled separately
 *
 * `PATCH /doctors/:id` distinguishes an omitted key (leave it alone) from an explicit `null`
 * (it was recorded in error, remove it). An admin who empties the room box means the second, so an
 * empty string is sent as `null` rather than dropped — a form that can only ever set is one that
 * cannot undo a typo. The three required fields have no such state: they are `MinLength(1)` on the
 * server, so an empty one is simply not submitted.
 *
 * ## Only what changed is sent
 *
 * A PATCH carrying every field would rewrite `licenseExpiry` to its current value on a save that
 * only touched the room, which is harmless today and stops being harmless the moment any of these
 * columns grows an audit trail or a revision row. Diffing against the row we were given costs four
 * comparisons.
 *
 * ## Deactivation is not here
 *
 * It stays on the list, behind the warning that counts the appointments still standing. A second
 * path into the same write would be a second place for that warning to be forgotten, which is the
 * "check in one place and not its sibling" shape this project keeps finding.
 */
interface Props {
  doctor: Doctor | null;
  onClose: () => void;
  /** Called after a successful save, so the list refetches and shows the new values. */
  onSaved: () => void;
  /** False for a caller who may read the roster but not manage it: the form renders read-only. */
  canManage: boolean;
}

export function DoctorDetailDrawer({ doctor, onClose, onSaved, canManage }: Props) {
  const { t } = useLocale();
  const { me, authFetch } = useSession();

  const [title, setTitle] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseExpiry, setLicenseExpiry] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  const [printedName, setPrintedName] = useState("");
  const [printedNameEn, setPrintedNameEn] = useState("");
  const [syndicateNumber, setSyndicateNumber] = useState("");
  // R1 and R2, both set here because both are facts about this person rather than about the role.
  const [mayAdjustPrices, setMayAdjustPrices] = useState(false);
  const [collectsPayments, setCollectsPayments] = useState(false);
  // The cap on the pricing permission. Empty means unlimited, which is what it was before it existed.
  const [capPercent, setCapPercent] = useState("");
  const [capMinor, setCapMinor] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-seeded whenever a different doctor is opened, so the drawer never shows one doctor's
  // licence number under another's name.
  useEffect(() => {
    if (doctor === null) return;
    setTitle(doctor.title);
    setSpecialty(doctor.specialty);
    setLicenseNumber(doctor.licenseNumber);
    setLicenseExpiry(doctor.licenseExpiry ?? "");
    setRoomNumber(doctor.roomNumber ?? "");
    setPrintedName(doctor.printedName ?? "");
    setPrintedNameEn(doctor.printedNameEn ?? "");
    setSyndicateNumber(doctor.syndicateNumber ?? "");
    setMayAdjustPrices(doctor.mayAdjustPrices);
    setCollectsPayments(doctor.collectsPayments);
    setCapPercent(doctor.priceAdjustmentCapPercent === null ? "" : String(doctor.priceAdjustmentCapPercent));
    setCapMinor(doctor.priceAdjustmentCapMinor);
    setError(null);
    setSaved(false);
  }, [doctor]);

  const required =
    title.trim().length > 0 && specialty.trim().length > 0 && licenseNumber.trim().length > 0;

  async function save(): Promise<void> {
    if (doctor === null || !required || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const patch: Parameters<typeof updateDoctor>[2] = {};
      if (title.trim() !== doctor.title) patch.title = title.trim();
      if (specialty.trim() !== doctor.specialty) patch.specialty = specialty.trim();
      if (licenseNumber.trim() !== doctor.licenseNumber) patch.licenseNumber = licenseNumber.trim();

      // The nullable pair. `""` means "clear it", which is `null` on the wire and is not the same
      // as leaving the key out — see the note at the top of this file.
      const expiry = licenseExpiry.trim() === "" ? null : licenseExpiry.trim();
      if (expiry !== doctor.licenseExpiry) patch.licenseExpiry = expiry;
      const room = roomNumber.trim() === "" ? null : roomNumber.trim();
      if (room !== doctor.roomNumber) patch.roomNumber = room;
      const printed = printedName.trim() === "" ? null : printedName.trim();
      if (printed !== doctor.printedName) patch.printedName = printed;
      const printedEn = printedNameEn.trim() === "" ? null : printedNameEn.trim();
      if (printedEn !== doctor.printedNameEn) patch.printedNameEn = printedEn;
      const syndicate = syndicateNumber.trim() === "" ? null : syndicateNumber.trim();
      if (syndicate !== doctor.syndicateNumber) patch.syndicateNumber = syndicate;
      // Booleans: there is no "clear it", so the only question is whether they moved.
      if (mayAdjustPrices !== doctor.mayAdjustPrices) patch.mayAdjustPrices = mayAdjustPrices;
      if (collectsPayments !== doctor.collectsPayments) patch.collectsPayments = collectsPayments;
      // `""` is "no cap", which is `null` on the wire — the same null-clears-it reading as above.
      const percent = capPercent.trim() === "" ? null : Number(capPercent.trim());
      if (percent !== doctor.priceAdjustmentCapPercent) patch.priceAdjustmentCapPercent = percent;
      if (capMinor !== doctor.priceAdjustmentCapMinor) patch.priceAdjustmentCapMinor = capMinor;

      if (Object.keys(patch).length === 0) {
        setSaved(true);
        return;
      }

      const result = await updateDoctor(authFetch, doctor.id, patch);
      if (result.ok) {
        setSaved(true);
        onSaved();
        return;
      }
      setError(result.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={doctor !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={doctor === null ? t("doctors.detail.title") : `${doctor.title} ${doctor.fullName}`}
      footer={
        canManage ? (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t("doctors.cancel")}
            </Button>
            <Button disabled={!required} loading={busy} onClick={() => void save()}>
              {t("doctors.detail.save")}
            </Button>
          </div>
        ) : undefined
      }
    >
      {doctor === null ? null : (
        <div className="flex flex-col gap-4">
          {error !== null && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          {saved && (
            <p role="status" className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">
              {t("doctors.detail.saved")}
            </p>
          )}

          {/*
            The name is shown and is not editable here. It lives on `users`, shared across every
            clinic this person works at, so editing it from one clinic's doctor screen would rename
            them in the other — and no route in the API writes it. Stated rather than left as a
            missing field somebody adds later without noticing which table it lands in.
          */}
          <div className="flex flex-col gap-1 rounded-lg bg-surface-sunken px-3 py-2">
            <span className="text-xs text-ink-muted">{t("doctors.detail.person")}</span>
            <span className="text-sm font-medium">{doctor.fullName}</span>
            <span className="text-xs text-ink-subtle">{t("doctors.detail.personNote")}</span>
          </div>

          <TextInput
            label={t("doctors.field.title")}
            hint={t("doctors.field.titleHint")}
            required
            disabled={!canManage}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <TextInput
            label={t("doctors.field.specialty")}
            required
            disabled={!canManage}
            value={specialty}
            onChange={(event) => setSpecialty(event.target.value)}
          />
          <TextInput
            label={t("doctors.field.license")}
            numeric
            required
            disabled={!canManage}
            value={licenseNumber}
            onChange={(event) => setLicenseNumber(event.target.value)}
          />
          {/*
            `type="date"` with no min or max. A licence that expired last year has to be recordable
            — refusing past dates would make the one case worth surfacing the one case that cannot
            be stored. The API says the same thing on `UpdateDoctorDto` and for the same reason.

            Nothing derives "expired" or "expiring soon" from this, here or on the list. That is a
            claim about an instant, and this project computes those against a passed-in date in one
            testable place rather than in a render. Storing the date is the whole of this change.
          */}
          <TextInput
            label={t("doctors.field.licenseExpiry")}
            hint={t("doctors.field.licenseExpiryHint")}
            type="date"
            numeric
            disabled={!canManage}
            value={licenseExpiry}
            onChange={(event) => setLicenseExpiry(event.target.value)}
          />
          {/*
            Not `numeric`. Rooms in an Egyptian clinic are called "2أ" and "الأشعة" as often as
            "3", and forcing left-to-right would render the Arabic ones backwards — the same reason
            the list column is not numeric either.
          */}
          <TextInput
            label={t("doctors.field.room")}
            hint={t("doctors.field.roomHint")}
            disabled={!canManage}
            value={roomNumber}
            onChange={(event) => setRoomNumber(event.target.value)}
          />

          {/*
            Q38 folded the separate «بيانات الطبيب المطبوعة» screen into this form. A doctor's
            printed identity is a property of the doctor, and a second screen listing doctors to
            edit one field of was a second place to look for the same record.
          */}
          <p className="mt-2 text-xs font-semibold text-ink">{t("doctors.printSection")}</p>
          <TextInput
            label={t("settings.doctor.printedName")}
            hint={t("doctors.field.printedNameHint")}
            disabled={!canManage}
            value={printedName}
            onChange={(event) => setPrintedName(event.target.value)}
          />
          <TextInput
            label={t("settings.doctor.printedNameEn")}
            hint={t("doctors.field.printedNameEnHint")}
            disabled={!canManage}
            value={printedNameEn}
            onChange={(event) => setPrintedNameEn(event.target.value)}
          />
          <TextInput
            label={t("settings.doctor.syndicateNumber")}
            numeric
            disabled={!canManage}
            value={syndicateNumber}
            onChange={(event) => setSyndicateNumber(event.target.value)}
          />

          {/* R1 and R2. Both default off: a permission that arrives switched on is one nobody
              decided to grant, and both of these are about money. */}
          <p className="mt-2 text-xs font-semibold text-ink">{t("doctors.moneySection")}</p>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              data-testid="doctor-may-adjust-prices"
              disabled={!canManage}
              checked={mayAdjustPrices}
              onChange={(event) => setMayAdjustPrices(event.target.checked)}
            />
            {t("doctors.field.mayAdjustPrices")}
          </label>

          {/* The cap, offered only once the permission is on: a limit on a permission nobody holds
              is a question with no meaning, and answering it would imply the permission. */}
          {mayAdjustPrices && (
            <div className="grid gap-3 ps-6 sm:grid-cols-2" data-testid="price-cap">
              <TextInput
                label={t("doctors.field.capPercent")}
                hint={t("doctors.field.capHint")}
                numeric
                inputMode="numeric"
                disabled={!canManage}
                value={capPercent}
                data-testid="cap-percent"
                onChange={(event) => setCapPercent(event.target.value)}
              />
              <MoneyInput
                label={t("doctors.field.capAmount")}
                currency={me.currency}
                disabled={!canManage}
                valueMinor={capMinor}
                onChangeMinor={setCapMinor}
                data-testid="cap-amount"
              />
            </div>
          )}
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              data-testid="doctor-collects-payments"
              disabled={!canManage}
              checked={collectsPayments}
              onChange={(event) => setCollectsPayments(event.target.checked)}
            />
            {t("doctors.field.collectsPayments")}
          </label>
          {canManage && (
            <>
              {/* The doctor's own face. Uploaded through the users route, because the photo is a
                  fact about the person and `users` is where their name and number live too. */}
              <ImageField
                label={t("staff.photo")}
                testId="doctor-photo"
                present={doctor.hasPhoto}
                load={() => loadUserPhoto(authFetch, doctor.membershipId)}
                upload={(file) => uploadUserPhoto(authFetch, doctor.membershipId, file)}
                remove={() => removeUserPhoto(authFetch, doctor.membershipId)}
                onChanged={onSaved}
              />
              <ImageField
                label={t("settings.doctor.signature")}
                testId="doctor-signature"
                present={doctor.hasSignature}
                load={() => loadSignature(authFetch, doctor.id)}
                upload={(file) => uploadSignature(authFetch, doctor.id, file)}
                remove={() => removeSignature(authFetch, doctor.id)}
                onChanged={onSaved}
              />
              <ImageField
                label={t("settings.doctor.stamp")}
                testId="doctor-stamp"
                present={doctor.hasStamp}
                load={() => loadStamp(authFetch, doctor.id)}
                upload={(file) => uploadStamp(authFetch, doctor.id, file)}
                remove={() => removeStamp(authFetch, doctor.id)}
                onChanged={onSaved}
              />
              <p className="text-xs text-ink-subtle">{t("settings.removeKeepsFile")}</p>
            </>
          )}

          {doctor.futureAppointmentCount > 0 && (
            <p className="numeric text-xs text-ink-muted">
              {t("doctors.upcoming").replace("{count}", String(doctor.futureAppointmentCount))}
            </p>
          )}
        </div>
      )}
    </Drawer>
  );
}
