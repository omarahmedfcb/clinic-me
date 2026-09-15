-- Phase 1, Checkpoint 3 — audit as a database guarantee (SCHEMA-DECISIONS.md D16).
--
-- This replaces AuditInterceptor's write path. The interceptor still exists, but its job is now
-- only to bind the actor into session context; it writes nothing. The reasoning is in D16 and is
-- not repeated here, except for the one line that matters when reading this file: an interceptor
-- fires only if a route was wired to it and the service remembered to report what it did, which
-- makes the audit trail an application convention. A trigger fires on every INSERT/UPDATE/DELETE
-- regardless of code path -- the Nest app, a future BullMQ job, a psql session, a data migration,
-- or a bug that skipped the interceptor entirely.
--
-- Four facts the trigger reads straight from Postgres rather than being told:
--   * the action        TG_OP, exact -- not inferred from an HTTP verb
--   * before / after     to_jsonb(OLD) / to_jsonb(NEW), the rows actually committed
--   * the entity         TG_TABLE_NAME and the row's own id
--   * the tenant         the row's own tenant_id, not the session variable
--
-- Two facts it cannot know, because they are HTTP-layer concepts with no database representation,
-- and which withTenant() therefore binds for it: the client IP and the User-Agent. When a write
-- arrives from somewhere with no HTTP request behind it, those bind to 'unknown' -- which is
-- itself informative, and is the honest value.

CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_actor_id   uuid;
  v_actor_role text;
  v_tenant_id  uuid;
  v_entity_id  uuid;
  v_action     "AuditAction";
  v_previous   jsonb;
  v_new        jsonb;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;

  -- D16: raise, do not silently substitute a default. This is consistent with the severity of
  -- this project's other two database guarantees -- the append-only triggers (D5) and RLS (D4,
  -- D15) do not degrade gracefully either, and an audit trail with anonymous rows in it is worth
  -- less than one that refused the write. A legitimate unattended process is not blocked by this:
  -- it binds system_actor_id() (06-system-actor.sql), the same way a human actor's id comes from
  -- a validated JWT claim.
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION
      'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first. Application code does this via withTenant(); '
                   'an unattended process should bind system_actor_id(). See SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_action    := 'CREATE';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_previous  := NULL;
    v_new       := to_jsonb(NEW);
  ELSIF TG_OP = 'UPDATE' THEN
    v_action    := 'UPDATE';
    v_tenant_id := NEW.tenant_id;
    v_entity_id := NEW.id;
    v_previous  := to_jsonb(OLD);
    v_new       := to_jsonb(NEW);
  ELSE
    v_action    := 'DELETE';
    v_tenant_id := OLD.tenant_id;
    v_entity_id := OLD.id;
    v_previous  := to_jsonb(OLD);
    v_new       := NULL;
  END IF;

  -- actor_role is NOT NULL and is a database fact here, looked up rather than taken from the
  -- caller's JWT claim: a role changed mid-session would make the claim stale, and the whole
  -- point of this file is not to trust what the application says happened. The lookup is
  -- RLS-constrained like any other read of memberships -- it resolves because the session's
  -- tenant is bound, which for a tenant-scoped write it always is.
  SELECT m.role::text INTO v_actor_role
  FROM memberships m
  WHERE m.tenant_id = v_tenant_id
    AND m.user_id = v_actor_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    -- No active membership for this actor in this tenant. Two genuinely different cases, kept
    -- distinguishable rather than collapsed into one label: the system actor legitimately has no
    -- membership anywhere and never will, while anything else here is an anomaly worth being able
    -- to grep for later. Neither is a reason to refuse the write -- the actor is still recorded.
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(),
    v_tenant_id,
    v_actor_id,
    v_actor_role,
    v_action,
    TG_TABLE_NAME,
    v_entity_id,
    v_previous,
    v_new,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN NULL; -- AFTER trigger: the return value is ignored.
END;
$$;

-- The 29 tenant-scoped tables -- the same set as src/prisma/tenant-scoped-models.ts's "scoped"
-- classification and the same set RLS covers after D15, and for the same reason: these are the
-- tables where a row belongs to exactly one clinic and a change to it is that clinic's history.
--
-- Written as a loop over an explicit list rather than 29 near-identical CREATE TRIGGER statements.
-- The list is the reviewable part -- it can be counted and diffed against tenant-scoped-models.ts
-- at a glance -- and a loop makes it impossible for one table to drift into a subtly different
-- trigger definition from the other 28.
--
-- NOT included, matching 03-extend-rls.sql exactly: tenants, users, refresh_tokens (cross-tenant
-- by design), audit_logs (auditing the audit table is a recursion, and it is append-only anyway),
-- message_templates (nullable tenant_id where NULL is meaningful).
--
-- appointment_events, visit_revisions and payment_adjustments are append-only (D5): their BEFORE
-- UPDATE/DELETE trigger raises before this AFTER trigger could fire, so in practice only their
-- INSERT is ever audited. That is correct, not a gap -- there is no other operation to audit.
DO $$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'memberships',
    'doctors',
    'services',
    'schedule_templates',
    'schedule_breaks',
    'schedule_exceptions',
    'contacts',
    'patients',
    'appointments',
    'appointment_events',
    'visits',
    'visit_revisions',
    'prescriptions',
    'prescription_items',
    'payments',
    'payment_adjustments',
    'consents',
    'access_grants',
    'treatment_plans',
    'treatment_plan_sessions',
    'prescription_access_tokens',
    'subscriptions',
    'usage_records',
    'usage_alerts',
    'invoices',
    'conversations',
    'messages',
    'followup_tasks',
    'attachments'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      v_table || '_audit', v_table
    );
  END LOOP;
END
$$;
