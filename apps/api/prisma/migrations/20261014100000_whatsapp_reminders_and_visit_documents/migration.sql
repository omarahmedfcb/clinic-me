-- WhatsApp appointment reminders, the "go to the room" message, and the post-visit documents link.
--
-- Three things live here, and they share one table on purpose:
--   1. per-clinic switches (all OFF) and the two reminder timings;
--   2. `outbound_message_intents`, the outbox every one of these messages goes through
--      (PHASE-4.md Q20: an intent written where the reason happened, sent later by a drainer);
--   3. `visit_document_links`, the revocable, expiring link to a visit's documents.

-- ============================================================================
-- 1. Per-clinic settings
--
-- Real columns, not keys in `tenants.settings` (D20). All three switches default to OFF: each message is
-- billed by Meta to the clinic's own WhatsApp account, and the reminder can cancel an appointment, so a
-- clinic turns the automation on knowingly.
-- ============================================================================

ALTER TABLE tenants
  ADD COLUMN appointment_reminders_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN reminder_lead_hours           integer NOT NULL DEFAULT 5,
  ADD COLUMN reminder_confirm_window_hours integer NOT NULL DEFAULT 2,
  ADD COLUMN call_in_message_enabled       boolean NOT NULL DEFAULT false,
  ADD COLUMN visit_documents_link_enabled  boolean NOT NULL DEFAULT false;

ALTER TABLE tenants
  ADD CONSTRAINT tenants_reminder_lead_hours_range
    CHECK (reminder_lead_hours BETWEEN 1 AND 48),
  ADD CONSTRAINT tenants_reminder_confirm_window_hours_range
    CHECK (reminder_confirm_window_hours BETWEEN 1 AND 24);

-- ============================================================================
-- 2. The outbox
-- ============================================================================

CREATE TABLE outbound_message_intents (
  -- Also the idempotency key for the send: a retry reuses it.
  id                  uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  appointment_id      uuid NOT NULL REFERENCES appointments(id),
  kind                text NOT NULL,
  -- One intent per reason. A second sweep, a replayed trigger, a double tap: the same intent.
  dedupe_key          text NOT NULL,
  status              text NOT NULL DEFAULT 'PENDING',
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz(6) NOT NULL,
  -- After this the message is pointless and is skipped, not sent late.
  expires_at          timestamptz(6),
  -- Reminder only: the start the reminder was scheduled for, so a reschedule is noticed.
  appointment_start   timestamptz(6),
  -- Reminder only: when the patient must have answered by. NULL means this reminder never cancels.
  respond_by          timestamptz(6),
  responded_at        timestamptz(6),
  response            text,
  external_message_id text,
  sent_at             timestamptz(6),
  failed_at           timestamptz(6),
  skipped_reason      text,
  last_error          text,
  created_at          timestamptz(6) NOT NULL DEFAULT now(),
  updated_at          timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT outbound_message_intents_kind_known
    CHECK (kind IN ('APPOINTMENT_REMINDER', 'REMINDER_AUTO_CANCELLED', 'CALL_IN', 'VISIT_DOCUMENTS')),
  CONSTRAINT outbound_message_intents_status_known
    CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED')),
  CONSTRAINT outbound_message_intents_response_known
    CHECK (response IS NULL OR response IN ('CONFIRMED', 'CANCELLED', 'EXPIRED')),
  CONSTRAINT outbound_message_intents_dedupe_unique UNIQUE (tenant_id, dedupe_key)
);

-- Prisma names the unique index from the model; keep the two in step.
ALTER TABLE outbound_message_intents
  RENAME CONSTRAINT outbound_message_intents_dedupe_unique TO outbound_message_intents_tenant_id_dedupe_key_key;

CREATE INDEX outbound_message_intents_tenant_id_idx ON outbound_message_intents (tenant_id);

-- The drainer's index: everything still owed, soonest first.
CREATE INDEX outbound_message_intents_due_idx ON outbound_message_intents (next_attempt_at)
  WHERE status = 'PENDING';

-- The expiry sweep's index: reminders sent, unanswered, with a deadline.
CREATE INDEX outbound_message_intents_awaiting_reply_idx ON outbound_message_intents (respond_by)
  WHERE status = 'SENT' AND responded_at IS NULL AND respond_by IS NOT NULL;

-- Finding the open reminder for an appointment, which a patient's tap and a reschedule both do.
CREATE INDEX outbound_message_intents_appointment_idx ON outbound_message_intents (appointment_id, kind);

ALTER TABLE outbound_message_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_message_intents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbound_message_intents
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON outbound_message_intents TO clinic_os_app;
GRANT SELECT, INSERT, UPDATE ON outbound_message_intents TO clinic_os_definer;

CREATE POLICY definer_enqueues ON outbound_message_intents FOR INSERT TO clinic_os_definer WITH CHECK (true);
CREATE POLICY definer_reads_due ON outbound_message_intents FOR SELECT TO clinic_os_definer USING (true);

-- ============================================================================
-- 3. Two intents are written by the database, not by the call sites
--
-- "The doctor started the consultation" and "the visit was completed" both already append an
-- `appointment_events` row, in the same transaction as the status change. A trigger on that row makes the
-- enqueue a property of the act, so a fourth code path that completes a visit cannot forget to send
-- the patient's documents -- the same argument `enqueue_webhook_delivery()` makes.
--
-- The reminder is NOT written here: it depends on the clinic's timezone and quiet hours, and it is
-- derived by the sweeper from the appointment itself, so a reschedule needs no bookkeeping.
-- ============================================================================

CREATE FUNCTION enqueue_message_intent() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.event_type <> 'STATUS_CHANGED' THEN
    RETURN NEW;
  END IF;

  -- The doctor starts the consultation: tell the patient which room. Not on RESUME (from PAUSED): the
  -- patient stepped out and is already being looked for. Late is worse than never, so it expires fast.
  IF NEW.to_status = 'IN_CONSULTATION' AND NEW.from_status IN ('WAITING', 'ARRIVED') THEN
    INSERT INTO outbound_message_intents (
      id, tenant_id, appointment_id, kind, dedupe_key, next_attempt_at, expires_at
    )
    SELECT uuid_generate_v7(), NEW.tenant_id, NEW.appointment_id, 'CALL_IN',
           'call-in:' || NEW.appointment_id::text, NEW.created_at, NEW.created_at + interval '5 minutes'
    FROM tenants t
    WHERE t.id = NEW.tenant_id AND t.call_in_message_enabled
    ON CONFLICT DO NOTHING;
  END IF;

  -- The visit ended: send the documents link. Retried hard -- the patient still wants these tomorrow.
  IF NEW.to_status = 'COMPLETED' THEN
    INSERT INTO outbound_message_intents (
      id, tenant_id, appointment_id, kind, dedupe_key, next_attempt_at
    )
    SELECT uuid_generate_v7(), NEW.tenant_id, NEW.appointment_id, 'VISIT_DOCUMENTS',
           'documents:' || NEW.appointment_id::text, NEW.created_at
    FROM tenants t
    WHERE t.id = NEW.tenant_id AND t.visit_documents_link_enabled
    ON CONFLICT DO NOTHING;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_events_enqueue_message_intent
  AFTER INSERT ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION enqueue_message_intent();

ALTER FUNCTION enqueue_message_intent() OWNER TO clinic_os_definer;

-- ============================================================================
-- 4. A message that was given up on is visible in the clinic's audit trail
--
-- Only that, for the reason `webhook_deliveries_audit` gives: an audit row per attempt would bury the
-- trail under the retry schedule. What is worth keeping is "we stopped trying and the patient was never told".
-- Named `<table>_audit`, the convention the audit sweep enforces.
-- ============================================================================

CREATE FUNCTION audit_outbound_message_failure() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id uuid;
BEGIN
  IF NEW.failed_at IS NULL OR OLD.failed_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  v_actor_id := COALESCE(NULLIF(current_setting('app.current_actor_id', true), '')::uuid, system_actor_id());

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(), NEW.tenant_id, v_actor_id, 'SYSTEM', 'UPDATE'::"AuditAction",
    TG_TABLE_NAME, NEW.id, NULL,
    jsonb_build_object(
      'kind', NEW.kind,
      'appointment_id', NEW.appointment_id,
      'attempts', NEW.attempts,
      'last_error', NEW.last_error,
      'failed_at', NEW.failed_at
    ),
    'unknown', 'outbound-messages', now()
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER outbound_message_intents_audit
  AFTER UPDATE OF failed_at ON outbound_message_intents
  FOR EACH ROW EXECUTE FUNCTION audit_outbound_message_failure();

ALTER FUNCTION audit_outbound_message_failure() OWNER TO clinic_os_definer;

-- ============================================================================
-- 5. The cross-tenant lookups the worker needs
--
-- A sweep has no tenant to bind -- which clinic is the question it is asking. Each returns ids only,
-- which the worker then binds one at a time through withTenant().
-- ============================================================================

CREATE FUNCTION list_due_message_intents(p_now timestamptz, p_limit integer)
RETURNS TABLE (intent_id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.tenant_id
  FROM outbound_message_intents i
  WHERE i.status = 'PENDING' AND i.next_attempt_at <= p_now
  ORDER BY i.next_attempt_at
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION list_due_message_intents(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_message_intents(timestamptz, integer) TO clinic_os_app;
ALTER FUNCTION list_due_message_intents(timestamptz, integer) OWNER TO clinic_os_definer;

CREATE FUNCTION list_expired_reminders(p_now timestamptz, p_limit integer)
RETURNS TABLE (intent_id uuid, tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT i.id, i.tenant_id
  FROM outbound_message_intents i
  WHERE i.kind = 'APPOINTMENT_REMINDER' AND i.status = 'SENT'
    AND i.responded_at IS NULL AND i.respond_by IS NOT NULL AND i.respond_by <= p_now
  ORDER BY i.respond_by
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION list_expired_reminders(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_expired_reminders(timestamptz, integer) TO clinic_os_app;
ALTER FUNCTION list_expired_reminders(timestamptz, integer) OWNER TO clinic_os_definer;

CREATE FUNCTION list_tenants_with_reminders_enabled()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT t.id
  FROM tenants t
  WHERE t.appointment_reminders_enabled AND t.status = 'ACTIVE';
$$;

REVOKE ALL ON FUNCTION list_tenants_with_reminders_enabled() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_tenants_with_reminders_enabled() TO clinic_os_app;
ALTER FUNCTION list_tenants_with_reminders_enabled() OWNER TO clinic_os_definer;

-- ============================================================================
-- 6. The documents link
--
-- Only the SHA-256 of the token is stored. The token is 256 bits of randomness and appears once, in the
-- WhatsApp message, so a leaked database does not leak a working link. Revocable, and it expires.
-- ============================================================================

CREATE TABLE visit_document_links (
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  visit_id        uuid NOT NULL REFERENCES visits(id),
  intent_id       uuid REFERENCES outbound_message_intents(id),
  token_hash      text NOT NULL UNIQUE,
  expires_at      timestamptz(6) NOT NULL,
  revoked_at      timestamptz(6),
  view_count      integer NOT NULL DEFAULT 0,
  first_viewed_at timestamptz(6),
  last_viewed_at  timestamptz(6),
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_at      timestamptz(6) NOT NULL DEFAULT now()
);

CREATE INDEX visit_document_links_tenant_id_visit_id_idx ON visit_document_links (tenant_id, visit_id);

ALTER TABLE visit_document_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_document_links FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON visit_document_links
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON visit_document_links TO clinic_os_app;
GRANT SELECT ON visit_document_links TO clinic_os_definer;
CREATE POLICY definer_reads ON visit_document_links FOR SELECT TO clinic_os_definer USING (true);

-- Audited when a link is issued or revoked -- who was given access to a patient's documents, and when it
-- ended. Not per view: that is `view_count`, and an audit row per glance would bury the trail.
CREATE FUNCTION audit_visit_document_link() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.revoked_at IS NULL OR OLD.revoked_at IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  v_actor_id := COALESCE(NULLIF(current_setting('app.current_actor_id', true), '')::uuid, system_actor_id());

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(), NEW.tenant_id, v_actor_id, 'SYSTEM',
    (CASE TG_OP WHEN 'INSERT' THEN 'CREATE' ELSE 'UPDATE' END)::"AuditAction",
    TG_TABLE_NAME, NEW.id, NULL,
    -- Never the hash: it is the lookup key for a working link.
    jsonb_build_object('visit_id', NEW.visit_id, 'expires_at', NEW.expires_at, 'revoked_at', NEW.revoked_at),
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN NEW;
END;
$$;

CREATE TRIGGER visit_document_links_audit
  AFTER INSERT OR UPDATE OF revoked_at ON visit_document_links
  FOR EACH ROW EXECUTE FUNCTION audit_visit_document_link();

ALTER FUNCTION audit_visit_document_link() OWNER TO clinic_os_definer;

-- The one lookup a patient's browser needs, before any tenant is known: which link is this?
CREATE FUNCTION resolve_visit_document_link(p_token_hash text)
RETURNS TABLE (link_id uuid, tenant_id uuid, visit_id uuid, expires_at timestamptz, revoked_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT l.id, l.tenant_id, l.visit_id, l.expires_at, l.revoked_at
  FROM visit_document_links l
  WHERE l.token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_visit_document_link(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_visit_document_link(text) TO clinic_os_app;
ALTER FUNCTION resolve_visit_document_link(text) OWNER TO clinic_os_definer;
