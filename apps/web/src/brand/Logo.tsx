// The mark, the lockup, and the monochrome print variant. Item 2 of the 2026-09-15 rebrand.

import { BRAND } from "./brand.ts";

/**
 * The symbol alone — sidebar, favicon-adjacent chrome, anywhere small.
 *
 * `<img>` rather than an inlined `<svg>`: the file is in `public/`, so it is fetched once and
 * cached, and it does not sit in the JavaScript bundle on every route. The trade is that
 * `currentColor` cannot reach it, which is why the monochrome variant is a separate file rather
 * than a prop.
 */
export function BrandMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <img
      src={BRAND.markSvg}
      width={size}
      height={size}
      // Decorative wherever it sits beside the product's name, which is every current use. The
      // name is the accessible label; a second "NOMED" read out beside it is noise.
      alt=""
      aria-hidden="true"
      className={className}
      style={{ width: size, height: "auto" }}
    />
  );
}

/** The mark with the wordmark under it. One screen shows the logo large, and this is it. */
export function BrandLockup({ width = 220, className }: { width?: number; className?: string }) {
  return (
    <img
      src={BRAND.lockupWebp}
      alt={BRAND.name}
      className={className}
      style={{ width, height: "auto" }}
      // The login screen's largest asset. Eager, because it is above the fold and the whole point
      // of the panel; `fetchpriority` moves it ahead of the background.
      fetchPriority="high"
    />
  );
}

/**
 * The print footer's line: a small monochrome mark and "Powered by NOMED OS".
 *
 * **The clinic's identity leads; ours is a credit.** `ARCHITECTURE.md`'s letterhead is the clinic's
 * name, address and registration — a patient's prescription is from their doctor, not from us — so
 * this sits at the bottom, at 9px, in the muted ink, and is never the largest thing on the sheet.
 */
export function PoweredBy({ className }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-[9px] text-ink-subtle ${className ?? ""}`}>
      <img src={BRAND.markMonoSvg} alt="" aria-hidden="true" style={{ width: 10, height: "auto" }} />
      {BRAND.poweredBy}
    </span>
  );
}
