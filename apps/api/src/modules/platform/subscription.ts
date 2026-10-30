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

const asDay = (value: Date): string => value.toISOString().slice(0, 10);

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

  const { files, tenants } = await withPlatformActor(system, async (tx) => ({
    files: await tx.platformClinicFile.findMany({
      select: { tenantId: true, subscriptionStartsOn: true, renewalOn: true },
    }),
    tenants: await tx.tenant.findMany({
      where: { status: "ACTIVE" },
      select: { id: true, timezone: true, botPaused: true, createdAt: true },
    }),
  }));

  const fileOf = new Map(files.map((file) => [file.tenantId, file]));
  let suspended = 0;
  let botChanged = 0;

  for (const tenant of tenants) {
    try {
      const file = fileOf.get(tenant.id);
      const endsOn = file?.renewalOn ? asDay(file.renewalOn) : null;
      let startsOn = file?.subscriptionStartsOn ? asDay(file.subscriptionStartsOn) : null;

      // A file written before the range existed has an end day and no start day. Its start is the day
      // the clinic was created (or the end day if that is later), so it keeps working exactly as it did.
      if (file !== undefined && endsOn !== null && startsOn === null) {
        const created = asDay(tenant.createdAt);
        startsOn = created < endsOn ? created : endsOn;
        const backfilled = startsOn;
        await withPlatformActor(system, (tx) =>
          tx.platformClinicFile.update({
            where: { tenantId: tenant.id },
            data: { subscriptionStartsOn: new Date(`${backfilled}T00:00:00.000Z`) },
          }),
        );
      }

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
