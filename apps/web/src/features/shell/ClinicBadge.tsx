// The top bar's identity block: the clinic's own mark, its name as the page's heading, and who you
// are here underneath. Presentational — the caller fetches the logo, as it does for an avatar.

import { useLocale } from "../../i18n/locale-context.tsx";
import { clinicInitials } from "./clinic-initials.ts";

/**
 * **The clinic's identity leads, and ours is never borrowed for it.**
 *
 * Ruled 2026-09-15 on review of the rebrand: the clinic name becomes the primary heading at page-
 * title size, with the signed-in person and their role as secondary text beneath — and the mark
 * beside it is *the clinic's own*. When no logo has been uploaded the fallback is the clinic's
 * initials in a teal disc, **not the NOMED mark**, so no clinic ever looks like it belongs to us.
 *
 * The founder's words: *"the NOMED logo stays in the sidebar only."* That is the whole rule, and it
 * is what `ClinicBadge.spec.tsx` asserts in both states.
 *
 * The teal is the brand's, which is not a contradiction: a coloured disc behind two letters is
 * chrome, the way a button is. What it must not be is our *mark*, which is a claim about whose
 * clinic this is.
 */
export function ClinicBadge({
  clinicName,
  logoUrl,
  userName,
  roleText,
  onAccount,
}: {
  clinicName: string;
  /** Already fetched as an object URL by the caller, or null when the clinic has uploaded none. */
  logoUrl: string | null;
  userName: string;
  roleText: string;
  onAccount: () => void;
}) {
  const { t } = useLocale();

  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="clinic-badge">
      {logoUrl === null ? (
        <span
          aria-hidden="true"
          data-testid="clinic-initials"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-white"
        >
          {clinicInitials(clinicName)}
        </span>
      ) : (
        // Decorative: the clinic's name is right beside it and is the accessible name. `contain`
        // rather than `cover`, because a logo cropped to a circle is a logo nobody approved.
        <img
          src={logoUrl}
          alt=""
          aria-hidden="true"
          data-testid="clinic-logo"
          title={clinicName}
          className="h-10 w-10 shrink-0 rounded-full border border-border bg-surface object-contain p-0.5"
        />
      )}

      <div className="min-w-0">
        {/*
          The page's heading. `h1` and not a styled `<p>`: it is the primary heading of every screen
          in the shell, and the one thing that must visibly change when the clinic switches.
        */}
        <h1 className="truncate text-xl font-semibold text-ink" data-testid="clinic-name">
          {clinicName}
        </h1>

        {/*
          The account menu, reachable by every role since 2026-09-13: «بياناتي» holds a person's own
          name, phone and photo, and a doctor's print fields only if there is a doctor record. A
          person's own row is not a section of the clinic, so it is the name rather than a sidebar
          entry.
        */}
        <button
          type="button"
          data-testid="account-menu"
          aria-label={t("shell.accountMenu")}
          onClick={onAccount}
          className="truncate text-xs text-ink-muted underline decoration-border-strong underline-offset-2 hover:decoration-ink"
        >
          {userName} · {roleText} · {t("shell.myProfile")}
        </button>
      </div>
    </div>
  );
}
