// Tenant resolution for an inbound WhatsApp webhook. ARCHITECTURE.md §11: "phone_number_id ->
// tenant_id mapping is the tenant resolution key. Never trust anything else in the payload" -- so
// this is the one lookup the webhook handler is allowed to trust a clinic's identity from.

import { prisma } from "../../prisma/client.ts";
import { resolveBotActor, type BotActor } from "../webchat/webchat-clinics.ts";

export interface WhatsAppTenant {
  id: string;
  timezone: string;
  /** The clinic's own Meta phone number id -- the same value it was resolved by, threaded back out
   *  because sending a reply (whatsapp-graph-client.ts) needs to say which number it is replying
   *  from, and it must be this clinic's own number, never one read off the inbound payload again. */
  phoneNumberId: string;
  bot: BotActor;
}

/**
 * The clinic whose WhatsApp number received this message, and its AI_AGENT membership -- reusing
 * `resolveBotActor` from the web chat rather than re-deriving "does this clinic have a bot" a
 * second way. `null` covers two cases the caller does not need to tell apart: no clinic has this
 * `phone_number_id` at all, or one does but has no live bot credential -- either way there is
 * nothing to route the message to.
 *
 * Unbound, like `webchat-clinics.ts#getBookableClinic`: resolving *which* tenant a request is for is
 * exactly the lookup that has to run before any tenant is known, so it cannot itself be tenant-scoped.
 */
export async function resolveTenantByPhoneNumberId(phoneNumberId: string): Promise<WhatsAppTenant | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { whatsappPhoneNumberId: phoneNumberId, status: "ACTIVE" },
    select: { id: true, timezone: true, whatsappPhoneNumberId: true },
  });
  if (tenant === null || tenant.whatsappPhoneNumberId === null) return null;

  const bot = await resolveBotActor(tenant.id);
  if (bot === null) return null;

  return { id: tenant.id, timezone: tenant.timezone, phoneNumberId: tenant.whatsappPhoneNumberId, bot };
}
