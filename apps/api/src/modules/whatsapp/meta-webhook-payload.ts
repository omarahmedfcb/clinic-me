// The slice of Meta's Cloud API webhook payload this project reads. Deliberately not a
// class-validator DTO like every other request body in this codebase (bot.dto.ts, webchat.dto.ts):
// those exist so `forbidNonWhitelisted` can reject a caller smuggling an unexpected field, which is
// the wrong instinct for a third-party payload we do not control the shape of and must not reject
// merely for carrying a field we do not yet read (a new message type, a future webhook field). This
// is read defensively instead -- every access is optional-chained, and an unrecognised shape is
// skipped rather than thrown on. See whatsapp.controller.ts for where it is actually parsed.

export interface MetaInboundMessage {
  id?: string;
  from?: string;
  timestamp?: string;
  type?: string;
  text?: { body?: string };
}

export interface MetaWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        /** Present on an inbound message; absent on a delivery-status callback (sent/delivered/
         *  read/failed for a message *we* sent) -- the two share this same webhook shape, and a
         *  status callback is simply skipped by the caller checking this is present and non-empty. */
        messages?: MetaInboundMessage[];
      };
    }>;
  }>;
}
