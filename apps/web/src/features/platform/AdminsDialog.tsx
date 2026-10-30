import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Modal } from "../../design-system/overlays.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import { roleLabel } from "../memberships/role-label.ts";
import { resetAdminPassword, type Clinic } from "./platform-api.ts";
import { refusalText } from "./refusal-text.ts";

/** A clinic's admins, each with their own reset. The new password is shown under that admin, once. */
interface Props {
  clinic: Clinic | null;
  onClose: () => void;
}

export function AdminsDialog({ clinic, onClose }: Props) {
  const { t } = useLocale();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ userId: string; password: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  function close(): void {
    setIssued(null);
    setRefusal(null);
    onClose();
  }

  async function reset(tenantId: string, userId: string): Promise<void> {
    setBusyId(userId);
    setRefusal(null);
    setIssued(null);
    const result = await resetAdminPassword(tenantId, userId);
    setBusyId(null);
    if (!result.ok) {
      setRefusal(refusalText(t, result.code, result.params));
      return;
    }
    setIssued({ userId, password: result.temporaryPassword });
  }

  return (
    <Modal
      open={clinic !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title={t("platform.admins.title")}
      description={clinic?.name}
      footer={
        <Button data-testid="close-admins" onClick={close}>
          {t("platform.dismiss")}
        </Button>
      }
    >
      <div className="grid gap-3" data-testid="admins-dialog">
        {refusal !== null && (
          <p role="alert" className="text-sm text-danger">
            {refusal}
          </p>
        )}
        {/* Only an admin the server would accept: a doctor is not in `admins` at all. */}
        {(clinic?.admins ?? []).map((admin) => (
          <div key={admin.userId} className="grid gap-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-ink">{admin.fullName}</span>
                <span className="text-xs text-ink-muted">{roleLabel(admin.role, t)}</span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                loading={busyId === admin.userId}
                data-testid={`reset-${admin.userId}`}
                onClick={() => clinic !== null && void reset(clinic.tenantId, admin.userId)}
              >
                {t("platform.resetPassword")}
              </Button>
            </div>
            {issued?.userId === admin.userId && (
              <div className="grid gap-1">
                <p
                  dir="ltr"
                  className="numeric select-all rounded-lg bg-surface-sunken px-3 py-2 text-center text-lg"
                  data-testid="issued-password"
                >
                  {issued.password}
                </p>
                {/* Shown once and never readable again — the server keeps only the hash. */}
                <p className="text-xs text-warning">{t("platform.shownOnce")}</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}
