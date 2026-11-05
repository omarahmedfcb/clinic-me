// Tenant resolution for an inbound WhatsApp webhook. ARCHITECTURE.md §11: "phone_number_id ->
// tenant_id mapping is the tenant resolution key. Never trust anything else in the payload" -- so
// this is the one lookup the webhook handler is allowed to trust a clinic's identity from.

import { prisma } from "../../prisma/client.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { resolveHumanSupport } from "../memberships/human-support.ts";
import { isSubscriptionExempt } from "../platform/subscription-exemption.ts";
import { resolveBotActor, type BotActor } from "../webchat/webchat-clinics.ts";
import type { BotApiClient } from "./bot-api-client.ts";
import { resolveWhatsAppAccess, type NumberMode } from "./whatsapp-connections.ts";
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
  /** The receptionist's number (E.164) patients are sent to when they ask for a person, or `null` when
   *  the clinic has none (memberships/human-support.ts). Optional so a flow spec need not set it. */
  humanSupportPhone?: string | null;
}

/** A `WhatsAppTenant` plus what this clinic sends and calls /bot/* with. Kept off the base type so the
 *  flow (which needs neither) and its spec do not depend on credentials. */
export interface ResolvedWhatsAppTenant extends WhatsAppTenant {
  accessToken: string;
  client: BotApiClient;
  /** COEXISTENCE: staff can also answer on this number from the Business app, so the bot goes quiet on a
   *  chat a person has replied in (whatsapp-handoff.ts). NEW_NUMBER: nobody can, nothing to detect. */
  numberMode: NumberMode;
}

export type TenantResolution =
  | { ok: true; tenant: ResolvedWhatsAppTenant }
  | { ok: false; reason: string };

/**
 * Same lookup as `resolveTenantByPhoneNumberId`, but says WHY there is no clinic. The webhook logs that
 * reason: "no bookable clinic" alone cannot tell a number nobody owns from a suspended clinic, a paused
 * bot, a missing AI_AGENT or a connection that is not ACTIVE.
 */
export async function resolveTenantWithReason(phoneNumberId: string): Promise<TenantResolution> {
  const tenant = await prisma.tenant.findFirst({
    where: { whatsappPhoneNumberId: phoneNumberId },
    select: { id: true, timezone: true, whatsappPhoneNumberId: true, name: true, nameEn: true, botPaused: true, status: true, suspensionReason: true },
  });
  if (tenant === null || tenant.whatsappPhoneNumberId === null) {
    return { ok: false, reason: "NO_CLINIC_OWNS_THIS_NUMBER (no tenants row has this whatsapp_phone_number_id)" };
  }
  const who = `tenant ${tenant.id}`;
  if (tenant.status !== "ACTIVE") {
    return { ok: false, reason: `CLINIC_NOT_ACTIVE (${who}, status ${tenant.status}, suspension_reason ${tenant.suspensionReason ?? "none"})` };
  }
  if (tenant.botPaused && !isSubscriptionExempt(tenant.whatsappPhoneNumberId)) {
    return { ok: false, reason: `BOT_PAUSED_NO_RUNNING_SUBSCRIPTION (${who}, bot_paused = true)` };
  }

  const bot = await resolveBotActor(tenant.id);
  if (bot === null) return { ok: false, reason: `NO_ACTIVE_AI_AGENT_MEMBERSHIP (${who})` };

  const access = await resolveWhatsAppAccess(tenant.id, tenant.whatsappPhoneNumberId);
  if (access === null) {
    return { ok: false, reason: `NO_ACTIVE_WHATSAPP_CONNECTION (${who}; connection status is not ACTIVE, belongs to another tenant, or there is no connection row and no .env fallback)` };
  }

  const support = await withTenant(tenant.id, await systemActor(), (tx) => resolveHumanSupport(tx, tenant.id));

  return {
    ok: true,
    tenant: {
      id: tenant.id,
      timezone: tenant.timezone,
      clinicName: tenant.name,
      clinicNameEn: tenant.nameEn,
      phoneNumberId: tenant.whatsappPhoneNumberId,
      bot,
      humanSupportPhone: support?.phoneE164 ?? null,
      accessToken: access.accessToken,
      client: access.client,
      numberMode: access.numberMode,
    },
  };
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
  const resolution = await resolveTenantWithReason(phoneNumberId);
  return resolution.ok ? resolution.tenant : null;
}
