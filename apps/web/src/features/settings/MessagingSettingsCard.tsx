// The clinic's switches for the WhatsApp messages sent on its own initiative. Owner and admin only.
// Every switch starts off: Meta bills each message to the clinic's own WhatsApp account, and the
// reminder can cancel an appointment, so a clinic turns them on knowingly.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

interface MessagingSettings {
  appointmentRemindersEnabled: boolean;
  reminderLeadHours: number;
  reminderConfirmWindowHours: number;
  callInMessageEnabled: boolean;
  visitDocumentsLinkEnabled: boolean;
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  testId: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-1 h-4 w-4"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        data-testid={testId}
      />
      <span className="flex flex-col">
        <span className="text-sm text-ink">{label}</span>
        {hint !== undefined && <span className="text-xs text-ink-subtle">{hint}</span>}
      </span>
    </label>
  );
}

export function MessagingSettingsCard({ authFetch }: { authFetch: AuthFetch }) {
  const { t } = useLocale();
  const [settings, setSettings] = useState<MessagingSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void authFetch("/api/clinic-settings/messaging")
      .then((response) => (response.ok ? (response.json() as Promise<MessagingSettings>) : null))
      .then((loaded) => {
        if (!cancelled && loaded !== null) setSettings(loaded);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authFetch]);

  if (settings === null) return null;

  const change = (patch: Partial<MessagingSettings>): void => {
    setSaved(false);
    setSettings({ ...settings, ...patch });
  };

  async function save(): Promise<void> {
    if (settings === null) return;
    setBusy(true);
    setFailed(false);
    const response = await authFetch("/api/clinic-settings/messaging", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(settings),
    });
    setBusy(false);
    if (!response.ok) {
      setFailed(true);
      return;
    }
    setSettings((await response.json()) as MessagingSettings);
    setSaved(true);
  }

  const hours = (value: string, fallback: number): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return (
    <Card title={t("settings.messaging.title")} subtitle={t("settings.messaging.billing")}>
      <div className="flex flex-col gap-4" data-testid="messaging-settings">
        <Toggle
          testId="messaging-reminders"
          label={t("settings.messaging.reminders")}
          hint={t("settings.messaging.remindersHint")}
          checked={settings.appointmentRemindersEnabled}
          onChange={(next) => change({ appointmentRemindersEnabled: next })}
        />

        {settings.appointmentRemindersEnabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput
              label={t("settings.messaging.leadHours")}
              numeric
              value={String(settings.reminderLeadHours)}
              onChange={(event) => change({ reminderLeadHours: hours(event.target.value, settings.reminderLeadHours) })}
            />
            <TextInput
              label={t("settings.messaging.confirmWindow")}
              numeric
              value={String(settings.reminderConfirmWindowHours)}
              onChange={(event) =>
                change({ reminderConfirmWindowHours: hours(event.target.value, settings.reminderConfirmWindowHours) })
              }
            />
          </div>
        )}

        <Toggle
          testId="messaging-call-in"
          label={t("settings.messaging.callIn")}
          hint={t("settings.messaging.callInHint")}
          checked={settings.callInMessageEnabled}
          onChange={(next) => change({ callInMessageEnabled: next })}
        />

        <Toggle
          testId="messaging-documents"
          label={t("settings.messaging.documents")}
          checked={settings.visitDocumentsLinkEnabled}
          onChange={(next) => change({ visitDocumentsLinkEnabled: next })}
        />

        {failed && (
          <p role="alert" className="text-xs text-danger">
            {t("settings.messaging.failed")}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button onClick={() => void save()} disabled={busy}>
            {t("settings.save")}
          </Button>
          {saved && <span className="text-xs text-ink-subtle">{t("settings.saved")}</span>}
        </div>
      </div>
    </Card>
  );
}
