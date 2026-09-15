import { ConfirmDialog } from "../../design-system/overlays.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { Doctor } from "./doctors-api.ts";

/**
 * The confirmation in front of deactivating — or reactivating — a doctor.
 *
 * Extracted from `DoctorsPage` when that file crossed CLAUDE.md's ~300-line limit, and this is the
 * piece that came out because it is the one with a rule attached rather than plumbing: **the
 * warning is a warning, never a gate.**
 *
 * A deactivated doctor's future appointments are not cancelled. They stay on the board and somebody
 * has to move them, which is why the count is put in front of the admin before they confirm and why
 * confirming still proceeds. Refusing would make the system disagree with the building, and the
 * workaround for a refusal — deleting or rebooking around it — is worse than the refusal.
 *
 * It matters more here than on the services screen it mirrors: a service nobody can book still gets
 * performed, but a doctor taken off the board has appointments with no one to see them.
 *
 * Three messages rather than two, because reactivation is the same write and must not borrow the
 * deactivation warning: turning a doctor back on has no standing appointments to worry about.
 */
interface Props {
  /** The doctor whose state is being toggled. Null closes the dialog. */
  doctor: Doctor | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (doctor: Doctor) => void;
}

export function DeactivateDoctorDialog({ doctor, onOpenChange, onConfirm }: Props) {
  const { t } = useLocale();
  const reactivating = doctor !== null && !doctor.isActive;

  return (
    <ConfirmDialog
      open={doctor !== null}
      onOpenChange={onOpenChange}
      title={reactivating ? t("doctors.reactivate.title") : t("doctors.deactivate.title")}
      message={
        doctor === null
          ? ""
          : reactivating
            ? t("doctors.reactivate.message")
            : doctor.futureAppointmentCount === 0
              ? t("doctors.deactivate.none")
              : t("doctors.deactivate.inUse").replace(
                  "{count}",
                  String(doctor.futureAppointmentCount),
                )
      }
      confirmLabel={reactivating ? t("doctors.reactivate.confirm") : t("doctors.deactivate.confirm")}
      cancelLabel={t("doctors.cancel")}
      tone={reactivating ? "primary" : "danger"}
      onConfirm={() => {
        if (doctor !== null) onConfirm(doctor);
      }}
    />
  );
}
