-- Branches step 6.4 (BRANCHES-DESIGN §9 ruling D): the operator messages one clinic's admins or every clinic's, inside the
-- system only (email deferred, ruled 2026-10-31; never WhatsApp). Every message, recipient and read is append-only.

CREATE TYPE "OperatorMessageAudience" AS ENUM ('ONE_CLINIC', 'ALL_CLINICS');

-- The vendor's record of what was sent: platform-only, like the back office, audited into nobody's tenant.
CREATE TABLE "operator_messages" (
    "id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "audience" "OperatorMessageAudience" NOT NULL,
    "target_tenant_id" UUID,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "operator_messages_target_iff_one_clinic" CHECK (("audience" = 'ONE_CLINIC') = ("target_tenant_id" IS NOT NULL)),
    CONSTRAINT "operator_messages_body_size" CHECK (btrim("body") <> '' AND char_length("body") <= 4000)
);
ALTER TABLE "operator_messages" ADD CONSTRAINT "operator_messages_sender_id_fkey"
    FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_messages" ADD CONSTRAINT "operator_messages_target_tenant_id_fkey"
    FOREIGN KEY ("target_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "operator_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "operator_messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_only ON "operator_messages" USING (is_active_platform_admin()) WITH CHECK (is_active_platform_admin());
GRANT SELECT, INSERT ON operator_messages TO clinic_os_app;
CREATE TRIGGER operator_messages_audit AFTER INSERT OR UPDATE OR DELETE ON operator_messages
  FOR EACH ROW EXECUTE FUNCTION audit_platform_row_change();
CREATE TRIGGER operator_messages_append_only BEFORE UPDATE OR DELETE ON operator_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- One row per admin who received it, in that clinic, carrying the text: the clinic reads its own copy under its own RLS.
CREATE TABLE "operator_message_recipients" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operator_message_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operator_message_recipients_message_id_user_id_tenant_id_key" ON "operator_message_recipients"("message_id", "user_id", "tenant_id");
CREATE INDEX "operator_message_recipients_tenant_id_user_id_sent_at_idx" ON "operator_message_recipients"("tenant_id", "user_id", "sent_at");
ALTER TABLE "operator_message_recipients" ADD CONSTRAINT "operator_message_recipients_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_message_recipients" ADD CONSTRAINT "operator_message_recipients_message_id_fkey"
    FOREIGN KEY ("message_id") REFERENCES "operator_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_message_recipients" ADD CONSTRAINT "operator_message_recipients_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Read marks in their own insert-only table, so no recipient row is ever updated.
CREATE TABLE "operator_message_reads" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "recipient_id" UUID NOT NULL,
    "read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operator_message_reads_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "operator_message_reads_recipient_id_key" ON "operator_message_reads"("recipient_id");
ALTER TABLE "operator_message_reads" ADD CONSTRAINT "operator_message_reads_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "operator_message_reads" ADD CONSTRAINT "operator_message_reads_recipient_id_fkey"
    FOREIGN KEY ("recipient_id") REFERENCES "operator_message_recipients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE operator_message_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_message_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operator_message_recipients
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON operator_message_recipients TO clinic_os_app;
CREATE TRIGGER operator_message_recipients_audit AFTER INSERT OR UPDATE OR DELETE ON operator_message_recipients
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER operator_message_recipients_append_only BEFORE UPDATE OR DELETE ON operator_message_recipients
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

ALTER TABLE operator_message_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_message_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON operator_message_reads
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
GRANT SELECT, INSERT ON operator_message_reads TO clinic_os_app;
CREATE TRIGGER operator_message_reads_audit AFTER INSERT OR UPDATE OR DELETE ON operator_message_reads
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
CREATE TRIGGER operator_message_reads_append_only BEFORE UPDATE OR DELETE ON operator_message_reads
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- The definer role reads the history, and writes one copy per admin when a message is delivered. Nothing else.
GRANT SELECT ON operator_message_recipients, operator_message_reads, operator_messages TO clinic_os_definer;
GRANT INSERT ON operator_message_recipients TO clinic_os_definer;
CREATE POLICY definer_reads ON operator_message_recipients FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_delivers ON operator_message_recipients FOR INSERT TO clinic_os_definer WITH CHECK (true);
CREATE POLICY definer_reads ON operator_message_reads FOR SELECT TO clinic_os_definer USING (true);
CREATE POLICY definer_reads ON operator_messages FOR SELECT TO clinic_os_definer USING (true);

-- Delivery in one statement, in the sender's transaction: every ACTIVE OWNER or ADMIN of the target clinic, or of every
-- ACTIVE clinic. Staff never. Refuses any actor who is not an active platform admin, as every platform_* function does.
CREATE FUNCTION deliver_operator_message(p_message_id uuid)
RETURNS TABLE (clinics integer, recipients integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_is_admin boolean;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'deliver_operator_message() requires a bound actor'
      USING HINT = 'Call it inside withPlatformActor(). See SCHEMA-DECISIONS.md D16.', ERRCODE = 'raise_exception';
  END IF;
  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin FROM users u WHERE u.id = v_actor_id;
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'deliver_operator_message() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  WITH delivered AS (
    INSERT INTO operator_message_recipients (id, tenant_id, message_id, user_id, body, sent_at)
    SELECT uuid_generate_v7(), m.tenant_id, msg.id, m.user_id, msg.body, msg.created_at
      FROM operator_messages msg
      JOIN memberships m ON (msg.target_tenant_id IS NULL OR m.tenant_id = msg.target_tenant_id)
      JOIN tenants t ON t.id = m.tenant_id
     WHERE msg.id = p_message_id AND t.status = 'ACTIVE' AND m.status = 'ACTIVE' AND m.role IN ('OWNER', 'ADMIN')
    RETURNING tenant_id
  )
  SELECT count(DISTINCT tenant_id)::int, count(*)::int FROM delivered;
END;
$$;
REVOKE ALL ON FUNCTION deliver_operator_message(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION deliver_operator_message(uuid) TO clinic_os_app;
ALTER FUNCTION deliver_operator_message(uuid) OWNER TO clinic_os_definer;

CREATE FUNCTION platform_operator_messages()
RETURNS TABLE (
  id uuid,
  audience "OperatorMessageAudience",
  target_tenant_id uuid,
  target_clinic_name text,
  body text,
  sender_name text,
  created_at timestamptz,
  clinics integer,
  recipients integer,
  reads integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
  v_is_admin boolean;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'platform_operator_messages() requires a bound actor'
      USING HINT = 'Call it inside withPlatformActor(). See SCHEMA-DECISIONS.md D16.', ERRCODE = 'raise_exception';
  END IF;
  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin FROM users u WHERE u.id = v_actor_id;
  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_operator_messages() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT m.id, m.audience, m.target_tenant_id, t.name, m.body, u.full_name, m.created_at,
         (SELECT count(DISTINCT r.tenant_id)::int FROM operator_message_recipients r WHERE r.message_id = m.id),
         (SELECT count(*)::int FROM operator_message_recipients r WHERE r.message_id = m.id),
         (SELECT count(*)::int FROM operator_message_reads d JOIN operator_message_recipients r ON r.id = d.recipient_id WHERE r.message_id = m.id)
    FROM operator_messages m
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN tenants t ON t.id = m.target_tenant_id
   ORDER BY m.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION platform_operator_messages() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_operator_messages() TO clinic_os_app;
ALTER FUNCTION platform_operator_messages() OWNER TO clinic_os_definer;
