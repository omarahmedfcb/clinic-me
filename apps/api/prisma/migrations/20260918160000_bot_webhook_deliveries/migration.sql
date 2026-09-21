-- The webhook our side calls: per-clinic URL and signing secret, and the outbox we deliver from.
-- docs/WHATSAPP-BOT-CONTRACT.md §6.

-- ============================================================================
-- 1. Where to call, and what to sign with
--
-- Both live on the credential, because the ruling is that they are issued with it and rotate with
-- it: a clinic that revokes its bot's credential has revoked the reminders too, in one act.
-- `webhook_secret` is stored as it is used, not hashed — we sign with it, so there is nothing to
-- compare against. That is the same position `users.totp_secret` is in, and the same answer: it is
-- redacted from the audit trail below, and never returned by any read route.
-- ============================================================================

-- Both nullable: a credential issued before the clinic had a bot to call has neither, and an empty
-- string would be a secret that looks usable and signs nothing.
ALTER TABLE bot_credentials
  ADD COLUMN webhook_url    text,
  ADD COLUMN webhook_secret text;

-- HTTPS or nothing. A reminder carrying a patient's name over plain HTTP is readable by every hop
-- between us and the bot, and a URL is configuration a person types.
ALTER TABLE bot_credentials
  ADD CONSTRAINT bot_credentials_webhook_url_https
  CHECK (webhook_url IS NULL OR webhook_url ~ '^https://[^[:space:]]+$');

-- ============================================================================
-- 2. The outbox
--
-- One row per thing the bot should be told about, written where the thing happened and delivered
-- later by `scripts/webhook-dispatch.mjs`. Nothing at the desk waits for the bot to answer: a screen
-- that blocks on somebody else's HTTPS endpoint is a screen that stops working when they deploy.
-- ============================================================================

CREATE TABLE webhook_deliveries (
  -- The id IS the idempotency key: retries reuse it, so the bot can refuse to message a patient
  -- twice for one key without knowing anything about our retry schedule.
  id              uuid PRIMARY KEY,
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  appointment_id  uuid NOT NULL REFERENCES appointments(id),
  event_type      text NOT NULL,
  occurred_at     timestamptz(6) NOT NULL,
  -- The appointment_events row this came from, so a delivery can always be traced to the act that
  -- caused it. Null for reminders, which no act causes.
  source_event_id uuid REFERENCES appointment_events(id),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz(6) NOT NULL,
  delivered_at    timestamptz(6),
  failed_at       timestamptz(6),
  -- Why nothing was sent, when nothing was sent: NO_CONSENT, NO_WEBHOOK, PATIENT_GONE. A delivery
  -- that simply vanished would be indistinguishable from one nobody ever wrote.
  skipped_reason  text,
  last_status     integer,
  last_error      text,
  created_at      timestamptz(6) NOT NULL DEFAULT now(),
  updated_at      timestamptz(6) NOT NULL DEFAULT now(),

  CONSTRAINT webhook_deliveries_event_type_known
    CHECK (event_type IN ('appointment.confirmed', 'appointment.cancelled',
                          'appointment.rescheduled', 'appointment.reminder'))
);

CREATE INDEX webhook_deliveries_tenant_id_idx ON webhook_deliveries (tenant_id);

-- The sweep's index: everything still owed, oldest first.
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at)
  WHERE delivered_at IS NULL AND failed_at IS NULL AND skipped_reason IS NULL;

-- One delivery per act, and **one reminder per appointment**. A second reschedule is a second
-- event and must be sent; a second sweep of the same appointment is the same reminder and must not.
CREATE UNIQUE INDEX webhook_deliveries_one_per_source ON webhook_deliveries (source_event_id)
  WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX webhook_deliveries_one_reminder_per_appointment
  ON webhook_deliveries (appointment_id)
  WHERE event_type = 'appointment.reminder';

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_deliveries
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO clinic_os_app;

-- ============================================================================
-- 3. The outbox is written by the database, not by three call sites
--
-- Booking, rescheduling and cancelling already append to `appointment_events`, and a fourth path
-- that forgot to enqueue would simply send nothing — silently, and only for the case it forgot.
-- The trigger makes the enqueue a property of the act instead of a step somebody remembers.
-- ============================================================================

CREATE FUNCTION enqueue_webhook_delivery() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_event_type text;
BEGIN
  v_event_type := CASE NEW.event_type
    WHEN 'CREATED'     THEN 'appointment.confirmed'
    WHEN 'RESCHEDULED' THEN 'appointment.rescheduled'
    WHEN 'CANCELLED'   THEN 'appointment.cancelled'
    ELSE NULL
  END;

  -- STATUS_CHANGED, OVERLAP_AUTHORISED and NOTE_ADDED are the clinic's business, not the patient's.
  IF v_event_type IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO webhook_deliveries (
    id, tenant_id, appointment_id, event_type, occurred_at, source_event_id, next_attempt_at
  )
  SELECT uuid_generate_v7(), NEW.tenant_id, NEW.appointment_id, v_event_type,
         NEW.created_at, NEW.id, NEW.created_at
  -- Only for a clinic that has a bot to call. Queueing for a clinic with no webhook would fill the
  -- outbox with rows whose only outcome is NO_WEBHOOK.
  WHERE EXISTS (
    SELECT 1 FROM bot_credentials c
    WHERE c.tenant_id = NEW.tenant_id AND c.revoked_at IS NULL AND c.webhook_url IS NOT NULL
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE TRIGGER appointment_events_enqueue_webhook
  AFTER INSERT ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION enqueue_webhook_delivery();

ALTER FUNCTION enqueue_webhook_delivery() OWNER TO clinic_os_definer;

GRANT SELECT, INSERT, UPDATE ON webhook_deliveries TO clinic_os_definer;
GRANT SELECT ON bot_credentials TO clinic_os_definer;

CREATE POLICY definer_enqueues ON webhook_deliveries FOR INSERT TO clinic_os_definer WITH CHECK (true);
CREATE POLICY definer_reads_due ON webhook_deliveries FOR SELECT TO clinic_os_definer USING (true);

-- ============================================================================
-- 4. A delivery that was given up on is visible in the clinic's own audit trail
--
-- Only that. An audit row per attempt would bury the clinic's history under our retry schedule; the
-- fact worth keeping is "we stopped trying, and the bot never heard about this appointment".
-- ============================================================================

CREATE FUNCTION audit_webhook_failure() RETURNS trigger
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
      'event_type', NEW.event_type,
      'appointment_id', NEW.appointment_id,
      'attempts', NEW.attempts,
      'last_status', NEW.last_status,
      'last_error', NEW.last_error,
      'failed_at', NEW.failed_at
    ),
    'unknown', 'webhook-dispatch', now()
  );

  RETURN NEW;
END;
$$;

-- Named by the convention the audit sweep enforces (`<table>_audit`): the table IS audited, and the
-- narrowness is in when it fires, not in whether it exists.
CREATE TRIGGER webhook_deliveries_audit
  AFTER UPDATE OF failed_at ON webhook_deliveries
  FOR EACH ROW EXECUTE FUNCTION audit_webhook_failure();

ALTER FUNCTION audit_webhook_failure() OWNER TO clinic_os_definer;

-- ============================================================================
-- 5. The two cross-tenant lookups the dispatcher needs
--
-- A cron sweep has no tenant to bind, for the same reason authenticating a credential has none:
-- which clinic this is about is the question it is asking. Both are by-need and nothing wider — a
-- list of ids, which the dispatcher then binds one at a time through withTenant.
-- ============================================================================

CREATE FUNCTION list_due_webhook_deliveries(p_now timestamptz, p_limit integer)
RETURNS TABLE (delivery_id uuid, tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT d.id, d.tenant_id
  FROM webhook_deliveries d
  WHERE d.delivered_at IS NULL AND d.failed_at IS NULL AND d.skipped_reason IS NULL
    AND d.next_attempt_at <= p_now
  ORDER BY d.next_attempt_at
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION list_due_webhook_deliveries(timestamptz, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_due_webhook_deliveries(timestamptz, integer) TO clinic_os_app;
ALTER FUNCTION list_due_webhook_deliveries(timestamptz, integer) OWNER TO clinic_os_definer;

CREATE FUNCTION list_tenants_with_live_webhook()
RETURNS TABLE (tenant_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.tenant_id
  FROM bot_credentials c
  JOIN tenants t ON t.id = c.tenant_id
  WHERE c.revoked_at IS NULL AND c.webhook_url IS NOT NULL AND t.status = 'ACTIVE';
$$;

REVOKE ALL ON FUNCTION list_tenants_with_live_webhook() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_tenants_with_live_webhook() TO clinic_os_app;
ALTER FUNCTION list_tenants_with_live_webhook() OWNER TO clinic_os_definer;

-- ============================================================================
-- 6. The credential's audit trigger learns the second secret
--
-- `webhook_secret` is a credential column like `secret_hash`, and the reason is the one written
-- when that redaction was added: record THAT it changed, never the value.
-- ============================================================================

CREATE OR REPLACE FUNCTION audit_bot_credential_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id   uuid;
  v_actor_role text;
  v_tenant_id  uuid;
  v_old        jsonb;
  v_new        jsonb;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first; application code does this via withTenant().',
            ERRCODE = 'raise_exception';
  END IF;

  v_tenant_id := COALESCE(NEW.tenant_id, OLD.tenant_id);

  SELECT m.role::text INTO v_actor_role
  FROM memberships m
  WHERE m.tenant_id = v_tenant_id AND m.user_id = v_actor_id AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  v_old := CASE WHEN OLD IS NULL THEN NULL ELSE (to_jsonb(OLD) - 'secret_hash' - 'webhook_secret')
                  || jsonb_build_object('secret_hash', '(redacted)', 'webhook_secret', '(redacted)') END;
  v_new := CASE WHEN NEW IS NULL THEN NULL ELSE (to_jsonb(NEW) - 'secret_hash' - 'webhook_secret')
                  || jsonb_build_object('secret_hash', '(redacted)', 'webhook_secret', '(redacted)') END;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(),
    v_tenant_id,
    v_actor_id,
    v_actor_role,
    CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'DELETE' END::"AuditAction",
    TG_TABLE_NAME,
    COALESCE(NEW.id, OLD.id),
    v_old,
    v_new,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER bot_credentials_audit ON bot_credentials;
CREATE TRIGGER bot_credentials_audit
  AFTER INSERT OR DELETE
      OR UPDATE OF secret_hash, membership_id, revoked_at, revoked_by_user_id,
                   webhook_url, webhook_secret
  ON bot_credentials
  FOR EACH ROW EXECUTE FUNCTION audit_bot_credential_change();

ALTER FUNCTION audit_bot_credential_change() OWNER TO clinic_os_definer;
