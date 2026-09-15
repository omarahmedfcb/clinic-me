// Kinship on the patient detail screen — Q30. A family, not D28's shared-phone household.
// The reciprocal is written by the server; this asks for one relation, never two.

import { useCallback, useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import { KINSHIPS } from "../../domain/kinship.ts";
import {
  linkPatient,
  loadRelations,
  searchPatients,
  unlinkPatient,
  type PatientSummary,
  type RelatedPatient,
} from "./patients-api.ts";

export function FamilyLinks({ patientId }: { patientId: string }) {
  const { t } = useLocale();
  const { authFetch, me } = useSession();
  const canWrite = me.permissions["patients.write"] !== "none";

  const [links, setLinks] = useState<RelatedPatient[]>([]);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<PatientSummary[]>([]);
  const [chosen, setChosen] = useState<PatientSummary | null>(null);
  const [relation, setRelation] = useState<(typeof KINSHIPS)[number]>("SON");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLinks(await loadRelations(authFetch, patientId));
  }, [authFetch, patientId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (query.trim().length === 0) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void searchPatients(authFetch, query.trim())
        // The patient cannot be their own relative, so they are never offered as one.
        .then((found) => {
          if (!cancelled) setMatches(found.filter((p) => p.id !== patientId));
        })
        .catch(() => setMatches([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authFetch, query, patientId]);

  async function add(): Promise<void> {
    if (chosen === null) return;
    setBusy(true);
    await linkPatient(authFetch, patientId, chosen.id, relation);
    setBusy(false);
    setChosen(null);
    setQuery("");
    setMatches([]);
    await refresh();
  }

  return (
    <div className="grid gap-3">
      <ul className="grid gap-2" data-testid="family-links">
        {links.length === 0 && (
          <li className="text-sm text-ink-subtle">{t("family.none")}</li>
        )}
        {links.map((link) => (
          <li key={link.id} className="flex items-center justify-between gap-3">
            <div className="flex flex-col">
              <span className="text-sm">{link.fullNameAr}</span>
              <span className="numeric text-xs text-ink-muted">{link.phoneE164}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-ink-muted">
                {t(`family.rel.${link.relation}` as TranslationKey)}
              </span>
              {canWrite && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    void unlinkPatient(authFetch, patientId, link.relatedPatientId).then(refresh)
                  }
                >
                  {t("family.remove")}
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {canWrite && (
        <div className="grid gap-2 rounded-lg border border-dashed border-border p-3">
          {chosen === null ? (
            <>
              <TextInput
                label={t("family.search")}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <ul className="grid gap-1">
                {matches.map((match) => (
                  <li key={match.id}>
                    <button
                      type="button"
                      onClick={() => setChosen(match)}
                      className="w-full rounded-lg border border-border px-3 py-2 text-start text-sm hover:border-border-strong"
                    >
                      <bdi className="font-medium">{match.fullNameAr}</bdi>
                      <span className="numeric block text-xs text-ink-muted">{match.phoneE164}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
              <span className="text-sm">{chosen.fullNameAr}</span>
              <Select
                label={t("family.relation")}
                value={relation}
                options={KINSHIPS.map((k) => ({
                  value: k,
                  label: t(`family.rel.${k}` as TranslationKey),
                }))}
                onChange={(event) =>
                  setRelation(event.target.value as (typeof KINSHIPS)[number])
                }
              />
              <div className="flex gap-2">
                <Button size="sm" loading={busy} onClick={() => void add()}>
                  {t("family.add")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setChosen(null)}>
                  {t("family.cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
