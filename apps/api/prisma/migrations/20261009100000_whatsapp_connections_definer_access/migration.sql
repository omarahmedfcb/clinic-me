-- The two SECURITY DEFINER lookups on whatsapp_connections (resolve_whatsapp_connection, and
-- resolve_whatsapp_connections_by_waba) run as clinic_os_definer, which the table never granted
-- anything to. With FORCE ROW LEVEL SECURITY the table owner is filtered too, so the definer also
-- needs a policy that lets it read. Same pattern as bot_credentials (migration 20260918140000).
-- Both statements are safe to run twice.

GRANT SELECT ON whatsapp_connections TO clinic_os_definer;

DROP POLICY IF EXISTS definer_reads ON whatsapp_connections;
CREATE POLICY definer_reads ON whatsapp_connections
  FOR SELECT TO clinic_os_definer USING (true);