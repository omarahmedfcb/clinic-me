import { Module } from "@nestjs/common";
import { WhatsAppWebhookController } from "./whatsapp.controller.ts";
import { WhatsAppSignupController } from "./whatsapp-signup.controller.ts";

/**
 * No throttler here, unlike bot.module.ts / webchat.module.ts. Meta's webhook has to accept every
 * delivery it sends and cannot be told "come back later" the way a browser or a bot's own client
 * can (§7's back-off-per-Retry-After story is for the outbound webhook contract, not this inbound
 * one) -- the spam control that matters is whatsapp-throttle.ts's per-sender limit, applied after
 * signature verification and before a message reaches GPT, not a 429 on the route itself.
 */
@Module({ controllers: [WhatsAppWebhookController, WhatsAppSignupController] })
export class WhatsAppModule { }
