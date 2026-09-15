import { useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { loadMemberships, type Membership } from "../memberships/memberships-api.ts";
import { roleLabel } from "../memberships/role-label.ts";
import { useSession } from "../auth/session.tsx";
import { createDoctor, type Doctor } from "./doctors-api.ts";

/**
 * Adding a doctor — the form the doctors screen shipped without.
 *
 * ## It links a person, it does not create one
 *
 * A `Doctor` row hangs off a `Membership`, so "add a doctor" means "say that this member of staff
 * practises here". The picker is `GET /memberships`, and there is deliberately no way to type a
 * name: nothing in the API writes a `users` row, so a name field would be a control that looks
 * finished and silently cannot work. The dialog says that in words, on the screen, rather than
 * leaving an admin to discover it — the same reasoning that put the deferral note on the list.
 *
 * ## Memberships that already have a doctor record are shown, disabled
 *
 * `doctors.membership_id` is unique and the API refuses a second link with 422. Hiding those rows
 * would make an admin wonder where a colleague went; disabling them answers the question in place.
 * The list also carries suspended and revoked memberships for the same reason the doctors list
 * carries deactivated doctors — absence reads as deletion.
 *
 * ## Four fields, and the two that are missing
 *
 * `CreateDoctorDto` takes membership, title, specialty and licence number. Room number and licence
 * expiry are on `UpdateDoctorDto` only, because those columns arrived later. So they are set by
 * opening the doctor afterwards. Flagged rather than widened: changing the create route is API
 * surface nobody asked for, and this is an action a clinic performs a few times a year.
 */
interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the created row, so the list can refresh and open it. */
  onCreated: (doctor: Doctor) => void;
}

export function AddDoctorDialog({ open, onOpenChange, onCreated }: Props) {
  const { t } = useLocale();
  const { authFetch } = useSession();

  const [memberships, setMemberships] = useState<Membership[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const [membershipId, setMembershipId] = useState("");
  const [title, setTitle] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [licenseNumber, setLicenseNumber] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetched when the dialog opens rather than when the screen mounts.
   *
   * The list is behind `users.manage`, which is the same capability that reveals the button that
   * opens this dialog — so by construction nobody reaches this fetch without holding it. Doing it
   * on mount would put a `users.manage` request on a screen that anyone who can book may read,
   * which is the shape that took the queue board down for an owner on 2026-09-06.
   */
  useEffect(() => {
    if (!open) return;
    setLoadFailed(false);
    void loadMemberships(authFetch)
      .then(setMemberships)
      .catch(() => setLoadFailed(true));
  }, [open, authFetch]);

  // Reset on close, so reopening after a mistake does not present the mistake again.
  useEffect(() => {
    if (open) return;
    setMembershipId("");
    setTitle("");
    setSpecialty("");
    setLicenseNumber("");
    setError(null);
  }, [open]);

  /**
   * **The role is in the label because the name is no longer unique.**
   *
   * The schema still permits one person to hold two memberships in one clinic, even though the
   * product no longer creates them (CLAUDE.md, 2026-09-09), so two rows can still be
   * character-for-character identical on name and phone alone. An admin choosing between them
   * would be choosing blind, and the wrong choice attaches the doctor record to the wrong
   * membership.
   *
   * Shown for every row rather than only for the ambiguous ones, which is the opposite of what the
   * clinic switcher does — and deliberately. There the role is noise on a list of clinics you
   * recognise by name; here you are picking *which capacity* somebody works in, so it is the
   * substance of the choice.
   */
  const options = useMemo(
    () =>
      (memberships ?? []).map((membership) => ({
        value: membership.membershipId,
        label: `${membership.fullName} · ${roleLabel(membership.role, t)} — ${
          membership.hasDoctorRecord ? t("doctors.add.alreadyDoctor") : membership.phoneE164
        }`,
        disabled: membership.hasDoctorRecord,
      })),
    [memberships, t],
  );

  const complete =
    membershipId.length > 0 &&
    title.trim().length > 0 &&
    specialty.trim().length > 0 &&
    licenseNumber.trim().length > 0;

  async function submit(): Promise<void> {
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createDoctor(authFetch, {
        membershipId,
        title: title.trim(),
        specialty: specialty.trim(),
        licenseNumber: licenseNumber.trim(),
      });
      if (result.ok) {
        onCreated(result.doctor);
        onOpenChange(false);
        return;
      }
      // The server's own sentence, not a status code translated here. It names which membership it
      // could not find or which one is already a doctor, and that is the useful half.
      setError(result.message);
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

        {loadFailed ? (
          <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            {t("doctors.add.membershipsFailed")}
          </p>
        ) : memberships === null ? (
          <Spinner />
        ) : (
          <>
            {/*
              A native `<select>` with disabled options rather than a filtered list: see the
              component note in the dialog's doc comment. `option` accepts `disabled`, so the rows
              that cannot be chosen are visible and unselectable without a custom listbox.
            */}
            <Select
              label={t("doctors.add.member")}
              placeholder={t("doctors.add.memberPlaceholder")}
              hint={t("doctors.add.memberHint")}
              required
              value={membershipId}
              onChange={(event) => setMembershipId(event.target.value)}
              options={options}
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
            {/*
              Said on the screen, not only in a comment. An admin looking for the colleague who has
              no login will otherwise read the short list as a bug in this dialog.
            */}
            <p className="text-xs text-ink-subtle">{t("doctors.add.noAccountNote")}</p>
          </>
        )}
      </div>
    </Modal>
  );
}
