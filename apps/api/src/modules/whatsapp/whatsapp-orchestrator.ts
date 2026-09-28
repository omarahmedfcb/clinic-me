// One inbound WhatsApp message in, a reply sent back out. The GPT loop itself is
// webchat-orchestrator.ts's, unchanged in shape: same Responses-API chaining (gpt-client.ts), same
// bounded tool-round loop, same fallback reply -- what differs is what surrounds it, since a
// WhatsApp turn has no HTTP response to hand a reply back on. It has to send one itself, and it has
// to persist what a web-chat session was allowed to keep only in memory (webchat-session.ts's own
// header explains why that was an acceptable prototype shortcut and why WhatsApp cannot repeat it).

import { callGpt, type GptInputItem } from "../webchat/gpt-client.ts";
import { getDefaultBotApiClient } from "./bot-api-client.ts";
import { clearAiChain, ingestInboundMessage, recordOutboundMessage } from "./whatsapp-conversation.ts";
import { sendWhatsAppText } from "./whatsapp-graph-client.ts";
import type { WhatsAppTenant } from "./whatsapp-tenants.ts";
import { executeWhatsAppTool, START_NEW_BOOKING_TOOL, WHATSAPP_TOOLS, WHATSAPP_TOOLS_AFTER_RESET, type WhatsAppToolContext } from "./whatsapp-tools.ts";

const MAX_TOOL_ROUNDS = 6;

const FALLBACK_REPLY =
  "معذرة، حدث خطأ أثناء إتمام طلبك. من فضلك حاول مرة أخرى.\n" +
  "Sorry, something went wrong on our side. Please try again.";

const BUSY_REPLY =
  "الخدمة مشغولة لحظة، من فضلك أعد المحاولة بعد قليل.\n" +
  "The service is busy right now, please try again in a moment.";

const SYSTEM_PROMPT = `You are the appointment-booking assistant for this clinic, reached over its WhatsApp number. You \
speak Arabic (Egyptian or MSA) or English, matching whichever the patient uses, and can switch mid-conversation if \
they do. The clinic is already known from the number the patient messaged -- never ask which clinic they want.

Follow this order, settling each step before moving to the next:
1. If you do not already know the patient's full name and phone number from earlier in this conversation, ask for \
them, then call find_or_create_patient.
   - If it returns status "found_many", read out the names it lists and ask which one this booking is for. Use that \
patient's exact id as patientId in every later tool call in this conversation -- never invent one.
   - Otherwise the returned patient is the one to use.
2. Call list_doctors and ask which doctor they'd like to see. Then call list_services: if it returns exactly one \
service, use it silently without asking; if more than one, ask which the visit is for.
3. Ask what date they'd like. The patient may answer in any form -- a written date, a relative one ("tomorrow", \
"بكرة"), or day-month-year -- convert whatever they say into YYYY-MM-DD or DD-MM-YYYY yourself before calling \
list_slots; do not make the patient repeat themselves into one exact format. If list_slots returns DATE_IN_PAST, \
that date has already passed -- say so plainly and ask for a different one.
4. Read out the times list_slots returns and ask the patient to pick one -- never state a time it did not return. \
If it returns no times at all for that date, say so and offer to check a different date.
5. Once they pick a time, restate the doctor, date and time and patient name back to them, and ask for an explicit \
yes before booking anything.
6. Only after they say yes, call book_appointment with that patient's id and the slot's token. Report the outcome \
plainly. If it fails because the slot was just taken by someone else, apologise and call list_slots again for \
fresh times on that date.

Rules:
- Never state a fact -- a doctor, an available time, or that a booking succeeded -- unless it came from a tool \
result earlier in this conversation.
- This chat only books appointments. Do not answer medical questions, comment on symptoms, or give medical advice \
of any kind, even reassurance -- say the doctor will address that at the visit, and continue with the booking.
- Ask one question at a time, and keep messages short -- this is a WhatsApp chat, not an email.
- Ids (patientId, doctorId, serviceId, slotToken, and similar) are for calling tools only -- never read one aloud \
or show it to the patient. When listing options, refer to them by name, or by a number you assign yourself for \
the patient to reply with, never by id.
- If the patient says at any point that they want to start over, drop what they were doing, or book a new \
or another appointment -- even in the middle of a booking, or right after one -- call start_new_booking \
straight away without asking. Do not try to continue the old booking.
- This chat only books appointments.`;

export interface InboundWhatsAppMessage {
  tenant: WhatsAppTenant;
  waId: string;
  phoneE164: string;
  externalMessageId: string;
  text: string;
  occurredAt: Date;
}

/**
 * The whole pipeline for one already-debounced batch of text from one sender: persist it, run the
 * model, send a reply, persist that too. Errors are caught and turned into the bilingual "busy"
 * reply rather than thrown -- the webhook has already returned `200` to Meta by the time this runs
 * (whatsapp.controller.ts never awaits it), so there is nobody left to hand an exception to.
 */
export async function handleInboundWhatsAppMessage(input: InboundWhatsAppMessage): Promise<void> {
  const { tenant } = input;

  let ingest;
  try {
    ingest = await ingestInboundMessage(tenant.id, tenant.bot, {
      waId: input.waId,
      phoneE164: input.phoneE164,
      externalMessageId: input.externalMessageId,
      text: input.text,
      occurredAt: input.occurredAt,
    });
  } catch (error) {
    console.error("WhatsApp: failed to ingest inbound message", error);
    return;
  }

  if (ingest.alreadyProcessed) return;

  const toolContext: WhatsAppToolContext = {
    client: getDefaultBotApiClient(),
    timezone: tenant.timezone,
    inboundExternalMessageId: input.externalMessageId,
  };

  let gptInput: GptInputItem[] = [{ role: "user", content: input.text }];
  let reply = FALLBACK_REPLY;
  let responseId: string | undefined = ingest.lastAiResponseId ?? undefined;
  let gptFailed = false;
  let resetDone = false;

  for (let round = 0; round < MAX_TOOL_ROUNDS && !gptFailed; round++) {
    let completion;
    try {
      completion = await callGpt({
        input: gptInput,
        tools: resetDone ? WHATSAPP_TOOLS_AFTER_RESET : WHATSAPP_TOOLS,
        instructions: SYSTEM_PROMPT,
        previousResponseId: responseId,
      });
    } catch (error) {
      console.error("WhatsApp: OpenAI call failed", error);
      reply = BUSY_REPLY;
      gptFailed = true;
      break;
    }

    responseId = completion.id;

    if (completion.toolCalls.length === 0) {
      reply = completion.outputText?.trim() ? completion.outputText : FALLBACK_REPLY;
      break;
    }

    // The patient asked to start over: drop the whole chain, not just the last turn, and run the
    // same message again on a fresh one. Any other tool calls in this response are ignored.
    if (!resetDone && completion.toolCalls.some((call) => call.name === START_NEW_BOOKING_TOOL)) {
      resetDone = true;
      responseId = undefined;
      gptInput = [{ role: "user", content: input.text }];
      await clearAiChain(tenant.id, tenant.bot, ingest.conversationId).catch((error: unknown) => {
        console.error("WhatsApp: failed to clear the AI chain", error);
      });
      continue;
    }

    gptInput = [];
    for (const call of completion.toolCalls) {
      let result: unknown;
      try {
        result = await executeWhatsAppTool(toolContext, call.name, call.arguments);
      } catch (error) {
        console.error(`WhatsApp: tool "${call.name}" threw`, error);
        result = { ok: false, reason: "INTERNAL_ERROR" };
      }
      gptInput.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) });
    }
  }

  try {
    const sent = await sendWhatsAppText(tenant.phoneNumberId, input.waId, reply);
    await recordOutboundMessage(tenant.id, tenant.bot, {
      conversationId: ingest.conversationId,
      contactId: ingest.contactId,
      externalMessageId: sent.externalMessageId,
      text: reply,
      // Only carried forward if this turn actually reached OpenAI -- see recordOutboundMessage's
      // own note on why a failed turn must not overwrite a real chain pointer with nothing.
      aiResponseId: gptFailed ? undefined : responseId,
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
