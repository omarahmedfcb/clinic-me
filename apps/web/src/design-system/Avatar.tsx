// A person's face, or their initials. Presentational: the caller fetches the image and passes a URL.
// Kept out of the features so the shell, the users list and the doctors list draw one shape.

import { useLocale } from "../i18n/locale-context.tsx";

const SIZES = { sm: "h-7 w-7 text-[10px]", md: "h-9 w-9 text-xs", lg: "h-16 w-16 text-base" } as const;

/**
 * Initials from a name, in whatever script it is written in.
 *
 * First and last word rather than the first two, and the definite article is dropped from the last:
 * Egyptian family names very often begin with «ال», so «أحمد عبد الرحمن الشناوي» would otherwise
 * read أا, as would «هشام محمود الديب» — every second person reduced to the same two letters.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter((word) => word !== "");
  const first = words.at(0)?.charAt(0) ?? "";
  const family = words.length > 1 ? (words.at(-1) ?? "") : "";
  const bare = family.startsWith("ال") && family.length > 2 ? family.slice(2) : family;
  return `${first}${bare.charAt(0)}`;
}

export function Avatar({
  name,
  src,
  size = "md",
}: {
  name: string;
  /** The photo, already fetched as an object URL, or null for initials. */
  src: string | null;
  size?: keyof typeof SIZES;
}) {
  const { t } = useLocale();
  const shape = `${SIZES[size]} shrink-0 rounded-full border border-border object-cover`;

  if (src === null) {
    return (
      <span
        aria-hidden="true"
        data-testid="avatar-initials"
        className={`${shape} flex items-center justify-center bg-surface-sunken font-medium text-ink-muted`}
      >
        {initialsOf(name)}
      </span>
    );
  }

  // The name is already beside every avatar this app draws, so the image itself is decorative and
  // an alt repeating the name would make a screen reader say it twice.
  return <img src={src} alt={t("avatar.alt")} title={name} className={`${shape} bg-surface-sunken`} />;
}
