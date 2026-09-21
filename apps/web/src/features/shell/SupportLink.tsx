import { BRAND } from "../../brand/brand.ts";
import { useLocale } from "../../i18n/locale-context.tsx";
import { useSession } from "../auth/session.tsx";

/**
 * "Contact the platform team" — item 6, ruled 2026-09-05: **a WhatsApp link, not a form and not a
 * ticket system.**
 *
 * The costing put the three options at one hour, two days and three weeks. The founder took the
 * hour, and it is the right call for more than the price: Egypt runs on WhatsApp, the clinic is
 * already reaching us there, and a form would need mail delivery — which this system does not have
 * — to deposit a message in the same inbox a WhatsApp thread already reaches.
 *
 * ## It renders nothing when unconfigured, and that is deliberate
 *
 * `VITE_SUPPORT_WHATSAPP` is a build-time value because Vite inlines it; there is no runtime
 * setting for it and it is not clinic data. When it is absent the link does not render at all,
 * rather than rendering a dead `wa.me/undefined` that fails only when somebody in trouble clicks
 * it. A support link that does not work is worse than none — it is a promise made at the exact
 * moment it cannot be kept.
 *
 * ## The prefilled message carries what we would otherwise have to ask for
 *
 * Clinic name and tenant id. Every support conversation starts with "which clinic is this", and a
 * tenant id in the first message is the difference between a two-minute answer and three round
 * trips. It is not sensitive: it identifies the clinic to us, and the person sending it is already
 * authenticated as a member of it.
 *
 * **No patient data, ever.** Whatever screen the user is on, this link carries the clinic and
 * nothing else. A prefilled message that quoted the current patient would put clinical context into
 * a third-party messenger, which is the one thing this product does not do.
 */
export function SupportLink() {
  const { t } = useLocale();
  const { me } = useSession();

  const number = import.meta.env["VITE_SUPPORT_WHATSAPP"];
  if (typeof number !== "string" || number.trim() === "") return null;

  // `wa.me` wants digits only — no `+`, no spaces, no dashes. Stripping here rather than demanding
  // a pre-formatted value means the variable can hold the number in whatever shape it was written
  // down in.
  const digits = number.replace(/\D/g, "");
  if (digits === "") return null;

  const message = t("shell.support.message")
    // `{product}` rather than the name in the string table: the display name is spelled once, in
    // `brand/brand.ts`, and `brand.spec.ts` fails when a second copy appears.
    .replace("{product}", BRAND.name)
    .replace("{clinic}", me.memberships.find((m) => m.tenantId === me.tenantId)?.tenantName ?? "")
    .replace("{tenantId}", me.tenantId);

  return (
    <a
      href={`https://wa.me/${digits}?text=${encodeURIComponent(message)}`}
      target="_blank"
      // `noopener` is not optional on a `target="_blank"` link: without it the opened page gets a
      // handle on this one through `window.opener` and can navigate it somewhere else.
      rel="noopener noreferrer"
      className="inline-flex items-center rounded-lg px-3 py-1.5 text-sm font-medium text-primary hover:bg-primary-soft"
    >
      {t("shell.support")}
    </a>
  );
}
