// What a coexistence onboarding owes Meta afterwards: ask for the clinic's contacts and chat history,
// once each, within 24 hours -- miss the window and the clinic must offboard and run Embedded Signup
// again. Asking is the whole job. The data Meta then pushes to our webhook is acknowledged and
// dropped (whatsapp.controller.ts): the bot keeps its own state, and a clinic's address book and
// patient chats are not something this platform should be holding.

import { withTenant } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { MetaOnboardingError, requestSmbAppDataSync } from "./meta-onboarding.ts";

const SYNC_TYPES = ["smb_app_state_sync", "history"] as const;
const RETRY_DELAYS_MS = [0, 10_000, 60_000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function requestWithRetry(
  accessToken: string,
  phoneNumberId: string,
  syncType: (typeof SYNC_TYPES)[number],
): Promise<boolean> {
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await sleep(delay);
    try {
      await requestSmbAppDataSync(accessToken, phoneNumberId, syncType);
      return true;
    } catch (error) {
      console.warn(`WhatsApp coexistence: ${syncType} request failed`, error instanceof MetaOnboardingError ? error.message : error);
    }
  }
  return false;
}

/**
 * Fire-and-forget after the connection row exists. Records `sync_requested_at` only when both syncs
 * were accepted, so a clinic whose syncs failed is findable (`sync_requested_at IS NULL` on a
 * COEXISTENCE row) while its 24 hours are still running.
 */
export async function runCoexistenceSync(tenantId: string, accessToken: string, phoneNumberId: string): Promise<void> {
  let allAccepted = true;
  for (const syncType of SYNC_TYPES) {
    if (!(await requestWithRetry(accessToken, phoneNumberId, syncType))) {
      allAccepted = false;
      console.error(`WhatsApp coexistence: ${syncType} was NOT accepted for tenant ${tenantId}; the 24-hour window is running`);
    }
  }
  if (!allAccepted) return;

  const actor = { ...(await systemActor()), ip: "whatsapp", userAgent: "clinic-os-whatsapp" };
  await withTenant(tenantId, actor, (tx) =>
    tx.whatsAppConnection.updateMany({ where: { tenantId }, data: { syncRequestedAt: new Date() } }),
  ).catch((error: unknown) => console.error("WhatsApp coexistence: could not record the sync", error));
}
