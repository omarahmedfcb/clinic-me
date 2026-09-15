// The patient-level clinical profile, append-only — Q22. Any doctor may add; nobody edits.
// Expanded on a first visit, collapsed afterwards with who last added to it.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, Textarea } from "../../design-system/fields.tsx";
import { intlLocale } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import {
  addProfileEntry,
  loadClinicalProfile,
  PROFILE_FIELDS,
  type ClinicalProfileView,
  type ProfileField,
} from "./draft-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function ClinicalProfileSection({
  authFetch,
  appointmentId,
}: {
  authFetch: AuthFetch;
  appointmentId: string;
}) {
  const { t, locale } = useLocale();
  const [profile, setProfile] = useState<ClinicalProfileView | null>(null);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<ProfileField>("PAST_MEDICAL");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadClinicalProfile(authFetch, appointmentId).then((value) => {
      if (cancelled || value === null) return;
      setProfile(value);
      // Expanded on a first visit, because that is when there is a profile to build (Q22).
      setOpen(value.firstVisit);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId]);

  async function add(): Promise<void> {
    if (content.trim() === "") return;
    setSaving(true);
    const next = await addProfileEntry(authFetch, appointmentId, { field, content });
    setSaving(false);
    if (next === null) return;
    setProfile(next);
    setContent("");
  }

  const entries = profile?.entries ?? [];

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{t("profile.title")}</h2>
        <Button size="sm" variant="ghost" onClick={() => setOpen((previous) => !previous)}>
          {open ? t("profile.hide") : t("profile.show")}
        </Button>
      </div>

      <p className="text-xs text-ink-subtle">
        {profile?.lastUpdatedAt === null || profile === null
          ? t("profile.empty")
          : t("profile.lastUpdated")
              .replace("{by}", profile.lastUpdatedBy ?? "")
              .replace("{at}", new Date(profile.lastUpdatedAt).toLocaleString(intlLocale(locale)))}
      </p>

      {open && (
        <>
          <p className="text-xs text-ink-subtle">{t("profile.allergiesNote")}</p>
          <p className="text-xs text-ink-subtle">{t("profile.appendOnly")}</p>
          <p className="text-xs text-ink-muted">
            {profile?.heightCm == null
              ? t("profile.heightUnknown")
              : t("profile.height").replace("{value}", String(profile.heightCm))}
          </p>

          <ul className="grid gap-2">
            {entries.map((entry) => (
              <li key={entry.id} className="rounded-lg bg-surface-sunken px-3 py-2">
                <p className="text-xs font-semibold text-ink">
                  {t(`profile.field.${entry.field}` as TranslationKey)}
                </p>
                <p className="whitespace-pre-wrap text-sm text-ink">{entry.content}</p>
                <p className="mt-1 text-xs text-ink-subtle">
                  {entry.authorName} — {new Date(entry.createdAt).toLocaleString(intlLocale(locale))}
                </p>
              </li>
            ))}
          </ul>

          <Select
            label={t("profile.title")}
            value={field}
            options={PROFILE_FIELDS.map((name) => ({
              value: name,
              label: t(`profile.field.${name}` as TranslationKey),
            }))}
            onChange={(event) => setField(event.target.value as ProfileField)}
          />
          <Textarea
            label={t("profile.add")}
            rows={3}
            value={content}
            onChange={(event) => setContent(event.target.value)}
          />
          <div>
            <Button size="sm" variant="secondary" loading={saving} onClick={() => void add()}>
              {t("profile.add")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
