// Small pure pieces of self-serve signup, kept apart from whatsapp-signup.ts so they unit-test
// without a database.

import { randomBytes, randomInt } from "node:crypto";

/**
 * `tenants.slug` is unique and Arabic does not slug. English name when there is one, plus a random
 * suffix, which is what makes a collision a non-event rather than a refusal the clinic has to read.
 */
export function buildClinicSlug(nameEn: string | null | undefined, suffix: string = randomBytes(3).toString("hex")): string {
  const base = (nameEn ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return base === "" ? `clinic-${suffix}` : `${base}-${suffix}`;
}

/** The two-step verification PIN Meta asks for at registration: six digits, leading zeros allowed. */
export function randomRegistrationPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}
