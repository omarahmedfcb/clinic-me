// What was done at the visit, and what it cost when recorded — Q25.
// A missing price renders as "not recorded", never as zero: null is a different fact.

import { useEffect, useState } from "react";
import { Button } from "../../design-system/Button.tsx";
import { Select, TextInput } from "../../design-system/fields.tsx";
import { formatMinor } from "../../i18n/format.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { loadServices, type Service } from "../services/services-api.ts";
import {
  addProcedure,
  loadProcedures,
  removeProcedure,
  type ProcedureLine,
} from "./draft-api.ts";

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export function ProceduresSection({
  authFetch,
  appointmentId,
  visitId,
  currency,
}: {
  authFetch: AuthFetch;
  appointmentId: string;
  visitId: string;
  /** From `tenants.currency` via the session. Never assumed — `formatMinor` takes it as input. */
  currency: string;
}) {
  const { t, locale } = useLocale();
  const [lines, setLines] = useState<ProcedureLine[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [serviceId, setServiceId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void loadProcedures(authFetch, appointmentId, visitId).then((value) => {
      if (!cancelled) setLines(value);
    });
    void loadServices(authFetch)
      .then((value) => {
        if (!cancelled) setServices(value.filter((service) => service.isActive));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authFetch, appointmentId, visitId]);

  async function add(): Promise<void> {
    if (serviceId === "") return;
    setBusy(true);
    const next = await addProcedure(authFetch, appointmentId, visitId, {
      serviceId,
      quantity: Math.max(1, Number(quantity) || 1),
    });
    setBusy(false);
    if (next !== null) {
      setLines(next);
      setServiceId("");
      setQuantity("1");
    }
  }

  async function remove(id: string): Promise<void> {
    const next = await removeProcedure(authFetch, appointmentId, visitId, id);
    if (next !== null) setLines(next);
  }

  return (
    <section className="grid gap-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-ink">{t("procedures.title")}</h2>

      <ul className="grid gap-2">
        {lines.map((line) => (
          <li
            key={line.id}
            className="flex flex-wrap items-baseline justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2"
          >
            <span className="text-sm text-ink">
              {line.serviceNameAr} × {line.quantity}
            </span>
            <span className="text-xs text-ink-muted">
              {line.source === "RECEPTION" ? t("procedures.reception") : t("procedures.doctor")}
            </span>
            <span className="text-sm text-ink" dir="ltr">
              {line.unitPriceMinor === null
                ? t("procedures.noPrice")
                : formatMinor(line.unitPriceMinor * line.quantity, currency, locale)}
            </span>
            {/* Reception's own line is not removable, and the API refuses it regardless. */}
            {line.source === "DOCTOR" && (
              <Button size="sm" variant="ghost" onClick={() => void remove(line.id)}>
                {t("procedures.remove")}
              </Button>
            )}
          </li>
        ))}
      </ul>

      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <Select
          label={t("procedures.pickService")}
          value={serviceId}
          placeholder={t("procedures.pickService")}
          options={services.map((service) => ({ value: service.id, label: service.nameAr }))}
          onChange={(event) => setServiceId(event.target.value)}
        />
        <TextInput
          label={t("procedures.quantity")}
          numeric
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
        />
        <Button size="sm" variant="secondary" loading={busy} onClick={() => void add()}>
          {t("procedures.add")}
        </Button>
      </div>
    </section>
  );
}
