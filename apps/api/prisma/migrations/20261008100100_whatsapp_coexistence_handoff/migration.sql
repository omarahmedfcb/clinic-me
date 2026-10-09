-- WhatsApp coexistence and human handoff.
--
-- 1. A connection now records HOW the number is used (a brand-new Cloud API number, or a number the
--    clinic keeps using in the WhatsApp Business app: coexistence), and WHY it stopped working
--    when it did, so the clinic owner can be told instead of the bot going silently quiet.
-- 2. A conversation can be paused for the bot while a human has it.
-- 3. The webhook lookup learns the number's mode, and a second lookup finds a clinic by WABA id:
--    Meta's `account_update` webhook (PARTNER_REMOVED and friends) names the WABA, not the number.

ALTER TABLE whatsapp_connections
  ADD COLUMN number_mode       text NOT NULL DEFAULT 'NEW_NUMBER'
                                 CHECK (number_mode IN ('NEW_NUMBER', 'COEXISTENCE')),
  ADD COLUMN disconnect_reason text,
  ADD COLUMN status_changed_at timestamptz(6),
  ADD COLUMN sync_requested_at timestamptz(6);

ALTER TABLE conversations
  ADD COLUMN bot_paused_until  timestamptz(6),
  ADD COLUMN bot_paused_reason text
                                 CHECK (bot_paused_reason IN ('PATIENT_REQUEST', 'STAFF_REPLY'));

-- The "paused chats" list reads only the rows that are paused.
CREATE INDEX conversations_bot_paused_idx
  ON conversations (tenant_id, bot_paused_until)
  WHERE bot_paused_until IS NOT NULL;

-- Same function, one more column. A function's result type cannot change in place, so it is
-- dropped and recreated; the grant and the owner are restated exactly as they were.
DROP FUNCTION resolve_whatsapp_connection(text);

CREATE FUNCTION resolve_whatsapp_connection(p_phone_number_id text)
RETURNS TABLE (
  tenant_id uuid, waba_id text, status text,
  access_token_enc text, bot_credential_id uuid, bot_secret_enc text,
  number_mode text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.tenant_id, c.waba_id, c.status, c.access_token_enc, c.bot_credential_id, c.bot_secret_enc,
         c.number_mode
  FROM whatsapp_connections c
  WHERE c.phone_number_id = p_phone_number_id;
$$;

REVOKE ALL ON FUNCTION resolve_whatsapp_connection(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_connection(text) TO clinic_os_app;
ALTER FUNCTION resolve_whatsapp_connection(text) OWNER TO clinic_os_definer;

-- No credentials: an `account_update` handler only needs to know WHICH clinic, to flip its status.
CREATE FUNCTION resolve_whatsapp_connections_by_waba(p_waba_id text)
RETURNS TABLE (tenant_id uuid, phone_number_id text, status text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.tenant_id, c.phone_number_id, c.status
  FROM whatsapp_connections c
  WHERE c.waba_id = p_waba_id;
$$;

REVOKE ALL ON FUNCTION resolve_whatsapp_connections_by_waba(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_whatsapp_connections_by_waba(text) TO clinic_os_app;
ALTER FUNCTION resolve_whatsapp_connections_by_waba(text) OWNER TO clinic_os_definer;
