// Subscription expiry and the bot's pause. A clinic's subscription is a range -- `subscriptionStartsOn`
// to `renewalOn`, both days inclusive, in the clinic's own timezone (client file; subscription-dates.ts).
//
//   no range / not started yet  the bot goes silent (tenants.bot_paused). Staff can still sign in.
//   range running               the bot works.
//   last day passed             the clinic is SUSPENDED with the reason `SUBSCRIPTION_EXPIRED`, from the
//                               next local midnight: sign-in, live sessions, the bot and the reminder
//                               sending all stop. Renewal (platform-clinics.ts `renewClinic`) merges a new
//                               range into the old one and reactivates it, with the WhatsApp connection
//                               and bot credential untouched -- no second Embedded Signup.
//
// This pass runs inside the `clinic-os-outbound` loop every OUTBOUND_INTERVAL_MS, so a start day that
// arrives switches the bot on by itself, and a clinic with no range is silenced without anybody asking.

import { withPlatformActor } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { setClinicSuspension } from "./platform-clinics.ts";
import { botIsPausedIn, subscriptionPhase, SUBSCRIPTION_EXPIRED_REASON } from "./subscription-dates.ts";

/**
 * Brings every ACTIVE clinic in line with its range. Idempotent and safe to run often: a clinic
 * already suspended is not touched, and a pass that overlaps another cannot suspend twice (the second
 * is refused as ALREADY_IN_THAT_STATE and ignored).
 *
 * `suspended` counts clinics suspended by this pass; `botChanged` counts clinics whose bot was switched
 * on or off by it.
 */
export async function runExpiryPass(now: Date = new Date()): Promise<{ suspended: number; botChanged: number }> {
  const system = await systemActor();

  // The client file is operator-only under row-level security, so the worker cannot read the table: it
  // reads the ranges through a function that answers the system actor alone (see the migration).
  const { ranges, tenants } = await withPlatformActor(system, async (tx) => ({
    ranges: await tx.$queryRaw<{ tenant_id: string; starts_on: string; ends_on: string }[]>`
      SELECT tenant_id, starts_on, ends_on FROM subscription_ranges_for_worker()
    `,
    tenants: await tx.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, timezone: true, botPaused: true },
    }),
  }));

  const rangeOf = new Map(ranges.map((range) => [range.tenant_id, range]));
  let suspended = 0;
  let botChanged = 0;

  for (const tenant of tenants) {
    try {
      const range = rangeOf.get(tenant.id);
      const startsOn = range?.starts_on ?? null;
      const endsOn = range?.ends_on ?? null;

      const phase = subscriptionPhase(startsOn, endsOn, now, tenant.timezone);

      if (phase === "ENDED") {
        const result = await setClinicSuspension(system, tenant.id, {
          suspended: true,
          reason: SUBSCRIPTION_EXPIRED_REASON,
        });
        if (result.ok) {
          suspended += 1;
          console.log(`subscription-expiry: suspended tenant ${tenant.id} (last day ${endsOn})`);
        }
        continue;
      }

      const shouldPause = botIsPausedIn(phase);
      if (shouldPause !== tenant.botPaused) {
        await withPlatformActor(system, (tx) =>
          tx.tenant.update({ where: { id: tenant.id }, data: { botPaused: shouldPause } }),
        );
        botChanged += 1;
        console.log(
          `subscription-bot: ${shouldPause ? "paused" : "resumed"} bot for tenant ${tenant.id} (${phase.toLowerCase()})`,
        );
      }
    } catch (error) {
      // One clinic's failure must not stop the others, or the rest of the pass.
      console.error(`subscription-expiry: tenant ${tenant.id} failed:`, error);
    }
  }

  return { suspended, botChanged };
}
