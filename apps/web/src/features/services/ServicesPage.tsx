import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Card, DataTable, EmptyState, type Column } from "../../design-system/display.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { ConfirmDialog, Modal } from "../../design-system/overlays.tsx";
import { Spinner } from "../../design-system/Spinner.tsx";
import { MoneyInput } from "../../design-system/MoneyInput.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { useSession } from "../auth/session.tsx";
import {
  createService,
  loadServices,
  SERVICE_TYPES,
  updateService,
  type Service,
  type ServiceInput,
  type ServiceType,
} from "./services-api.ts";

/**
 * Clinic-managed services — Phase 4, checkpoint 1.
 *
 * The admin's catalogue: what the clinic offers, how long it takes, and what it costs. Until now
 * these arrived from the seed, which is why a price had never been edited in the product's life —
 * and why `appointments.quoted_price_minor` had to exist before this screen could ship.
 *
 * ## Deactivate, never delete
 *
 * `appointments.service_id` references these rows, so deleting one either orphans history or
 * cascades it away, and the second is forbidden outright. Deactivation removes the service from the
 * booking dropdown and does nothing else.
 *
 * **The warning is a warning, not a gate** (`PHASE-5-DESIGN.md` §2.3, ruled 2026-09-03). A clinic
 * that stops offering something still has three booked next week and will still perform them, so
 * the dialog says how many and proceeds. Refusing would make the system disagree with the building,
 * and the workaround for a refusal is renaming the service to "DO NOT USE", which is worse.
 *
 * ## Price is entered and read in major units — fixed 2026-09-05
 *
 * The field used to take **30000 for 300**, with a hint saying so. That was flagged in this comment
 * as a placeholder that should not survive first contact with a real admin, and it did not: the
 * founder's ruling is *"the admin types 300 and sees 300"*.
 *
 * **Storage is unchanged and must stay unchanged.** `price_minor` is integer minor units, because
 * money is never a float (CLAUDE.md, D7). The conversion happens at this boundary only, inside the
 * shared `MoneyInput` — every money field in the product goes through it, so the rule lives in one
 * place and `money-inputs-are-shared.spec.ts` fails the build when a new field skips it.
 */

interface Draft extends ServiceInput {
  id?: string;
}

const EMPTY_DRAFT: Draft = {
  nameAr: "",
  nameEn: "",
  type: "NEW",
  durationMinutes: 30,
  bufferMinutes: 0,
  priceMinor: 0,
};

export function ServicesPage() {
  const { t, locale } = useLocale();
  const { me, authFetch } = useSession();

  const [services, setServices] = useState<Service[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<Service | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setFailed(false);
    try {
      setServices(await loadServices(authFetch));
    } catch {
      setFailed(true);
    }
  }, [authFetch]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const typeLabel = useCallback(
    (type: ServiceType): string => t(`services.type.${type}` as TranslationKey),
    [t],
  );

  async function save(): Promise<void> {
    if (draft === null || saving) return;
    setSaving(true);
    setSaveError(null);

    const { id, ...input } = draft;
    const result =
      id === undefined
        ? await createService(authFetch, input)
        : await updateService(authFetch, id, input);

    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return;
    }
    setDraft(null);
    await refresh();
  }

  async function toggleActive(service: Service): Promise<void> {
    const result = await updateService(authFetch, service.id, { isActive: !service.isActive });
    if (result.ok) await refresh();
    else setFailed(true);
  }

  const columns = useMemo<Column<Service>[]>(
    () => [
      {
        key: "name",
        header: t("services.column.name"),
        render: (row) => (
          <div className="flex flex-col">
            <span className="font-medium">{locale === "ar" ? row.nameAr : row.nameEn}</span>
            <span className="text-xs text-ink-muted">{locale === "ar" ? row.nameEn : row.nameAr}</span>
          </div>
        ),
      },
      {
        key: "type",
        header: t("services.column.type"),
        render: (row) => typeLabel(row.type),
      },
      {
        key: "duration",
        header: t("services.column.duration"),
        align: "end",
        render: (row) => (
          <div className="flex flex-col items-end">
            <span className="numeric">{t("services.minutes").replace("{count}", String(row.durationMinutes))}</span>
            {row.bufferMinutes > 0 && (
              <span className="numeric text-xs text-ink-muted">
                {t("services.buffer").replace("{count}", String(row.bufferMinutes))}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "price",
        header: t("services.column.price"),
        align: "end",
        render: (row) => (
          <span className="numeric font-medium">{formatMinor(row.priceMinor, me.currency, locale)}</span>
        ),
      },
      {
        key: "status",
        header: t("services.column.status"),
        render: (row) => (
          <div className="flex flex-col gap-0.5">
            <span
              className={
                row.isActive
                  ? "inline-flex w-fit rounded-full bg-success-soft px-2 py-0.5 text-xs text-success"
                  : "inline-flex w-fit rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
              }
            >
              {row.isActive ? t("services.active") : t("services.inactive")}
            </span>
            {row.futureAppointmentCount > 0 && (
              <span className="numeric text-xs text-ink-muted">
                {t("services.upcoming").replace("{count}", String(row.futureAppointmentCount))}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "actions",
        header: t("services.column.actions"),
        align: "end",
        render: (row) => (
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => { setSaveError(null); setDraft({ ...row }); }}>
              {t("services.edit")}
            </Button>
            <Button variant="secondary" onClick={() => setToggling(row)}>
              {row.isActive ? t("services.deactivate") : t("services.activate")}
            </Button>
          </div>
        ),
      },
    ],
    [t, locale, me.currency, typeLabel],
  );

  if (failed) {
    return (
      <EmptyState
        title={t("services.loadFailed")}
        message=""
        action={<Button onClick={() => void refresh()}>{t("services.retry")}</Button>}
      />
    );
  }

  if (services === null) return <Spinner />;

  return (
    <div className="mx-auto max-w-5xl">
      <Card
        title={t("services.title")}
        subtitle={t("services.subtitle")}
        actions={
          <Button onClick={() => { setSaveError(null); setDraft({ ...EMPTY_DRAFT }); }}>
            {t("services.add")}
          </Button>
        }
        padded={false}
      >
        <DataTable
          columns={columns}
          rows={services}
          rowKey={(row) => row.id}
          caption={t("services.title")}
          empty={<EmptyState title={t("services.empty.title")} message={t("services.empty.message")} />}
        />
      </Card>

      <Modal
        open={draft !== null}
        onOpenChange={(open) => { if (!open) setDraft(null); }}
        title={draft?.id === undefined ? t("services.dialog.createTitle") : t("services.dialog.editTitle")}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDraft(null)}>
              {t("services.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? t("services.saving") : t("services.save")}
            </Button>
          </>
        }
      >
        {draft !== null && (
          <div className="flex flex-col gap-4">
            {saveError !== null && (
              <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
                {saveError}
              </p>
            )}

            <TextInput
              label={t("services.field.nameAr")}
              required
              value={draft.nameAr}
              onChange={(event) => setDraft({ ...draft, nameAr: event.target.value })}
            />
            <TextInput
              label={t("services.field.nameEn")}
              required
              value={draft.nameEn}
              onChange={(event) => setDraft({ ...draft, nameEn: event.target.value })}
            />
            <Select
              label={t("services.field.type")}
              required
              value={draft.type}
              options={SERVICE_TYPES.map((type) => ({ value: type, label: typeLabel(type) }))}
              onChange={(event) => setDraft({ ...draft, type: event.target.value as ServiceType })}
            />
            <TextInput
              label={t("services.field.duration")}
              numeric
              required
              inputMode="numeric"
              value={String(draft.durationMinutes)}
              onChange={(event) => setDraft({ ...draft, durationMinutes: Number(event.target.value) || 0 })}
            />
            <TextInput
              label={t("services.field.buffer")}
              hint={t("services.field.bufferHint")}
              numeric
              inputMode="numeric"
              value={String(draft.bufferMinutes)}
              onChange={(event) => setDraft({ ...draft, bufferMinutes: Number(event.target.value) || 0 })}
            />
            {/* `MoneyInput` since the review of #99: one component for every money field, and it
                keeps the typed text so a trailing decimal point is not trimmed mid-keystroke. */}
            <MoneyInput
              label={t("services.field.price")}
              hint={t("services.field.priceHint").replace("{currency}", me.currency)}
              required
              currency={me.currency}
              valueMinor={draft.priceMinor}
              onChangeMinor={(minor) => setDraft({ ...draft, priceMinor: minor ?? 0 })}
              data-testid="service-price"
            />
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(open) => { if (!open) setToggling(null); }}
        title={toggling?.isActive === false ? t("services.reactivate.title") : t("services.deactivate.title")}
        message={
          toggling === null
            ? ""
            : !toggling.isActive
              ? t("services.reactivate.message")
              : toggling.futureAppointmentCount === 0
                ? t("services.deactivate.none")
                : t("services.deactivate.inUse").replace(
                    "{count}",
                    String(toggling.futureAppointmentCount),
                  )
        }
        confirmLabel={
          toggling?.isActive === false ? t("services.reactivate.confirm") : t("services.deactivate.confirm")
        }
        cancelLabel={t("services.cancel")}
        tone={toggling?.isActive === false ? "primary" : "danger"}
        onConfirm={() => { if (toggling !== null) void toggleActive(toggling); }}
      />
    </div>
  );
}
