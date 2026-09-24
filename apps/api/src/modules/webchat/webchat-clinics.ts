// Resolving which clinic a web-chat patient is talking to, and whether it has agreed to receive
// bookings this way. Neither question has a signed-in user behind it, so neither goes through
// withTenant() with a real request actor -- see the two mechanisms below and why each is safe to
// run unbound.

import { prisma } from "../../prisma/client.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";

export interface BookableClinic {
  id: string;
  name: string;
  nameEn: string | null;
  country: string;
  timezone: string;
}

export interface BotActor {
  membershipId: string;
  userId: string;
}

const CLINIC_SELECT = { id: true, name: true, nameEn: true, country: true, timezone: true } as const;

/**
 * The clinic's AI_AGENT membership, if one has been provisioned.
 *
 * Its existence *is* "this clinic subscribed to bot booking" -- an admin gets one the same way a
 * WhatsApp bot would, by issuing a bot credential (`bot-credential.controller.ts`, which creates
 * exactly this membership alongside the credential). We never need the credential's secret here:
 * the web chat runs in this same process, so once the membership is resolved we build a caller
 * context directly, the way `ARCHITECTURE.md §12`'s tool registry always intended, rather than
 * round-tripping through `/bot/auth/token`.
 *
 * Read under the system actor because this call is infrastructure resolving an identity, not the
 * bot acting yet -- once resolved, every further call in the conversation uses the returned
 * membership as the actor, so audit rows are attributed to the clinic's own AI_AGENT, not to
 * "system".
 */
export async function resolveBotActor(tenantId: string): Promise<BotActor | null> {
  const actor = await systemActor();
  return withTenant(tenantId, actor, async (tx) => {
    const membership = await tx.membership.findFirst({
      where: { role: "AI_AGENT", status: "ACTIVE" },
      select: { id: true, userId: true },
    });
    return membership === null ? null : { membershipId: membership.id, userId: membership.userId };
  });
}

/** One clinic, by id -- for `select_clinic`, once the patient has named one from the list below. */
export async function getBookableClinic(clinicId: string): Promise<BookableClinic | null> {
  try {
    return await prisma.tenant.findFirst({ where: { id: clinicId, status: "ACTIVE" }, select: CLINIC_SELECT });
  } catch {
    // A malformed id (not a UUID) throws from Prisma's own validation rather than returning null --
    // treated the same as "no such clinic", since that is what it is to the patient asking.
    return null;
  }
}

/**
 * Every active clinic bookable through this chat -- name and locale only, nothing a patient could
 * not already learn by calling the clinic directly.
 *
 * Reads `tenants` with no bound session, on purpose: `prisma/sql/14-tenants-rls.sql`'s policy (D22)
 * permits exactly this -- an unbound session sees the whole directory, which is what a "which
 * clinic?" question needs before any tenant is known. Filtering to clinics with an AI_AGENT
 * membership costs one extra lookup per tenant rather than a join, because that lookup is
 * RLS-scoped and a cross-tenant join cannot be. Fine at this scale; worth a dedicated query if the
 * clinic count ever grows past a page.
 */
export async function listBookableClinics(): Promise<BookableClinic[]> {
  const tenants = await prisma.tenant.findMany({
    where: { status: "ACTIVE" },
    select: CLINIC_SELECT,
    orderBy: { name: "asc" },
  });
  console.log("tenants", tenants);

  const flags = await Promise.all(tenants.map((tenant) => resolveBotActor(tenant.id)));
  console.log("flags", flags);
  return tenants.filter((_tenant, index) => flags[index] !== null);
}
