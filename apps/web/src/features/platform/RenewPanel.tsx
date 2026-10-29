// Manual renewal. Payment happens outside the platform; this records "paid through <date>" and, for a
// clinic stopped by its expiry, turns it back on. The WhatsApp connection is untouched, so there is no
// second Embedded Signup.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { Clinic } from "./platform-api.ts";

export function RenewPanel({
  clinic,
  busy,
  onRenew,
  onCancel,
}: {
  clinic: Clinic;
  busy: boolean;
  onRenew: (renewalOn: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [date, setDate] = useState("");

  return (
    <Card title={t("platform.renew.title")} subtitle={clinic.name}>
      <p className="mb-3 text-sm text-ink-muted">
        {t(clinic.status === "ACTIVE" ? "platform.renew.noteActive" : "platform.renew.noteExpired")}
      </p>
      <div className="max-w-xs">
        <TextInput
          label={t("platform.subscriptionEndsOn")}
          hint={t("platform.subscriptionEndsOnHint")}
          type="date"
          dir="ltr"
          value={date}
          data-testid="renew-date"
          onChange={(e) => setDate(e.target.value)}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button loading={busy} disabled={date === ""} data-testid="renew-save" onClick={() => onRenew(date)}>
          {t(clinic.status === "ACTIVE" ? "platform.renew.save" : "platform.renew.saveAndActivate")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </Card>
  );
}
