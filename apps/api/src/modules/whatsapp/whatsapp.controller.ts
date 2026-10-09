// Meta calling us. The other direction (us calling Meta to send a reply) is
// whatsapp-graph-client.ts; the direction that calls our own /bot/* endpoints as an HTTP client is
// bot-api-client.ts. This controller's whole job is: verify it is really Meta, ACK fast, and hand
// each text message to the pipeline in whatsapp-orchestrator.ts without making Meta wait for it.
//
// No `AuthGuard`, no `TenantGuard`, no DTO -- by construction, the same way webchat.controller.ts
// has none, and for a related reason: Meta is not a signed-in caller and this project does not
// control the shape of what it sends. Trust comes entirely from `verifyMetaSignature` below, not
// from anything `class-validator` could check.

import type { Request, Response } from "express";
import { Controller, Get, Post, Query, Req, Res } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { MetaInboundMessage, MetaWebhookPayload } from "./meta-webhook-payload.ts";
import { handleVerificationHandshake, verifyMetaSignature, META_SIGNATURE_HEADER } from "./whatsapp-signing.ts";
import { checkSpamLimit, debounceMessage, SPAM_LIMIT_REPLY } from "./whatsapp-throttle.ts";
import { sendWhatsAppText } from "./whatsapp-graph-client.ts";
import { ResolvedWhatsAppTenant, resolveTenantByPhoneNumberId, type WhatsAppTenant } from "./whatsapp-tenants.ts";
import { handleInboundWhatsAppMessage } from "./whatsapp-orchestrator.ts";
import { handleStaffEchoes } from "./whatsapp-handoff.ts";
import { setConnectionStatus, tenantsByWaba } from "./whatsapp-connections.ts";

@Controller("webhooks/whatsapp")
export class WhatsAppWebhookController {
  /**
   * Meta's one-time subscription check, run once when the webhook URL is registered in the Meta
   * dashboard (and again any time the subscription is re-verified). `WHATSAPP_VERIFY_TOKEN` is a
   * value chosen when registering it there -- unrelated to `WHATSAPP_APP_SECRET`, which signs the
   * actual message deliveries below.
   */
  @Get()
  verify(@Query() query: Record<string, unknown>, @Res() res: Response): void {
    const verifyToken = process.env["WHATSAPP_VERIFY_TOKEN"];
    if (!verifyToken) {
      res.status(500).send("WHATSAPP_VERIFY_TOKEN is not set.");
      return;
    }

    const challenge = handleVerificationHandshake(verifyToken, query);
    if (challenge === null) {
      res.status(403).send("Forbidden");
      return;
    }
    res.status(200).type("text/plain").send(challenge);
  }

  /**
   * The actual deliveries. Signature-verified against the **raw** body (`request.rawBody`, enabled
   * in `main.ts`'s `NestFactory.create` call) before anything in it is trusted, then acknowledged
   * with a bare `200` immediately -- Meta redelivers aggressively on anything slower or non-2xx, and
   * a redelivery of a message we already logged is exactly what `ingestInboundMessage`'s
   * `externalMessageId` uniqueness check exists to shrug off. Everything after the `res.send()` is
   * deliberately not awaited before it: this handler must not make Meta wait on OpenAI.
   */
  @Post()
  receive(@Req() request: RawBodyRequest<Request>, @Res() res: Response): void {
    const appSecret = process.env["WHATSAPP_APP_SECRET"];
    const signatureHeader = request.header(META_SIGNATURE_HEADER);

    if (!appSecret || !request.rawBody || !verifyMetaSignature(appSecret, request.rawBody, signatureHeader)) {
      res.status(401).send();
      return;
    }

    res.status(200).send();

    this.process(request.body as MetaWebhookPayload).catch((error: unknown) => {
      console.error("WhatsApp: webhook processing failed", error);
    });
  }

  private async process(payload: MetaWebhookPayload): Promise<void> {
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value;

        // Coexistence adds four webhook fields next to `messages`. None of them is a patient writing.
        if (change.field === "smb_message_echoes") {
          await handleStaffEchoes(value?.metadata?.phone_number_id ?? "", value?.message_echoes ?? []);
          continue;
        }
        if (change.field === "history" || change.field === "smb_app_state_sync") {
          this.acknowledgeSync(change.field, value?.history);
          continue;
        }
        if (change.field === "account_update") {
          await this.handleAccountUpdate(entry.id ?? value?.waba_info?.waba_id, value?.event);
          continue;
        }

        const phoneNumberId = value?.metadata?.phone_number_id;
        const messages = value?.messages;
        // Absent or empty `messages` is a delivery-status callback (sent/delivered/read/failed for
        // something *we* sent), not a patient's message -- nothing for this pipeline to do with it.
        if (!phoneNumberId || !messages || messages.length === 0) continue;

        const tenant = await resolveTenantByPhoneNumberId(phoneNumberId);
        if (!tenant) {
          console.warn(`WhatsApp: no bookable clinic for phone_number_id ${phoneNumberId}`);
          continue;
        }

        for (const message of messages) {
          await this.handleOneMessage(tenant, message);
        }
      }
    }
  }

  /**
 * Contacts and chat history, pushed by Meta after a coexistence onboarding. We asked for them only
 * because Meta requires it (whatsapp-coexistence.ts); the data is dropped on purpose. A clinic
 * that declines to share history gets error 2593109, which is an answer, not a fault.
 */
  private acknowledgeSync(field: string, history: Array<{ metadata?: { progress?: number }; errors?: Array<{ code?: number }> }> | undefined): void {
    for (const chunk of history ?? []) {
      if (chunk.errors?.some((error) => error.code === 2593109)) {
        console.info("WhatsApp coexistence: the clinic chose not to share chat history");
      } else if (chunk.metadata?.progress === 100) {
        console.info(`WhatsApp coexistence: ${field} sync finished (not stored)`);
      }
    }
  }

  /**
   * Meta telling us the clinic removed our app, or the number was offboarded -- for coexistence that
   * includes the Business app phone going unused for about 14 days. The bot can no longer send, so
   * the connection is flagged and the owner sees a reconnect banner instead of a bot that went quiet.
   */
  private async handleAccountUpdate(wabaId: string | undefined, event: string | undefined): Promise<void> {
    if (!wabaId || (event !== "PARTNER_REMOVED" && event !== "ACCOUNT_OFFBOARDED")) return;
    for (const connection of await tenantsByWaba(wabaId)) {
      await setConnectionStatus(connection.tenantId, "DISCONNECTED", event);
    }
  }



  private async handleOneMessage(tenant: ResolvedWhatsAppTenant, message: MetaInboundMessage): Promise<void> {
    // Text and tapped interactive replies (buttons, list rows) are acted on; anything else (image,
    // location, and so on) is not, same as before.
    if (!message.from || !message.id) return;

    const waId = message.from;
    const phoneE164 = `+${waId}`;
    const externalMessageId = message.id;
    const occurredAt = message.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();

    const spam = checkSpamLimit(waId);
    if (!spam.allowed) {
      if (spam.shouldWarn) {
        await sendWhatsAppText(tenant.phoneNumberId, waId, SPAM_LIMIT_REPLY, tenant.accessToken).catch((error: unknown) => {
          console.error("WhatsApp: failed to send the slow-down reply", error);
        });
      }
      return;
    }

    if (message.type === "interactive") {
      // A tapped button or list row is one discrete, already-unambiguous action -- unlike free
      // text, it is never debounced or joined with anything else: joining "s3" with whatever the
      // patient types next would corrupt both. Its `id` is whatever whatsapp-flow.ts minted for
      // that button; the flow step handler is what makes sense of it, not the model.
      const id = message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id;
      if (id === undefined) return;

      handleInboundWhatsAppMessage({
        tenant,
        waId,
        phoneE164,
        externalMessageId,
        input: { kind: "interactive", id },
        occurredAt,
      }).catch((error: unknown) => {
        console.error("WhatsApp: failed to handle inbound interactive reply", error);
      });
      return;
    }

    if (message.type !== "text" || !message.text?.body) return;

    // Coalesces a burst into one turn. `externalMessageId` here ends up being whichever message in
    // the burst settles the debounce last -- a known, accepted simplification of exactly-once
    // logging across a *debounced batch* (webchat-prototype.md: "start simple"); each individual
    // delivery is still deduplicated correctly on its own via the same check.
    debounceMessage(waId, message.text.body, (combinedText) => {
      handleInboundWhatsAppMessage({
        tenant,
        waId,
        phoneE164,
        externalMessageId,
        input: { kind: "text", text: combinedText },
        occurredAt,
      }).catch((error: unknown) => {
        console.error("WhatsApp: failed to handle inbound message", error);
      });
    });
  }
}
