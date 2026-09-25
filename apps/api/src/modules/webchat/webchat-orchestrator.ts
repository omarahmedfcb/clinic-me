// One user message in, tool calls executed against the real service layer, and the model's final
// reply out. ARCHITECTURE.md §12: the model never touches a database, only what the tools in
// webchat-tools.ts return, and it is instructed never to state a fact that did not come from one.
//
// No conversation array here, unlike the Groq version this replaced -- previous_response_id
// (gpt-client.ts) means each call only ever sends what's new: the patient's message, or the
// results of the tools the last round asked for. session.previousResponseId is the only thing
// carried between messages.

import { callGpt, type GptInputItem } from "./gpt-client.ts";
import { webchatSessions } from "./webchat-session.ts";
import { executeWebchatTool, WEBCHAT_TOOLS } from "./webchat-tools.ts";

/** One user turn can trigger several tool round-trips (list, then select, then list again); this
 *  bounds a runaway loop rather than letting one message spend an unbounded number of OpenAI calls. */
const MAX_TOOL_ROUNDS = 6;

const FALLBACK_REPLY =
  "معذرة، حدث خطأ أثناء إتمام طلبك. من فضلك حاول مرة أخرى.\n" +
  "Sorry, something went wrong on our side. Please try again.";

const SYSTEM_PROMPT = `You are the appointment-booking assistant for Clinic OS, reached from a public web page with no \
login, for clinics in Egypt. You speak Arabic (Egyptian or MSA) or English, matching whichever the patient uses, \
and can switch mid-conversation if they do.

Follow this order, settling each step before moving to the next:
1. Call list_clinics and ask the patient which clinic they want to book with. Once they answer, call select_clinic \
with the exact id from the list -- never guess or invent one.
2. Ask for the patient's full name and phone number, then call find_or_create_patient.
   - If it returns status "found_many", read out the names it lists and ask which one this booking is for, then \
call select_patient with that exact patientId.
   - Otherwise the patient is already chosen for you; do not call select_patient in that case.
3. Call list_doctors and ask which doctor they'd like to see. Then call list_services: if it returns exactly one \
service, use it silently without asking; if more than one, ask which the visit is for.
4. Ask what date they'd like. The patient may answer in any form -- a written date, a relative one ("tomorrow", \
"بكرة"), or day-month-year -- convert whatever they say into YYYY-MM-DD or DD-MM-YYYY yourself before calling \
list_slots; do not make the patient repeat themselves into one exact format. If list_slots returns DATE_IN_PAST, \
that date has already passed -- say so plainly and ask for a different one.
5. Read out the times list_slots returns and ask the patient to pick one -- never state a time it did not return. \
If it returns no times at all for that date, say so and offer to check a different date.
6. Once they pick a time, restate the clinic, doctor, date and time and patient name back to them, and ask for an \
explicit yes before booking anything.
7. Only after they say yes, call book_appointment with that slot's token. Report the outcome plainly. If it fails \
because the slot was just taken by someone else, apologise and call list_slots again for fresh times on that date.

Rules:
- Never state a fact -- a clinic, a doctor, an available time, or that a booking succeeded -- unless it came from a \
tool result earlier in this conversation.
- This chat only books appointments. Do not answer medical questions, comment on symptoms, or give medical advice \
of any kind, even reassurance -- say the doctor will address that at the visit, and continue with the booking.
- Ask one question at a time, and keep messages short.
- Ids (clinicId, doctorId, serviceId, patientId, slotToken, and similar) are for calling tools only -- never read
  one aloud or show it to the patient. When listing options, refer to them by name, or by a number you assign
  yourself for the patient to reply with, never by id.`;

export interface WebchatReply {
  sessionId: string;
  reply: string;
}

export async function handleWebchatMessage(sessionId: string | undefined, userMessage: string): Promise<WebchatReply> {
  const session = (sessionId && webchatSessions.get(sessionId)) || webchatSessions.create();

  let input: GptInputItem[] = [{ role: "user", content: userMessage }];
  let reply = FALLBACK_REPLY;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    let completion;
    try {
      completion = await callGpt({
        input,
        tools: WEBCHAT_TOOLS,
        instructions: SYSTEM_PROMPT,
        previousResponseId: session.previousResponseId,
      });
    } catch (error) {
      console.error("OpenAI call failed", error);
      reply =
        "الخدمة مشغولة لحظة، من فضلك أعد المحاولة بعد قليل.\nThe service is busy right now, please try again in a moment.";
      webchatSessions.save(session);
      return { sessionId: session.id, reply };
    }

    // Chain from here regardless of what this round contained, so the *next* message (whether it's
    // the patient's next turn or this loop's next tool round) continues from it.
    session.previousResponseId = completion.id;

    if (completion.toolCalls.length === 0) {
      // A reasoning model can spend its whole budget thinking and still return nothing to say --
      // treated as a transient failure, not shown to the patient as an empty message.
      reply = completion.outputText?.trim() ? completion.outputText : FALLBACK_REPLY;
      break;
    }

    input = [];
    for (const call of completion.toolCalls) {
      const result = await executeWebchatTool(session, call.name, call.arguments);
      input.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify(result) });
    }
  }

  webchatSessions.save(session);
  return { sessionId: session.id, reply };
}
