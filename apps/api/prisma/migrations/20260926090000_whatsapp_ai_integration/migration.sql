-- Two columns for the real WhatsApp bot (docs/WHATSAPP-BOT-CONTRACT.md, ARCHITECTURE.md §11/§12).
-- Neither needs a new RLS policy or audit trigger change: both tables already carry the standard
-- tenant-isolation policy and the standard audit trigger, and a nullable column joins the row that
-- policy and that trigger already cover.

-- Tenant resolution for an inbound Meta webhook. "Never trust anything else in the payload" --
-- ARCHITECTURE.md §11 -- so this is the one column that decision reads.
ALTER TABLE tenants ADD COLUMN whatsapp_phone_number_id text;
CREATE UNIQUE INDEX tenants_whatsapp_phone_number_id_key
  ON tenants (whatsapp_phone_number_id)
  WHERE whatsapp_phone_number_id IS NOT NULL;

-- Where a WhatsApp conversation's OpenAI Responses-API turn is chained from, so the "send only the
-- new turn, not the transcript" approach (gpt-client.ts) survives a restart or a second instance.
-- Deliberately not on `messages`: `body_preview` is capped and non-clinical by design, and adding a
-- second, unbounded field to that row would blur a delivery/audit record into a context store.
ALTER TABLE conversations ADD COLUMN last_ai_response_id text;
