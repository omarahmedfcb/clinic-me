// Tenant resolution for an inbound WhatsApp webhook. ARCHITECTURE.md §11: "phone_number_id ->
// tenant_id mapping is the tenant resolution key. Never trust anything else in the payload" -- so
// this is the one lookup the webhook handler is allowed to trust a clinic's identity from.

import { prisma } from "../../prisma/client.ts";
import { resolveBotActor, type BotActor } from "../webchat/webchat-clinics.ts";
import type { BotApiClient } from "./bot-api-client.ts";
import { NumberMode, resolveWhatsAppAccess } from "./whatsapp-connections.ts";

export interface WhatsAppTenant {
  id: string;
  timezone: string;
  /** Arabic is the clinic's name of record (Tenant.name — required); nameEn is nullable the same
   *  way the letterhead falls back (Q45's note on Tenant.nameEn) -- the welcome message
   *  (whatsapp-flow-text.ts) uses whichever matches the language it opens in, falling back to
   *  Arabic if the clinic never filled in an English name. */
  clinicName: string;
  clinicNameEn: string | null;
  /** The clinic's own Meta phone number id -- the same value it was resolved by, threaded back out
   *  because sending a reply (whatsapp-graph-client.ts) needs to say which number it is replying
   *  from, and it must be this clinic's own number, never one read off the inbound payload again. */
  phoneNumberId: string;
  bot: BotActor;
}

/** A `WhatsAppTenant` plus what this clinic sends and calls /bot/* with. Kept off the base type so the
 *  flow (which needs neither) and its spec do not depend on credentials. */
export interface ResolvedWhatsAppTenant extends WhatsAppTenant {
  accessToken: string;
  client: BotApiClient;
  /** COEXISTENCE: staff can also answer on this number from the Business app, so a human handoff
 *  has somewhere to go. NEW_NUMBER: nobody can, and the bot says so when asked. */
  numberMode: NumberMode;
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
export async function resolveTenantByPhoneNumberId(phoneNumberId: string): Promise<ResolvedWhatsAppTenant | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { whatsappPhoneNumberId: phoneNumberId, status: "ACTIVE" },
    select: { id: true, timezone: true, whatsappPhoneNumberId: true, name: true, nameEn: true },
  });
  if (tenant === null || tenant.whatsappPhoneNumberId === null) return null;

  const bot = await resolveBotActor(tenant.id);
  if (bot === null) return null;

  const access = await resolveWhatsAppAccess(tenant.id, tenant.whatsappPhoneNumberId);
  if (access === null) return null;

  return {
    id: tenant.id,
    timezone: tenant.timezone,
    clinicName: tenant.name,
    clinicNameEn: tenant.nameEn,
    phoneNumberId: tenant.whatsappPhoneNumberId,
    bot,
    accessToken: access.accessToken,
    client: access.client,
    numberMode: access.numberMode
  };
}
