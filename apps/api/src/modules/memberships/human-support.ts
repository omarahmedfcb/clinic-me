// Who a patient is sent to when they ask for a person on WhatsApp.
//
// One receptionist per clinic, chosen by an admin in the Users tab (`tenants.human_support_membership_id`).
// The rule that turns that column into an answer is `pickHumanSupport`, and it is pure so the Users
// tab, the bot and the tests all read one definition:
//
//   - the chosen receptionist, if they are still an ACTIVE receptionist of this clinic;
//   - otherwise the clinic's only active receptionist, if there is exactly one;
//   - otherwise nobody (two or more and none chosen, or none at all) -- the bot says it is unavailable.
//
// The "only receptionist" case is made permanent the moment a second receptionist is added
// (`pinSoleReceptionist`), so adding a colleague never silently changes who patients are sent to.

import type { TransactionClient } from "../../prisma/with-tenant.ts";

export interface HumanSupportCandidate {
  membershipId: string;
  fullName: string;
  phoneE164: string;
}

export function pickHumanSupport<T extends { membershipId: string }>(
  chosenMembershipId: string | null,
  activeReceptionists: readonly T[],
): T | null {
  if (chosenMembershipId !== null) {
    const chosen = activeReceptionists.find((candidate) => candidate.membershipId === chosenMembershipId);
    if (chosen !== undefined) return chosen;
  }
  return activeReceptionists.length === 1 ? (activeReceptionists[0] as T) : null;
}

/** Every ACTIVE receptionist of the clinic the transaction is bound to, oldest first. */
async function activeReceptionists(tx: TransactionClient): Promise<HumanSupportCandidate[]> {
  const rows = await tx.membership.findMany({
    where: { role: "RECEPTIONIST", status: "ACTIVE" },
    select: { id: true, user: { select: { fullName: true, phoneE164: true } } },
    orderBy: { createdAt: "asc" },
  });
  return rows.map((row) => ({ membershipId: row.id, fullName: row.user.fullName, phoneE164: row.user.phoneE164 }));
}

/** The clinic's human support right now, or `null`. Runs inside a tenant-bound transaction. */
export async function resolveHumanSupport(tx: TransactionClient, tenantId: string): Promise<HumanSupportCandidate | null> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { humanSupportMembershipId: true },
  });
  return pickHumanSupport(tenant.humanSupportMembershipId, await activeReceptionists(tx));
}

/**
 * Call BEFORE a receptionist is added (or a member is changed into one). If the clinic is relying on
 * its single receptionist by default, that choice is written down, so the new colleague does not
 * take it over by accident. Does nothing when somebody is already chosen or there is no sole one.
 */
export async function pinSoleReceptionist(tx: TransactionClient, tenantId: string): Promise<void> {
  const tenant = await tx.tenant.findUniqueOrThrow({
    where: { id: tenantId },
    select: { humanSupportMembershipId: true },
  });
  const candidates = await activeReceptionists(tx);
  const current = pickHumanSupport(tenant.humanSupportMembershipId, candidates);
  if (current === null || current.membershipId === tenant.humanSupportMembershipId) return;
  await tx.tenant.update({ where: { id: tenantId }, data: { humanSupportMembershipId: current.membershipId } });
}
