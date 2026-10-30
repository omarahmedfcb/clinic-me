// Manual renewal. Payment happens outside the platform; this records the range that was paid for and,
// for a clinic stopped by its expiry, turns it back on. A range that overlaps or touches the clinic's
// current one is merged into it by the server, and one that would leave a gap is refused there. The
// WhatsApp connection is untouched, so there is no second Embedded Signup.

import { useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { Clinic } from "./platform-api.ts";
import { rangeIsAcceptable, todayIso } from "./subscription-days.ts";

export function RenewPanel({
  clinic,
  busy,
  onRenew,
  onCancel,
}: {
  clinic: Clinic;
  busy: boolean;
  onRenew: (subscriptionStartsOn: string, renewalOn: string) => void;
  onCancel: () => void;
}) {
  const { t } = useLocale();
  const [startsOn, setStartsOn] = useState("");
  const [endsOn, setEndsOn] = useState("");
  const hasRange = clinic.renewalOn !== null;

  return (
    <Card title={t("platform.renew.title")} subtitle={clinic.name}>
      <p className="mb-2 text-sm text-ink-muted">
        {t(clinic.status === "ACTIVE" ? "platform.renew.noteActive" : "platform.renew.noteExpired")}
      </p>
      <p className="numeric mb-3 text-sm text-ink" data-testid="renew-current">
        {hasRange
          ? t("platform.renew.current")
              .replace("{from}", clinic.subscriptionStartsOn ?? "—")
              .replace("{to}", clinic.renewalOn ?? "—")
          : t("platform.renew.noCurrent")}
      </p>
      <div className="grid max-w-xl gap-3 sm:grid-cols-2">
        <TextInput
          label={t("platform.subscriptionStartsOn")}
          hint={t("platform.subscriptionStartsOnHint")}
          type="date"
          dir="ltr"
          min={todayIso()}
          value={startsOn}
          data-testid="renew-start-date"
          onChange={(e) => setStartsOn(e.target.value)}
        />
        <TextInput
          label={t("platform.subscriptionEndsOn")}
          hint={t("platform.subscriptionEndsOnHint")}
          type="date"
          dir="ltr"
          min={startsOn !== "" ? startsOn : todayIso()}
          value={endsOn}
          data-testid="renew-date"
          onChange={(e) => setEndsOn(e.target.value)}
        />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          loading={busy}
          disabled={!rangeIsAcceptable(startsOn, endsOn)}
          data-testid="renew-save"
          onClick={() => onRenew(startsOn, endsOn)}
        >
          {t(clinic.status === "ACTIVE" ? "platform.renew.save" : "platform.renew.saveAndActivate")}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
      </div>
    </Card>
  );
}
