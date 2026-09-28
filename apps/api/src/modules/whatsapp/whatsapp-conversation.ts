// The platform's own record of a WhatsApp conversation -- Contact, Conversation, Message
// (WHATSAPP-BOT-CONTRACT.md §4/§6's schema). This is infrastructure, not a bot capability: nothing
// in docs/WHATSAPP-BOT-CONTRACT.md §3 logs a message, so this runs in-process under `withTenant`,
// the same way `webchat-clinics.ts` resolves a clinic in-process -- it is connecting identity and
// writing an audit trail, not one of the ten things the bot is allowed to do.
//
// Kept out of any transaction that also waits on OpenAI or Meta's Graph API: three short,
// independent `withTenant` calls (ingest inbound, send, record outbound) rather than one long one
// holding a pooled connection open across two slow HTTP round trips.

import { uuidv7 } from "uuidv7";
import { injected } from "../../prisma/injected.ts";
import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import type { BotActor } from "../webchat/webchat-clinics.ts";

export function botActorContext(bot: BotActor): ActorContext {
  return { userId: bot.userId, ip: "whatsapp", userAgent: "clinic-os-whatsapp-bot" };
}

/** `messages.body_preview` is capped at 280 characters and commented "never clinical content" --
 *  enforced here too, not just at the database, so a truncation bug is a visible slice, not a
 *  silent Postgres error on a row nobody expected to be rejected. */
function bodyPreview(text: string): string {
  return text.slice(0, 280);
}

export interface IngestResult {
  conversationId: string;
  contactId: string;
  /** Chained from here (gpt-client.ts's `previous_response_id`) if this conversation has one already. */
  lastAiResponseId: string | null;
  /** `true` if a row with this `externalMessageId` already existed -- Meta's own retry/redelivery
   *  behaviour, closed by the same `@@unique([tenantId, externalMessageId])` constraint the outbound
   *  side already relies on for idempotency. The caller must not run this message through the bot
   *  a second time. */
  alreadyProcessed: boolean;
}

/**
 * Resolves (or creates) the contact and the open conversation, and logs the inbound message --
 * one transaction, database-only. Returns what the orchestrator needs to continue: which
 * conversation this is, and whether OpenAI has a turn to chain from.
 */
export async function ingestInboundMessage(
  tenantId: string,
  bot: BotActor,
  input: { waId: string; phoneE164: string; externalMessageId: string; text: string; occurredAt: Date },
): Promise<IngestResult> {
  const actor = botActorContext(bot);

  return withTenant(tenantId, actor, async (tx) => {
    const existing = await tx.message.findFirst({
      where: { externalMessageId: input.externalMessageId },
      select: { conversationId: true, contactId: true },
    });
    if (existing !== null) {
      const conversation = await tx.conversation.findFirst({
        where: { id: existing.conversationId },
        select: { lastAiResponseId: true },
      });
      return {
        conversationId: existing.conversationId,
        contactId: existing.contactId,
        lastAiResponseId: conversation?.lastAiResponseId ?? null,
        alreadyProcessed: true,
      };
    }

    const contact =
      (await tx.contact.findFirst({ where: { phoneE164: input.phoneE164 }, select: { id: true } })) ??
      (await tx.contact.create({
        data: injected({ id: uuidv7(), phoneE164: input.phoneE164, whatsappOptIn: true }),
        select: { id: true },
      }));

    const conversation =
      (await tx.conversation.findFirst({
        where: { contactId: contact.id, status: "OPEN" },
        select: { id: true, lastAiResponseId: true },
      })) ??
      (await tx.conversation.create({
        data: injected({
          id: uuidv7(),
          contactId: contact.id,
          channel: "whatsapp",
          // Meta hands us no stable thread id on an inbound message -- only the sender's wa_id,
          // which is what identifies "this ongoing conversation" for as long as it stays OPEN.
          externalConversationId: input.waId,
          status: "OPEN",
          openedAt: input.occurredAt,
        }),
        select: { id: true, lastAiResponseId: true },
      }));

    await tx.message.create({
      data: injected({
        id: uuidv7(),
        conversationId: conversation.id,
        contactId: contact.id,
        direction: "INBOUND",
        messageType: "TEXT",
        externalMessageId: input.externalMessageId,
        bodyPreview: bodyPreview(input.text),
        // Received, not delivered-by-us -- the closest fit in an enum built for tracking our own
        // outbound sends (QUEUED/SENT/DELIVERED/READ/FAILED). Worth a dedicated inbound status if
        // this distinction ever needs to be queried on, rather than guessed at read time.
        status: "DELIVERED",
        // Meta does not bill an inbound message on its own -- billing attaches to the conversation
        // window a reply opens or extends. SERVICE/false is the correct default until this project
        // sends business-initiated templates, at which point the outbound side (below) is where a
        // real category needs to be threaded through, not this row.
        billable: false,
        billingCategory: "SERVICE",
        sentAt: input.occurredAt,
      }),
    });

    return {
      conversationId: conversation.id,
      contactId: contact.id,
      lastAiResponseId: conversation.lastAiResponseId,
      alreadyProcessed: false,
    };
  });
}

/**
 * Logs the reply we sent, and chains the conversation from the new OpenAI response.
 *
 * `aiResponseId` is optional: if OpenAI never answered this turn (a network failure, caught by the
 * orchestrator and turned into the bilingual "busy" reply), there is nothing new to chain from, and
 * `lastAiResponseId` is left exactly as `ingestInboundMessage` found it rather than being overwritten
 * with nothing -- the next message should still resume from the last turn that really happened.
 */
export async function recordOutboundMessage(
  tenantId: string,
  bot: BotActor,
  input: {
    conversationId: string;
    contactId: string;
    externalMessageId: string;
    text: string;
    aiResponseId?: string;
    now: Date;
  },
): Promise<void> {
  const actor = botActorContext(bot);

  await withTenant(tenantId, actor, async (tx) => {
    await tx.message.create({
      data: injected({
        id: uuidv7(),
        conversationId: input.conversationId,
        contactId: input.contactId,
        direction: "OUTBOUND",
        messageType: "TEXT",
        externalMessageId: input.externalMessageId,
        bodyPreview: bodyPreview(input.text),
        status: "SENT",
        billable: false,
        billingCategory: "SERVICE",
        sentAt: input.now,
      }),
    });

    if (input.aiResponseId !== undefined) {
      await tx.conversation.update({
        where: { id: input.conversationId },
        data: { lastAiResponseId: input.aiResponseId },
      });
    }
  });
}

/**
 * Forgets the OpenAI chain for a conversation, so the next turn starts with no memory of the
 * last one. The Conversation row and its Message log are untouched.
 */
export async function clearAiChain(tenantId: string, bot: BotActor, conversationId: string): Promise<void> {
  await withTenant(tenantId, botActorContext(bot), async (tx) => {
    await tx.conversation.update({
      where: { id: conversationId },
      data: { lastAiResponseId: null },
    });
  });
}