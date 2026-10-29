// The two reads clinic-facing code needs about a subscription. Kept apart from subscription.ts so the
// sign-in controller does not import the platform's suspension machinery just to ask a question.

import { prisma } from "../../prisma/client.ts";

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

/** The clinic's renewal date, for the in-app banner. Null when none is recorded. */
export async function subscriptionEndFor(tenantId: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ renewal_on: Date | null }[]>`
    SELECT subscription_end_for_tenant(${tenantId}::uuid) AS renewal_on
  `;
  const value = rows[0]?.renewal_on ?? null;
  return value === null ? null : asDay(value);
}

/** Whether a person whose password just verified belongs to a clinic that expired. */
export async function hasExpiredSubscription(userId: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ expired: boolean }[]>`
    SELECT user_has_expired_subscription(${userId}::uuid) AS expired
  `;
  return rows[0]?.expired === true;
}
