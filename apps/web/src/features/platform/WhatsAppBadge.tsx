// The per-clinic bot badge in the console's list: has a working WhatsApp bot, has none, or has one that
// stopped working. Colour is never the only signal: every state carries its own word.

import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { cx } from "../../lib/cx.ts";
import type { Clinic } from "./platform-api.ts";

const TONE: Record<Clinic["whatsapp"]["state"], string> = {
  CONNECTED: "bg-success-soft text-success",
  NEEDS_ATTENTION: "bg-warning-soft text-warning",
  NONE: "bg-surface-sunken text-ink-muted",
};

export function WhatsAppBadge({ clinic }: { clinic: Clinic }) {
  const { t } = useLocale();
  // Tolerates an API that has not been upgraded yet: no field reads as "no bot", never as a crash.
  const { state, displayPhoneNumber } = clinic.whatsapp ?? { state: "NONE" as const, displayPhoneNumber: null };

  return (
    <span className="flex flex-col items-start gap-1 text-xs" data-testid={`whatsapp-${clinic.tenantId}`}>
      <span className={cx("rounded-full px-2 py-0.5 font-medium", TONE[state])} data-state={state}>
        {t(`platform.whatsapp.${state}` as TranslationKey)}
      </span>
      {displayPhoneNumber !== null && state !== "NONE" && (
        <span className="numeric text-ink-subtle" dir="ltr">
          {displayPhoneNumber}
        </span>
      )}
    </span>
  );
}
