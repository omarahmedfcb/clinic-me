// One definition of what a new clinic is — pilot-readiness 0g. The console and the seed both use it,
// so a column added here cannot reach one path and miss the other.

import { uuidv7 } from "uuidv7";
import type { LocaleCode } from "../../generated/prisma/enums.ts";

/** The three §18b names. A fourth is a migration to the CHECK, not a string somebody types. */
export type SupportedCountry = "EG" | "SA" | "AE";

export interface NewTenantFields {
  name: string;
  slug: string;
  phone: string;
  address: string;
  timezone: string;
  /** ISO 3166-1 alpha-2. The phone-parsing hint for this clinic (ARCHITECTURE.md §18b). */
  country: SupportedCountry;
  currency: string;
  locale?: LocaleCode;
  /** The blueprint carries these; the console does not ask for them. Absent is not empty. */
  nameEn?: string | null;
  addressEn?: string | null;
}

/**
 * The row a new clinic starts as.
 *
 * **Pure, and it generates the id.** Both callers write through different sessions — the console
 * unbound, the seed through the base client — so this returns data rather than performing a write;
 * the shape is the thing being shared, not the transaction.
 *
 * `status: ACTIVE` and `settings: {}` are the two defaults worth naming: a clinic is live from the
 * moment it exists (suspension is an act somebody takes, 0d), and `settings` is Json with no defined
 * shape, so an empty object is the only honest starting value.
 */
export function newTenantData(input: NewTenantFields): {
  id: string;
  name: string;
  nameEn: string | null;
  slug: string;
  phone: string;
  address: string;
  addressEn: string | null;
  timezone: string;
  country: SupportedCountry;
  locale: LocaleCode;
  currency: string;
  status: "ACTIVE";
  settings: Record<string, never>;
} {
  return {
    id: uuidv7(),
    name: input.name,
    nameEn: input.nameEn ?? null,
    slug: input.slug,
    phone: input.phone,
    address: input.address,
    addressEn: input.addressEn ?? null,
    timezone: input.timezone,
    country: input.country,
    // Arabic default, RTL first — the locked decision in CLAUDE.md. A console that asked would be
    // offering a choice the product has already made.
    locale: input.locale ?? "ar",
    currency: input.currency,
    status: "ACTIVE",
    settings: {},
  };
}
