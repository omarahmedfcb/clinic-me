// One inbound WhatsApp message in, a reply sent back out. Routing itself is entirely the step
// machine's job now (whatsapp-flow.ts) -- this file's job is the plumbing around it: persistence
// (whatsapp-conversation.ts), which graph-API call a given FlowOutgoing needs
// (whatsapp-graph-client.ts), and turning anything that throws into the bilingual "something went
// wrong" reply rather than leaving the patient with silence.
//
// There is no more a separate "free chat" mode this falls back to: booking and filing a complaint
// used to be GPT calling functions (WHATSAPP_TOOLS, removed with this change, along with
// whatsapp-tools.ts) -- now every fact in either comes from a tool result the *flow* fetched or the
// patient's own tap, never from the model choosing to call something. The model's only two jobs
// left are inside the flow itself: guessing intent from a vague opener, and answering an
// off-script question without derailing the step the patient is on (see whatsapp-flow.ts's header).

import { getDefaultBotApiClient } from "./bot-api-client.ts";
import { clearAiChain, ingestInboundMessage, recordOutboundMessage } from "./whatsapp-conversation.ts";
import { sendWhatsAppButtons, sendWhatsAppList, sendWhatsAppText } from "./whatsapp-graph-client.ts";
import { runFlow, WELCOME_IDLE_GAP_MS, type FlowOutgoing, type FlowState } from "./whatsapp-flow.ts";
import type { WhatsAppTenant } from "./whatsapp-tenants.ts";

const FALLBACK_REPLY =
  "معذرة، حدث خطأ أثناء إتمام طلبك. من فضلك حاول مرة أخرى.\n" +
  "Sorry, something went wrong on our side. Please try again.";

/** What arrived: free text, or a tapped button/list-row id -- whatsapp.controller.ts tells them
 *  apart and never joins the two. whatsapp-flow.ts's step machine is what reads `id`; it is never
 *  shown to the model (that was Part 1's fix for the WhatsApp token bug, and the same reasoning
 *  applies to every other opaque id a step hands out). */
export type InboundWhatsAppInput = { kind: "text"; text: string } | { kind: "interactive"; id: string };

export interface InboundWhatsAppMessage {
  tenant: WhatsAppTenant;
  waId: string;
  phoneE164: string;
  externalMessageId: string;
  input: InboundWhatsAppInput;
  occurredAt: Date;
}

/** A `FlowOutgoing` is graph-API-shaped already (whatsapp-flow.ts builds it directly against
 *  whatsapp-graph-client.ts's own types) -- this is purely "which of the three send functions",
 *  plus the flat text this turn's `Message` row is logged with regardless of which one fired. */
async function sendFlowOutgoing(
  tenant: WhatsAppTenant,
  waId: string,
  outgoing: FlowOutgoing,
): Promise<{ externalMessageId: string; loggedText: string }> {
  if (outgoing.kind === "text") {
    const sent = await sendWhatsAppText(tenant.phoneNumberId, waId, outgoing.text);
    return { externalMessageId: sent.externalMessageId, loggedText: outgoing.text };
  }
  if (outgoing.kind === "buttons") {
    const sent = await sendWhatsAppButtons(tenant.phoneNumberId, waId, outgoing.body, outgoing.buttons);
    const optionsLine = outgoing.buttons.map((b) => b.title).join(" / ");
    return { externalMessageId: sent.externalMessageId, loggedText: `${outgoing.body}\n[${optionsLine}]` };
  }
  const sent = await sendWhatsAppList(tenant.phoneNumberId, waId, outgoing.body, outgoing.buttonLabel, outgoing.sections);
  const optionsLine = outgoing.sections.flatMap((section) => section.rows.map((row) => row.title)).join(" / ");
  return { externalMessageId: sent.externalMessageId, loggedText: `${outgoing.body}\n[${optionsLine}]` };
}

/**
 * The whole pipeline for one inbound message (or one tapped button/list row): persist it, run the
 * step machine, send whatever it produced, persist that too. Errors are caught and turned into the
 * bilingual fallback reply rather than thrown -- the webhook has already returned `200` to Meta by
 * the time this runs (whatsapp.controller.ts never awaits it), so there is nobody left to hand an
 * exception to.
 */
export async function handleInboundWhatsAppMessage(input: InboundWhatsAppMessage): Promise<void> {
  const { tenant } = input;
  const messageText = input.input.kind === "text" ? input.input.text : "";

  let ingest;
  try {
    ingest = await ingestInboundMessage(tenant.id, tenant.bot, {
      waId: input.waId,
      phoneE164: input.phoneE164,
      externalMessageId: input.externalMessageId,
      text: messageText,
      occurredAt: input.occurredAt,
      idleGapMs: WELCOME_IDLE_GAP_MS,
    });
  } catch (error) {
    console.error("WhatsApp: failed to ingest inbound message", error);
    return;
  }

  if (ingest.alreadyProcessed) return;

  let outgoing: FlowOutgoing;
  let nextState: FlowState | null;
  try {
    const result = await runFlow({
      tenant,
      client: getDefaultBotApiClient(),
      phoneE164: input.phoneE164,
      input: input.input,
      state: ingest.flowState as FlowState | null,
      isNewSession: ingest.isNewSession,
      inboundExternalMessageId: input.externalMessageId,
    });

    if (!result.handled) {
      // Nothing left to interpret a stale interactive tap against (whatsapp-flow.ts's own note on
      // when this happens) -- the chain, if any, is stale too; clear it and fall back to the plain
      // apology rather than guessing at what the tap meant.
      await clearAiChain(tenant.id, tenant.bot, ingest.conversationId).catch(() => undefined);
      outgoing = { kind: "text", text: FALLBACK_REPLY };
      nextState = null;
    } else {
      outgoing = result.outgoing ?? { kind: "text", text: FALLBACK_REPLY };
      nextState = result.nextState ?? null;
    }
  } catch (error) {
    console.error("WhatsApp: step machine failed", error);
    outgoing = { kind: "text", text: FALLBACK_REPLY };
    nextState = null;
  }

  try {
    const sent = await sendFlowOutgoing(tenant, input.waId, outgoing);
    await recordOutboundMessage(tenant.id, tenant.bot, {
      conversationId: ingest.conversationId,
      contactId: ingest.contactId,
      externalMessageId: sent.externalMessageId,
      text: sent.loggedText,
      flowState: nextState,
      now: new Date(),
    });
  } catch (error) {
    // The reply failed to send, or failed to log -- either way there is nothing left to retry
    // synchronously (Meta already has our 200 for the inbound message this was replying to).
    // Surfacing it here rather than swallowing it silently is what makes it visible in the same
    // place every other unattended-job failure in this codebase is expected to show up: the logs.
    console.error("WhatsApp: failed to send or record reply", error);
  }
}
