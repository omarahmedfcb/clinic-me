// A conversation's working memory: which clinic, patient, doctor and service have been settled so
// far, and the message history Groq needs for context.
//
// In-memory and per-process, deliberately. `Conversation`/`Message` (WHATSAPP-BOT-CONTRACT.md)
// carry WhatsApp billing fields -- `billingCategory`, a required external message id -- that a web
// chat has no honest answer for, and bending them to fit would blur the two channels' invariants
// rather than share anything real. Losing a session on a restart is an acceptable cost for a
// channel nobody has committed to book through yet; see CLAUDE.md's note on this being an early
// prototype whose job is to prove the LLM can carry the flow, not to be the final storage design.

import { randomUUID } from "node:crypto";

export interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type GroqMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: GroqToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** What the tools have settled so far. Never trust the model with an id this doesn't hold. */
export interface WebchatSlots {
  tenantId?: string;
  tenantTimezone?: string;
  tenantCountry?: "EG" | "SA" | "AE";
  botMembershipId?: string;
  botUserId?: string;
  patientId?: string;
  /** Set when find_or_create_patient finds more than one household member on the phone number, so
   *  select_patient can be checked against it rather than trusting whatever id the model sends. */
  householdCandidateIds?: string[];
}

export interface WebchatSession {
  id: string;
  messages: GroqMessage[];
  slots: WebchatSlots;
  updatedAt: number;
}

/** An hour of silence is a new conversation, not a resumed one. */
const SESSION_TTL_MS = 60 * 60 * 1000;

class WebchatSessionStore {
  private readonly sessions = new Map<string, WebchatSession>();

  get(sessionId: string): WebchatSession | undefined {
    this.sweep();
    return this.sessions.get(sessionId);
  }

  create(): WebchatSession {
    const session: WebchatSession = { id: randomUUID(), messages: [], slots: {}, updatedAt: Date.now() };
    this.sessions.set(session.id, session);
    return session;
  }

  save(session: WebchatSession): void {
    session.updatedAt = Date.now();
    this.sessions.set(session.id, session);
  }

  private sweep(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) this.sessions.delete(id);
    }
  }
}

/** One store per process. A restart or a second instance simply starts everyone over. */
export const webchatSessions = new WebchatSessionStore();
