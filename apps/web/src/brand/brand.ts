// The product's name and marks, in one place. Item 7 of the 2026-09-15 rebrand.

/**
 * **The display name, and the only place it is spelled.**
 *
 * The rename is a display-layer change: the repository, the npm packages, the database, the storage
 * keys and every internal identifier stay `clinic-os`. Renaming those would be a migration with no
 * user-visible benefit, and `localStorage` keys like `clinic-os.locale` would silently orphan every
 * saved preference on the machines that already hold them.
 *
 * So the rule is narrow and checkable: **what a person reads says NOMED OS; what a machine reads
 * stays clinic-os.** `brand-name.spec.ts` sweeps the rendered strings for the old name and fails on
 * it, and deliberately does not sweep identifiers.
 */
export const BRAND = {
  /** The product, as a person reads it. */
  name: "NOMED OS",
  /** The vendor. Kept separate: the clinic's own name is what leads a letterhead, not ours. */
  vendor: "NOMED",
  /** The one sentence a print footer carries, assembled here so it cannot drift between sheets. */
  poweredBy: "Powered by NOMED OS",
  /** Paths, not imports: these are in `public/` so they are cacheable and not re-encoded per build. */
  markSvg: "/brand/nomed-mark.svg",
  markMonoSvg: "/brand/nomed-mark-mono.svg",
  lockupWebp: "/brand/nomed-lockup.webp",
  loginBackground: "/brand/login-bg.webp",
} as const;

/**
 * The document title for a screen.
 *
 * One function so every tab reads the same way round — the screen first, the product second, which
 * is what a person scanning eight tabs actually needs.
 */
export const documentTitle = (screen?: string): string =>
  screen === undefined || screen.trim() === "" ? BRAND.name : `${screen} — ${BRAND.name}`;
