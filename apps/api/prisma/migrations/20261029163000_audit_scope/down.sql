-- Reverses 20261029163000_audit_scope, refusing once one UNSCOPED row exists: scope then holds recorded
-- content, not a label (D14a), as the branches down refuses once a second branch or an invoice exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE scope = 'UNSCOPED') THEN
    RAISE EXCEPTION 'audit scope down: an UNSCOPED row exists. Dropping scope would make it indistinguishable from BEFORE_BRANCHES, and re-applying would label it BEFORE_BRANCHES, which is false';
  END IF;
END $$;

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

  v_branch_id := COALESCE(
    NULLIF(COALESCE(v_new, v_previous)->>'branch_id', '')::uuid,
    NULLIF(current_setting('app.current_branch_id', true), '')::uuid
  );

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
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at, branch_id
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
    v_branch_id
  );

  RETURN NULL;
END;
$$;

DROP TRIGGER "audit_logs_no_new_before_branches" ON "audit_logs";
DROP FUNCTION forbid_before_branches_scope();
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_branch_matches_scope";
ALTER TABLE "audit_logs" DROP COLUMN "scope";
DROP TYPE "AuditScope";

DELETE FROM _prisma_migrations WHERE migration_name = '20261029163000_audit_scope';
