// «بياناتي» — your own name, phone and photo, whatever your role (ruled 2026-09-13), plus a doctor's
// printed identity when there is one. The roster screen is the admin's; this is the row you own.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card } from "../../design-system/display.tsx";
import { TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { loadDoctors, type Doctor } from "../doctors/doctors-api.ts";
import { ImageField } from "./ImageField.tsx";
import { loadUserPhoto, removeMyPhoto, updateMyDetails, uploadMyPhoto } from "../staff/staff-api.ts";
import {
  loadSignature,
  loadStamp,
  removeSignature,
  removeStamp,
  saveDoctorPrintIdentity,
  uploadSignature,
  uploadStamp,
} from "./settings-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function MyDetailsPage({
  authFetch,
  membershipId,
}: {
  authFetch: AuthFetch;
  membershipId: string;
}) {
  const { t } = useLocale();
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [printedName, setPrintedName] = useState("");
  const [printedNameEn, setPrintedNameEn] = useState("");
  const [title, setTitle] = useState("");
  const [syndicateNumber, setSyndicateNumber] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // The person's own details, which every role has — unlike the doctor record below.
  const { me, reload } = useSession();
  const [myName, setMyName] = useState(me.user.fullName);
  const [myPhone, setMyPhone] = useState(me.user.phoneE164);
  const [savingMine, setSavingMine] = useState(false);
  const [mineSaved, setMineSaved] = useState(false);
  const [mineFailure, setMineFailure] = useState<string | null>(null);
  /** Probed once: nothing in the session says whether a photo is stored. */
  const [photoPresent, setPhotoPresent] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadUserPhoto(authFetch, membershipId).then((url) => {
      if (url === null) return;
      // Only presence is wanted here; `ImageField` fetches its own copy to show.
      URL.revokeObjectURL(url);
      if (!cancelled) setPhotoPresent(true);
    });
    return () => {
      cancelled = true;
    };
  }, [authFetch, membershipId]);

  async function saveMine(): Promise<void> {
    setSavingMine(true);
    setMineFailure(null);
    const result = await updateMyDetails(authFetch, {
      ...(myName.trim() === me.user.fullName ? {} : { fullName: myName.trim() }),
      ...(myPhone.trim() === me.user.phoneE164 ? {} : { phone: myPhone.trim() }),
    });
    setSavingMine(false);
    if (!result.ok) {
      setMineFailure(result.code);
      return;
    }
    setMineSaved(true);
    // The header shows the name, so it has to be re-read. A changed phone has also ended this
    // session server-side; the next request is what discovers that.
    await reload();
  }

  /**
   * Found by membership, never by asking for a doctor id.
   *
   * `doctorProfile.manage` is `own` for a doctor and the server applies that scope to the lookup, so
   * a wrong id would be a 404 rather than a leak — but a screen that has to be handed the right id
   * to be correct is one that can be handed the wrong one.
   */
  const refresh = useCallback(async () => {
    const mine = (await loadDoctors(authFetch).catch(() => [])).find(
      (row) => row.membershipId === membershipId,
    );
    if (mine === undefined) return;
    setDoctor(mine);
    setPrintedName(mine.printedName ?? "");
    setPrintedNameEn(mine.printedNameEn ?? "");
    setTitle(mine.title);
    setSyndicateNumber(mine.syndicateNumber ?? "");
  }, [authFetch, membershipId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function save(): Promise<void> {
    if (doctor === null) return;
    setSaving(true);
    const value = await saveDoctorPrintIdentity(authFetch, doctor.id, {
      printedName: printedName.trim() === "" ? null : printedName,
      printedNameEn: printedNameEn.trim() === "" ? null : printedNameEn,
      title,
      syndicateNumber: syndicateNumber.trim() === "" ? null : syndicateNumber,
    });
    setSaving(false);
    if (value !== null) {
      setSaved(true);
      void refresh();
    }
  }

  return (
    <main className="mx-auto max-w-2xl p-6" data-testid="my-details">
      <h1 className="mb-4 text-lg font-semibold text-ink">{t("shell.myProfile")}</h1>

      {/* **Every role, not just doctors** — ruled 2026-09-13. Name, phone and photo belong to the
          person; the print fields below belong to a doctor's record and stay there. */}
      <Card title={t("settings.myDetails")}>
        <div className="grid gap-4">
          <TextInput
            label={t("staff.field.name")}
            value={myName}
            data-testid="my-name"
            onChange={(event) => {
              setMyName(event.target.value);
              setMineSaved(false);
            }}
          />
          <TextInput
            label={t("staff.field.phone")}
            numeric
            inputMode="tel"
            value={myPhone}
            data-testid="my-phone"
            onChange={(event) => {
              setMyPhone(event.target.value);
              setMineSaved(false);
            }}
          />
          <p className="text-xs text-ink-muted">{t("settings.phoneEndsSessions")}</p>
          {mineFailure !== null && (
            <p role="alert" className="text-xs text-danger" data-testid="my-details-failure">
              {t(`refusal.${mineFailure}` as TranslationKey)}
            </p>
          )}
          <div className="flex items-center gap-3">
            <Button loading={savingMine} data-testid="save-my-name" onClick={() => void saveMine()}>
              {t("settings.save")}
            </Button>
            {mineSaved && <span className="text-xs text-success">{t("settings.saved")}</span>}
          </div>
        </div>
      </Card>

      <div className="mt-4 grid gap-4">
        <Card title={t("staff.photo")}>
          <ImageField
            label={t("staff.photo")}
            testId="my-photo"
            present={photoPresent}
            load={() => loadUserPhoto(authFetch, membershipId)}
            upload={async (file) => {
              const ok = await uploadMyPhoto(authFetch, file);
              if (ok) setPhotoPresent(true);
              return ok;
            }}
            remove={async () => {
              const ok = await removeMyPhoto(authFetch);
              if (ok) setPhotoPresent(false);
              return ok;
            }}
            onChanged={() => void reload()}
          />
        </Card>
      </div>

      {doctor === null ? (
        // Not an error: an admin or receptionist has no doctor record, so there are no print fields.
        // Their own details above are the whole of this screen for them.
        <p className="mt-4 text-sm text-ink-muted">{t("settings.noDoctorRecord")}</p>
      ) : (
        <>
      <Card title={t("doctors.printSection")}>
        <div className="grid gap-4">
          <TextInput
            label={t("settings.doctor.printedName")}
            hint={t("doctors.field.printedNameHint")}
            value={printedName}
            onChange={(event) => {
              setPrintedName(event.target.value);
              setSaved(false);
            }}
          />
          <TextInput
            label={t("settings.doctor.printedNameEn")}
            hint={t("doctors.field.printedNameEnHint")}
            value={printedNameEn}
            onChange={(event) => {
              setPrintedNameEn(event.target.value);
              setSaved(false);
            }}
          />
          <TextInput
            label={t("settings.doctor.printedTitle")}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
              setSaved(false);
            }}
          />
          <TextInput
            label={t("settings.doctor.syndicateNumber")}
            numeric
            value={syndicateNumber}
            onChange={(event) => {
              setSyndicateNumber(event.target.value);
              setSaved(false);
            }}
          />
          <div className="flex items-center gap-3">
            <Button data-testid="save-my-details" loading={saving} onClick={() => void save()}>
              {t("settings.save")}
            </Button>
            {saved && <span className="text-xs text-success">{t("settings.saved")}</span>}
          </div>
        </div>
      </Card>

      <div className="mt-4 grid gap-4">
        <Card title={t("settings.doctor.signature")}>
          <ImageField
            label={t("settings.doctor.signature")}
            testId="my-signature"
            present={doctor.hasSignature}
            load={() => loadSignature(authFetch, doctor.id)}
            upload={(file) => uploadSignature(authFetch, doctor.id, file)}
            remove={() => removeSignature(authFetch, doctor.id)}
            onChanged={() => void refresh()}
          />
        </Card>
        <Card title={t("settings.doctor.stamp")}>
          <ImageField
            label={t("settings.doctor.stamp")}
            testId="my-stamp"
            present={doctor.hasStamp}
            load={() => loadStamp(authFetch, doctor.id)}
            upload={(file) => uploadStamp(authFetch, doctor.id, file)}
            remove={() => removeStamp(authFetch, doctor.id)}
            onChanged={() => void refresh()}
          />
        </Card>
        <p className="text-xs text-ink-subtle">{t("settings.removeKeepsFile")}</p>
      </div>
        </>
      )}
    </main>
  );
}
