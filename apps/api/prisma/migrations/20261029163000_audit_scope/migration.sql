-- An audit row's reach is an explicit value, so a null branch is never ambiguous (ruled 2026-10-29):
-- ONE_BRANCH names it; UNSCOPED and BEFORE_BRANCHES both carry a null branch and say why.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

CREATE TYPE "AuditScope" AS ENUM ('ONE_BRANCH', 'UNSCOPED', 'BEFORE_BRANCHES');

-- Existing rows are labelled by a column type change, which rewrites the table without firing row
-- triggers: no UPDATE runs, so D5 holds. A recorded branch is ONE_BRANCH; no branch was never recorded.
ALTER TABLE "audit_logs" ADD COLUMN "scope" text;
ALTER TABLE "audit_logs" ALTER COLUMN "scope" TYPE "AuditScope"
  USING (CASE WHEN "branch_id" IS NULL THEN 'BEFORE_BRANCHES' ELSE 'ONE_BRANCH' END)::"AuditScope";

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_logs_append_only' AND tgenabled = 'D') THEN
    RAISE EXCEPTION 'audit scope migration: the append-only trigger is disabled, and this migration never disables it';
  END IF;
END $$;

ALTER TABLE "audit_logs" ALTER COLUMN "scope" SET NOT NULL;
-- The database's other writers name no branch and describe rows that have none: tenants, users, the
-- operator's tables, credentials, webhooks. audit-scope.integration.spec.ts lists them by name.
ALTER TABLE "audit_logs" ALTER COLUMN "scope" SET DEFAULT 'UNSCOPED';
ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_branch_matches_scope"
    CHECK (("branch_id" IS NULL) = ("scope" <> 'ONE_BRANCH'));

CREATE FUNCTION forbid_before_branches_scope() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope = 'BEFORE_BRANCHES' THEN
    RAISE EXCEPTION 'audit_logs: BEFORE_BRANCHES is historical only; a new row is ONE_BRANCH or UNSCOPED';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_logs_no_new_before_branches BEFORE INSERT ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION forbid_before_branches_scope();

-- The row's own branch (a branches row is its own: receipt and invoice allocations audit it, the
-- tax control on the number sequence, BRANCHES-DESIGN §4.6); else a child's parent; else the request's.
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
  v_row        jsonb;
  v_branch_id  uuid;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;

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

  v_row := COALESCE(v_new, v_previous);
  IF v_row ? 'branch_id' THEN
    v_branch_id := NULLIF(v_row->>'branch_id', '')::uuid;
  ELSE
    v_branch_id := CASE TG_TABLE_NAME
      WHEN 'appointment_events'  THEN (SELECT branch_id FROM appointments       WHERE id = (v_row->>'appointment_id')::uuid)
      WHEN 'visit_revisions'     THEN (SELECT branch_id FROM visits             WHERE id = (v_row->>'visit_id')::uuid)
      WHEN 'visit_procedures'    THEN (SELECT branch_id FROM visits             WHERE id = (v_row->>'visit_id')::uuid)
      WHEN 'visit_charge_lines'  THEN (SELECT branch_id FROM visit_charges      WHERE id = (v_row->>'charge_id')::uuid)
      WHEN 'payment_adjustments' THEN (SELECT branch_id FROM payments           WHERE id = (v_row->>'payment_id')::uuid)
      WHEN 'schedule_breaks'     THEN (SELECT branch_id FROM schedule_templates WHERE id = (v_row->>'schedule_template_id')::uuid)
      WHEN 'branches'            THEN (v_row->>'id')::uuid
    END;
    v_branch_id := COALESCE(v_branch_id, NULLIF(current_setting('app.current_branch_id', true), '')::uuid);
  END IF;

  SELECT m.role::text INTO v_actor_role
  FROM memberships m
  WHERE m.tenant_id = v_tenant_id
    AND m.user_id = v_actor_id
    AND m.status = 'ACTIVE'
  LIMIT 1;

  IF v_actor_role IS NULL THEN
    v_actor_role := CASE WHEN v_actor_id = system_actor_id() THEN 'SYSTEM' ELSE 'UNKNOWN' END;
  END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at, branch_id, scope
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
    now(),
    v_branch_id,
    CASE WHEN v_branch_id IS NULL THEN 'UNSCOPED' ELSE 'ONE_BRANCH' END::"AuditScope"
  );

  RETURN NULL;
END;
$$;

SELECT set_config('app.current_actor_id', '', false);
