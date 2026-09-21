// The plan line, computed from PRICING.md §3 — never stored. Ruled 2026-09-14.
// Money is integer minor units, like every amount in this system.

/**
 * **There are no tiers.** `PRICING.md` §3 is one plan priced by size, so a `plan` column on
 * `tenants` would be a second copy of a fact that document holds authoritatively — with nothing to
 * keep the copy honest. The same reasoning deleted the status sections from the phase documents.
 *
 * Currency is deliberately absent: it lives on `tenants.currency`, and a figure formatted as EGP
 * here would be the thing `CLAUDE.md` forbids. These are minor units and the caller formats them.
 */
export const PRICING = {
  baseMinor: 150_000,
  baseIncludesDoctors: 1,
  baseIncludesMessages: 1_000,
  perExtraDoctorMinor: 90_000,
  perExtraDoctorMessages: 700,
  setupMinor: 350_000,
} as const;

export interface PlanLine {
  doctors: number;
  /** What this clinic is billed monthly, at its current doctor count. */
  monthlyMinor: number;
  /** Messages included at that size. The quota is the largest cost lever (PRICING.md §3). */
  includedMessages: number;
  /** One-time, and charged once at onboarding. Shown because the list is also a sales surface. */
  setupMinor: number;
}

/**
 * A clinic with no doctors yet still pays the base fee: the base includes one doctor rather than
 * being a per-doctor rate, so `max(0, doctors - 1)` is the extra count and never a negative.
 */
export function planFor(doctors: number): PlanLine {
  const extra = Math.max(0, doctors - PRICING.baseIncludesDoctors);
  return {
    doctors,
    monthlyMinor: PRICING.baseMinor + extra * PRICING.perExtraDoctorMinor,
    includedMessages: PRICING.baseIncludesMessages + extra * PRICING.perExtraDoctorMessages,
    setupMinor: PRICING.setupMinor,
  };
}
