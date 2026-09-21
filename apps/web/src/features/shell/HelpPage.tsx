// «مساعدة» — a static page, item 4 of the 2026-09-15 rebrand.

import { BRAND } from "../../brand/brand.ts";
import { Card } from "../../design-system/display.tsx";
import { useLocale } from "../../i18n/locale-context.tsx";
import type { TranslationKey } from "../../i18n/strings.ts";
import { SupportLink } from "./SupportLink.tsx";

/**
 * Static, and deliberately so.
 *
 * It answers the questions the pilot will actually produce — how to book, where a patient's file
 * is, why a screen refuses — from strings, with no endpoint behind it. A help *system* is a
 * content pipeline, a search index and a thing that goes stale; this is a page, and when the pilot
 * shows which five questions are real it gets those five answers rather than a framework.
 *
 * The one live element is the support link, which is already conditional on
 * `VITE_SUPPORT_WHATSAPP` and renders nothing when there is nobody to reach.
 */

const SECTIONS: { title: TranslationKey; body: TranslationKey }[] = [
  { title: "help.booking.title", body: "help.booking.body" },
  { title: "help.queue.title", body: "help.queue.body" },
  { title: "help.patients.title", body: "help.patients.body" },
  { title: "help.payments.title", body: "help.payments.body" },
  { title: "help.refusals.title", body: "help.refusals.body" },
];

export function HelpPage() {
  const { t } = useLocale();

  return (
    <div className="mx-auto max-w-3xl p-6" data-testid="help-page">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-ink">{t("help.title")}</h1>
        <p className="mt-1 text-sm text-ink-muted">{t("help.subtitle")}</p>
      </header>

      <div className="flex flex-col gap-3">
        {SECTIONS.map((section) => (
          <Card key={section.title} title={t(section.title)}>
            <p className="whitespace-pre-line text-sm text-ink-muted">{t(section.body)}</p>
          </Card>
        ))}

        <Card title={t("help.contact.title")}>
          <p className="text-sm text-ink-muted">{t("help.contact.body")}</p>
          <div className="mt-3">
            <SupportLink />
          </div>
        </Card>
      </div>

      <p className="mt-6 text-center text-xs text-ink-subtle">{BRAND.name}</p>
    </div>
  );
}
