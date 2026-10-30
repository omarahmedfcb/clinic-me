import type { AppointmentStatus } from "../../domain/appointment-status.ts";

/**
 * The ruled status colours, as timeline fills.
 *
 * These mirror `STATUS_TONES` in the design system rather than importing it, because a badge and a
 * bar are different problems: a badge carries its own text, so a pale fill with dark text reads
 * fine; a bar forty pixels wide carries no text at all, so the fill has to do the whole job. Every
 * one therefore gets a visible fill plus a border, and the three greens keep the same L* 93 / 69 /
 * 45 spacing that makes them separable.
 *
 * `CANCELLED` and `NO_SHOW` are absent on purpose: they release the slot, so no block is ever
 * built for them. `Record<AppointmentStatus, string>` still requires them, and giving them the
 * neutral tone is honest about their being unreachable rather than pretending they render.
 */
/**
 * Timeline fills — **solid tokens, not the `-soft` tints the badges use.**
 *
 * These were the soft variants and were effectively invisible: `warning-soft` is `#fffaeb` and
 * `green-soft` is `#d3f2e5`, painted over a `primary-soft` (`#f0fdfa`) background. Three
 * near-whites against each other. At a metre — which is how a receptionist reads this screen — the
 * bar looked empty.
 *
 * The badge ramp in `PHASE-2.md` §18 is right for a badge and wrong here, and the reason is the
 * object, not the colour: a chip is small, carries dark text, and sits on white, so L\* 93 reads
 * fine. A wide bar block carries no text and sits on a tinted background, so the same value
 * disappears. The ruling's *intent* — three greens deepening through CONFIRMED → ARRIVED →
 * WAITING — is preserved; every step just moves up the ramp so all three are visible as fills.
 *
 * `COMPLETED` is deliberately the one with no fill: outline only, per the ruling.
 */
export const TIMELINE_TONES: Record<AppointmentStatus, string> = {
  BOOKED: "bg-amber border-amber-ink",
  CONFIRMED: "bg-green-mid border-green-strong",
  ARRIVED: "bg-green-strong border-green-ink",
  WAITING: "bg-green-ink border-green-ink",
  // §18 rules IN_CONSULTATION "light grey", which is right on a white card and fails here: the
  // light grey token (#cbd4d8) measures 1.40:1 against the light-blue free background — still
  // nearly invisible, and grey on pale blue has no hue difference to fall back on either. The
  // muted ink token is 5.17:1 against free and stays 1.84:1 apart from the break grey, so the two
  // greys on this bar remain distinguishable. Reported rather than absorbed.
  IN_CONSULTATION: "bg-success border-ink-muted",
  // Q34: still occupying the slot, so it is still drawn as a busy block. It was blue until the
  // rebrand made `info` a teal (index.css), which put it 1.4 deltaE from IN_CONSULTATION's
  // `success` teal -- two bars no one could tell apart. The dark gold `warning` token reads at bar
  // size and is 31 deltaE from every other bar (status-colour-separation.spec.ts measures it).
  PAUSED: "bg-warning border-warning",
  COMPLETED: "bg-transparent border-ink-muted",
  // Never drawn: both release the slot, so no busy block is ever built for them
  // (slot-engine-boundaries.spec.ts asserts it). Present so the map stays total.
  CANCELLED: "bg-danger border-danger",
  NO_SHOW: "bg-danger border-danger",
};

/** Free/available: light blue (لبني). A background, so it stays light on purpose. */
export const FREE_TONE = "bg-info-soft";

/** Breaks and blocked time: solid grey, so an empty stretch can no longer mean two things. */
export const UNAVAILABLE_TONE = "bg-ink-subtle";
