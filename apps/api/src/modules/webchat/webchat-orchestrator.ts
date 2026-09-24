// One user message in, tool calls executed against the real service layer, and the model's final
// reply out. ARCHITECTURE.md §12: the model never touches a database, only what the tools in
// webchat-tools.ts return, and it is instructed never to state a fact that did not come from one.

import { callGroq } from "./groq-client.ts";
import { webchatSessions } from "./webchat-session.ts";
import { executeWebchatTool, WEBCHAT_TOOLS } from "./webchat-tools.ts";

/** One user turn can trigger several tool round-trips (list, then select, then list again); this
 *  bounds a runaway loop rather than letting one message spend an unbounded number of Groq calls. */
const MAX_TOOL_ROUNDS = 6;

const FALLBACK_REPLY =
  "معذرة، حدث خطأ أثناء إتمام طلبك. من فضلك حاول مرة أخرى.\n" +
  "Sorry, something went wrong on our side. Please try again.";

const SYSTEM_PROMPT = `You are the appointment-booking assistant for Clinic OS, reached from a public web page with no \
login. You speak Arabic (Egyptian or MSA) or English, matching whichever the patient uses, and can switch mid-\
conversation if they do.

Follow this order, settling each step before moving to the next:
1. Call list_clinics and ask the patient which clinic they want to book with. Once they answer, call select_clinic \
with the exact id from the list -- never guess or invent one.
2. Ask for the patient's full name and phone number, then call find_or_create_patient.
   - If it returns status "found_many", read out the names it lists and ask which one this booking is for, then \
call select_patient with that exact patientId.
   - Otherwise the patient is already chosen for you; do not call select_patient in that case.
3. Call list_doctors and ask which doctor they'd like to see. Then call list_services: if it returns exactly one \
service, use it silently without asking; if more than one, ask which the visit is for.
4. Ask what date they'd like, then call list_slots with that doctor, service and date. Read out the times it \
returns and ask the patient to pick one -- never state a time list_slots did not return.
5. Once they pick a time, restate the clinic, doctor, date and time and patient name back to them, and ask for an \
explicit yes before booking anything.
6. Only after they say yes, call book_appointment with that slot's token. Report the outcome plainly. If it fails \
because the slot was just taken by someone else, apologise and call list_slots again for fresh times on that date.

Rules:
- Never state a fact -- a clinic, a doctor, an available time, or that a booking succeeded -- unless it came from a \
tool result earlier in this conversation.
- This chat only books appointments. Do not answer medical questions, comment on symptoms, or give medical advice \
of any kind, even reassurance -- say the doctor will address that at the visit, and continue with the booking.
- Ask one question at a time, and keep messages short.`;

export interface WebchatReply {
  sessionId: string;
  reply: string;
}

export async function handleWebchatMessage(sessionId: string | undefined, userMessage: string): Promise<WebchatReply> {
  const session = (sessionId && webchatSessions.get(sessionId)) || webchatSessions.create();

  if (session.messages.length === 0) {
    session.messages.push({ role: "system", content: SYSTEM_PROMPT });
  }
  session.messages.push({ role: "user", content: userMessage });

  let reply = FALLBACK_REPLY;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await callGroq(session.messages, WEBCHAT_TOOLS);

    if (completion.toolCalls.length === 0) {
      reply = completion.content ?? FALLBACK_REPLY;
      session.messages.push({ role: "assistant", content: reply });
      break;
    }

    session.messages.push({ role: "assistant", content: completion.content, tool_calls: completion.toolCalls });

    for (const call of completion.toolCalls) {
      const result = await executeWebchatTool(session, call.function.name, call.function.arguments);
      session.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }

    if (round === MAX_TOOL_ROUNDS - 1) {
      session.messages.push({ role: "assistant", content: reply });
    }
  }

  webchatSessions.save(session);
  return { sessionId: session.id, reply };
}
