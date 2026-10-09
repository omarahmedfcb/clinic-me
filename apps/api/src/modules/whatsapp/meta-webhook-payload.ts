// The slice of Meta's Cloud API webhook payload this project reads. Deliberately not a
// class-validator DTO like every other request body in this codebase (bot.dto.ts, webchat.dto.ts):
// those exist so `forbidNonWhitelisted` can reject a caller smuggling an unexpected field, which is
// the wrong instinct for a third-party payload we do not control the shape of and must not reject
// merely for carrying a field we do not yet read (a new message type, a future webhook field). This
// is read defensively instead -- every access is optional-chained, and an unrecognised shape is
// skipped rather than thrown on. See whatsapp.controller.ts for where it is actually parsed.

export interface MetaInteractiveReply {
  type?: "button_reply" | "list_reply";
  button_reply?: { id?: string; title?: string };
  list_reply?: { id?: string; title?: string; description?: string };
}

export interface MetaInboundMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
  /** Present when `type === "interactive"` -- a tapped reply button or list row. whatsapp.controller.ts
   *  reads `button_reply.id` or `list_reply.id`, never `.title`: the id is the flow's own opaque
   *  step-scoped value (whatsapp-flow.ts mints it), and the title is only what was shown on the
   *  button, which is locale text and never what a step handler should branch on. */
  interactive?: MetaInteractiveReply;
}

/** A message a person sent from the WhatsApp Business app on a coexistence number (`smb_message_echoes`). */
export interface MetaEchoMessage {
  id?: string;
  from?: string;
  /** The patient's wa_id, digits only. */
  to?: string;
  timestamp?: string;
  type?: string;
}

export interface MetaWebhookPayload {
  entry?: Array<{
    /** The WABA id. `account_update` is addressed by it. */
    id?: string;
    changes?: Array<{
      /** "messages" | "smb_message_echoes" | "history" | "smb_app_state_sync" | "account_update" | ... */
      field?: string;
      value?: {
        metadata?: { phone_number_id?: string };
        /** `smb_message_echoes`. */
        message_echoes?: MetaEchoMessage[];
        /** `account_update`: PARTNER_REMOVED, ACCOUNT_OFFBOARDED, ... */
        event?: string;
        waba_info?: { waba_id?: string };
        /** `history`: progress chunks, or an error when the clinic declined to share it. */
        history?: Array<{
          metadata?: { phase?: number; chunk_order?: number; progress?: number };
          errors?: Array<{ code?: number; message?: string }>;
        }>;
        /** Present on an inbound message; absent on a delivery-status callback (sent/delivered/
         *  read/failed for a message *we* sent) -- the two share this same webhook shape, and a
         *  status callback is simply skipped by the caller checking this is present and non-empty. */
        messages?: MetaInboundMessage[];
      };
    }>;
  }>;
}
