// Subscription expiry. The renewal date in the client file (`renewalOn`) is the LAST day a clinic works:
// it keeps working through that whole day in its own timezone and is suspended from the next local
// midnight. Renewal is manual and happens outside the platform, so the operator sets a new date
// (platform-clinics.ts `renewClinic`) and the clinic is reactivated with its WhatsApp connection and
// bot credential untouched -- no second Embedded Signup.
//
// "Stops working" reuses the suspension that already exists, which already stops sign-in, live
// sessions (MembershipFreshnessInterceptor), the bot's webhook resolution and the outbound sweepers.

import { withPlatformActor } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { setClinicSuspension } from "./platform-clinics.ts";
import { isSubscriptionExpired, SUBSCRIPTION_EXPIRED_REASON } from "./subscription-dates.ts";

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

/**
 * Suspends every ACTIVE clinic whose last day has passed. Idempotent and safe to run often: a clinic
 * already suspended is not touched, and a pass that overlaps another cannot suspend twice (the second
 * is refused as ALREADY_IN_THAT_STATE and ignored).
 */
export async function runExpiryPass(now: Date = new Date()): Promise<{ suspended: number }> {
  const system = await systemActor();

  const { files, tenants } = await withPlatformActor(system, async (tx) => ({
    files: await tx.platformClinicFile.findMany({
      where: { renewalOn: { not: null } },
      select: { tenantId: true, renewalOn: true },
    }),
    tenants: await tx.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true, timezone: true } }),
  }));

  const zoneOf = new Map(tenants.map((tenant) => [tenant.id, tenant.timezone]));
  let suspended = 0;

  for (const file of files) {
    const zone = zoneOf.get(file.tenantId);
    // Not in the ACTIVE list: already suspended, archived, or gone.
    if (zone === undefined || file.renewalOn === null) continue;
    if (!isSubscriptionExpired(asDay(file.renewalOn), now, zone)) continue;

    const result = await setClinicSuspension(system, file.tenantId, {
      suspended: true,
      reason: SUBSCRIPTION_EXPIRED_REASON,
    });
    if (result.ok) {
      suspended += 1;
      console.log(`subscription-expiry: suspended tenant ${file.tenantId} (renewal ${asDay(file.renewalOn)})`);
    }
  }

  return { suspended };
}
