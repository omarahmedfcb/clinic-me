-- The platform back-office — the founder's review of #113, 2026-09-15.
--
-- Three things, and one property shared by all of them: **this is the vendor's data about a
-- customer, not the customer's data.** A clinic's own admin must never read our agreed discount,
-- our sales notes, or which of our people owns the account. So the new tables carry `tenant_id` and
-- are deliberately NOT tenant-scoped: they are readable by an ACTIVE platform admin and by nobody
-- else, which is the opposite of every other table in this schema and is why the policy is written
-- out here rather than copied from `01-constraints.sql`.
--
--   (a) operator roles and a second factor, on `users`
--   (b) the client file: contacts, sales owner, contract PDFs, agreed commercials, notes
--   (c) the account's commercial state and when it renews
--
-- Still aggregates only: nothing here reads or stores a clinical or financial row of a clinic's,
-- and `platform-isolation.integration.spec.ts` sweeps the whole `/platform/*` surface for exactly
-- that.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

-- ============================================================================
-- (a) OPERATOR ROLES AND TOTP
-- ============================================================================
--
-- `platform_role` sits beside `is_platform_admin` rather than replacing it, and a CHECK keeps the
-- two from disagreeing: a flagged account always has a role, an unflagged one never does. The flag
-- is what every guard already reads, so widening it into an enum would have meant editing every one
-- of those reads to mean the same thing.
--
-- It is NOT a `MembershipRole`. An operator holds no membership — that is the whole design of the
-- console — and reusing the clinic's enum would let one of these values be written into a
-- `memberships` row, where it would mean nothing and be refused by nothing.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "platform_role" TEXT;

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_platform_role_supported";
ALTER TABLE "users" ADD CONSTRAINT "users_platform_role_supported"
  CHECK ("platform_role" IS NULL OR "platform_role" IN ('OWNER', 'SUPPORT', 'SALES', 'FINANCE'));

-- Backfill before the agreement CHECK: an operator that already exists is an OWNER, because the
-- first one was created by us and there was nobody else to have seated them.
UPDATE "users" SET "platform_role" = 'OWNER'
  WHERE "is_platform_admin" IS TRUE AND "platform_role" IS NULL;

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_platform_role_matches_flag";
ALTER TABLE "users" ADD CONSTRAINT "users_platform_role_matches_flag" CHECK (
  ("is_platform_admin" IS TRUE AND "platform_role" IS NOT NULL)
  OR
  ("is_platform_admin" IS NOT TRUE AND "platform_role" IS NULL)
);

/*
 * The second factor. **Required for every operator**, which is enforced at the login rather than
 * here: a NOT NULL secret would make it impossible to create the account that is about to enrol.
 *
 * The secret is base32 and is a credential — `platform_operator_directory()` below cannot return it,
 * by return type, for the same reason `platform_clinic_counts()` cannot return a patient name.
 */
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_secret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "totp_confirmed_at" TIMESTAMPTZ(6);

-- A confirmed authenticator with no secret cannot be checked against anything, so it would be a
-- second factor that always passes. The CHECK is the only thing that makes "confirmed" mean it.
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_totp_confirmed_needs_secret";
ALTER TABLE "users" ADD CONSTRAINT "users_totp_confirmed_needs_secret"
  CHECK ("totp_confirmed_at" IS NULL OR "totp_secret" IS NOT NULL);

-- ============================================================================
-- WHO MAY READ THE BACK OFFICE
-- ============================================================================
--
-- One function, so the three policies below cannot drift apart. SECURITY DEFINER because the
-- policy has to read `users` to answer, and STABLE because it is called once per row.

CREATE OR REPLACE FUNCTION is_active_platform_admin() RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM users u
    WHERE u.id = NULLIF(current_setting('app.current_actor_id', true), '')::uuid
      AND u.is_platform_admin IS TRUE
      AND u.status = 'ACTIVE'
  );
$$;

REVOKE ALL ON FUNCTION is_active_platform_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_active_platform_admin() TO clinic_os_app;

COMMENT ON FUNCTION is_active_platform_admin() IS
  'Whether the bound actor is an ACTIVE platform admin. The single predicate behind every '
  'back-office RLS policy, so the three cannot drift apart.';

-- ============================================================================
-- (b) THE CLIENT FILE
-- ============================================================================

CREATE TABLE IF NOT EXISTS "platform_clinic_files" (
  "id"                   UUID PRIMARY KEY,
  "tenant_id"            UUID NOT NULL REFERENCES "tenants"("id"),
  -- An operator, not a clinic user. Nullable: an account can exist before anyone owns it, and
  -- pretending otherwise would make the first save require a decision nobody has taken yet.
  "sales_owner_user_id"  UUID REFERENCES "users"("id"),
  -- What was sold, in the words used on the call. The computed plan line stays computed
  -- (`plan.ts`, PRICING.md); this is the human agreement it is compared against.
  "agreed_plan"          TEXT,
  "agreed_monthly_minor" INTEGER,
  "discount_percent"     INTEGER,
  -- (c) The commercial state of the account, which is not `tenants.status`: a clinic can be live
  -- and OVERDUE at the same time, and switching it off is a separate act with its own reason.
  "account_status"       TEXT NOT NULL DEFAULT 'TRIAL',
  "trial_ends_on"        DATE,
  "renewal_on"           DATE,
  "notes"                TEXT,
  "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

-- One file per clinic. Two would be two answers to "what did we agree".
CREATE UNIQUE INDEX IF NOT EXISTS "platform_clinic_files_tenant_id_key"
  ON "platform_clinic_files"("tenant_id");

ALTER TABLE "platform_clinic_files" DROP CONSTRAINT IF EXISTS "platform_clinic_files_status_supported";
ALTER TABLE "platform_clinic_files" ADD CONSTRAINT "platform_clinic_files_status_supported"
  CHECK ("account_status" IN ('TRIAL', 'ACTIVE', 'OVERDUE', 'SUSPENDED'));

-- Money is integer minor units and a negative agreed price is not a discount, it is a typo.
ALTER TABLE "platform_clinic_files" DROP CONSTRAINT IF EXISTS "platform_clinic_files_amounts_sane";
ALTER TABLE "platform_clinic_files" ADD CONSTRAINT "platform_clinic_files_amounts_sane" CHECK (
  ("agreed_monthly_minor" IS NULL OR "agreed_monthly_minor" >= 0)
  AND ("discount_percent" IS NULL OR ("discount_percent" >= 0 AND "discount_percent" <= 100))
);

-- A trial that is still on has a date; the console's reminder reads it.
ALTER TABLE "platform_clinic_files" DROP CONSTRAINT IF EXISTS "platform_clinic_files_trial_is_dated";
ALTER TABLE "platform_clinic_files" ADD CONSTRAINT "platform_clinic_files_trial_is_dated"
  CHECK ("account_status" <> 'TRIAL' OR "trial_ends_on" IS NOT NULL);

CREATE TABLE IF NOT EXISTS "platform_clinic_contacts" (
  "id"         UUID PRIMARY KEY,
  "tenant_id"  UUID NOT NULL REFERENCES "tenants"("id"),
  "full_name"  TEXT NOT NULL,
  -- Free text, not an enum: "the owner's brother who pays the bills" is a real answer and no list
  -- this project could write would have it.
  "role"       TEXT,
  "phone_e164" TEXT,
  "email"      TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "platform_clinic_contacts_tenant_id_idx"
  ON "platform_clinic_contacts"("tenant_id");

-- A contact nobody can reach is not one.
ALTER TABLE "platform_clinic_contacts" DROP CONSTRAINT IF EXISTS "platform_clinic_contacts_reachable";
ALTER TABLE "platform_clinic_contacts" ADD CONSTRAINT "platform_clinic_contacts_reachable"
  CHECK ("phone_e164" IS NOT NULL OR "email" IS NOT NULL);

CREATE TABLE IF NOT EXISTS "platform_clinic_contracts" (
  "id"                  UUID PRIMARY KEY,
  "tenant_id"           UUID NOT NULL REFERENCES "tenants"("id"),
  "file_name"           TEXT NOT NULL,
  -- A storage key, never a URL — the same rule `tenants.logo_storage_key` follows and for the same
  -- reason: a column holding a URL invites somebody to hand it to a browser.
  "storage_key"         TEXT NOT NULL,
  "mime_type"           TEXT NOT NULL,
  "size_bytes"          INTEGER NOT NULL,
  "starts_on"           DATE NOT NULL,
  "ends_on"             DATE NOT NULL,
  "uploaded_by_user_id" UUID NOT NULL REFERENCES "users"("id"),
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "platform_clinic_contracts_tenant_id_idx"
  ON "platform_clinic_contracts"("tenant_id");

CREATE UNIQUE INDEX IF NOT EXISTS "platform_clinic_contracts_storage_key_key"
  ON "platform_clinic_contracts"("storage_key");

-- A contract that ends before it starts is not a term, and the renewal arithmetic downstream would
-- read it as one.
ALTER TABLE "platform_clinic_contracts" DROP CONSTRAINT IF EXISTS "platform_clinic_contracts_term_is_forward";
ALTER TABLE "platform_clinic_contracts" ADD CONSTRAINT "platform_clinic_contracts_term_is_forward"
  CHECK ("ends_on" > "starts_on");

ALTER TABLE "platform_clinic_contracts" DROP CONSTRAINT IF EXISTS "platform_clinic_contracts_has_bytes";
ALTER TABLE "platform_clinic_contracts" ADD CONSTRAINT "platform_clinic_contracts_has_bytes"
  CHECK ("size_bytes" > 0);

-- ============================================================================
-- RLS — THE OPPOSITE POLICY FROM EVERY OTHER TABLE HERE
-- ============================================================================
--
-- Not `tenant_id = <bound tenant>`. These rows are ours, and a clinic session binding its own id
-- must read **nothing**, which is what a predicate that never mentions the bound tenant gives:
-- `is_active_platform_admin()` is false for every clinic user, so the whole table is empty to them.
--
-- FORCE as well as ENABLE, as D12 requires everywhere: without it the table owner is exempt and the
-- policy is advisory.

ALTER TABLE "platform_clinic_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_clinic_files" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON "platform_clinic_files";
CREATE POLICY platform_only ON "platform_clinic_files"
  USING (is_active_platform_admin())
  WITH CHECK (is_active_platform_admin());

ALTER TABLE "platform_clinic_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_clinic_contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON "platform_clinic_contacts";
CREATE POLICY platform_only ON "platform_clinic_contacts"
  USING (is_active_platform_admin())
  WITH CHECK (is_active_platform_admin());

ALTER TABLE "platform_clinic_contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_clinic_contracts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_only ON "platform_clinic_contracts";
CREATE POLICY platform_only ON "platform_clinic_contracts"
  USING (is_active_platform_admin())
  WITH CHECK (is_active_platform_admin());

-- ============================================================================
-- AUDITING THEM — INTO NOBODY'S TENANT
-- ============================================================================
--
-- `audit-triggers.integration.spec.ts` derives its expectation structurally: a table with RLS
-- carries a `<table>_audit` trigger. These three now do, and they cannot use `audit_row_change()`,
-- which stamps the audit row with `NEW.tenant_id`.
--
-- That would be a leak, not a detail. `audit_row_change()` stores `to_jsonb(NEW)`, so the agreed
-- discount and the sales notes would land in the clinic's own trail — readable by the clinic's
-- admin on the audit screen shipped in #107. Writing `tenant_id = NULL` instead puts the row where
-- the D17 policy makes it visible to no tenant session at all, reachable only through
-- `read_orphaned_audit_logs()`, which is already the vendor's audited break-glass door.

CREATE OR REPLACE FUNCTION audit_platform_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_actor_id uuid;
  v_row      record;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;

  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION
      'Audit: refusing to write % on %.% with no actor bound', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
      USING HINT = 'Bind app.current_actor_id first. The console does this via withPlatformActor().',
            ERRCODE = 'raise_exception';
  END IF;

  IF TG_OP = 'DELETE' THEN v_row := OLD; ELSE v_row := NEW; END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(),
    -- Deliberately NULL. See the note above: this is the vendor's trail, not the clinic's.
    NULL,
    v_actor_id,
    'PLATFORM_ADMIN',
    CASE TG_OP WHEN 'INSERT' THEN 'CREATE' WHEN 'UPDATE' THEN 'UPDATE' ELSE 'DELETE' END::"AuditAction",
    TG_TABLE_NAME,
    v_row.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION audit_platform_row_change() IS
  'Audits the back-office tables into audit_logs with tenant_id NULL, so the vendor''s commercial '
  'notes about a clinic never appear in that clinic''s own audit trail.';

DROP TRIGGER IF EXISTS platform_clinic_files_audit ON "platform_clinic_files";
CREATE TRIGGER platform_clinic_files_audit
  AFTER INSERT OR UPDATE OR DELETE ON "platform_clinic_files"
  FOR EACH ROW EXECUTE FUNCTION audit_platform_row_change();

DROP TRIGGER IF EXISTS platform_clinic_contacts_audit ON "platform_clinic_contacts";
CREATE TRIGGER platform_clinic_contacts_audit
  AFTER INSERT OR UPDATE OR DELETE ON "platform_clinic_contacts"
  FOR EACH ROW EXECUTE FUNCTION audit_platform_row_change();

DROP TRIGGER IF EXISTS platform_clinic_contracts_audit ON "platform_clinic_contracts";
CREATE TRIGGER platform_clinic_contracts_audit
  AFTER INSERT OR UPDATE OR DELETE ON "platform_clinic_contracts"
  FOR EACH ROW EXECUTE FUNCTION audit_platform_row_change();

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_clinic_files" TO clinic_os_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_clinic_contacts" TO clinic_os_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_clinic_contracts" TO clinic_os_app;

-- ============================================================================
-- THE VENDOR'S OWN TRAIL
-- ============================================================================
--
-- `recordOperatorAction` (0f) writes into the clinic's trail, deliberately: suspending a clinic or
-- resetting its admin's password is something that clinic's administrator should be able to see.
-- Seating an operator is not — it names no clinic, and there is no tenant to bind.
--
-- `audit_logs` carries `WITH CHECK (tenant_id = <bound tenant>)`, and `clinic_os_app` is NOBYPASSRLS
-- (D12), so an unbound INSERT of a NULL-tenant row is refused from the application. This is the
-- narrow, named exception: SECURITY DEFINER, refusing any caller who is not an ACTIVE platform
-- admin, and unable to write a row belonging to a tenant — `tenant_id` is hard-coded NULL and is not
-- a parameter, so this cannot be turned into a way to forge a clinic's history.

CREATE OR REPLACE FUNCTION record_platform_audit(
  p_action "AuditAction",
  p_entity_type text,
  p_entity_id uuid,
  p_detail jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'record_platform_audit() requires a bound actor'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT is_active_platform_admin() THEN
    RAISE EXCEPTION 'record_platform_audit() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  INSERT INTO audit_logs (
    id, tenant_id, actor_user_id, actor_role, action,
    entity_type, entity_id, previous_state, new_state, ip_address, user_agent, created_at
  )
  VALUES (
    uuid_generate_v7(), NULL, v_actor_id, 'PLATFORM_ADMIN', p_action,
    p_entity_type, p_entity_id, NULL, p_detail,
    COALESCE(NULLIF(current_setting('app.current_ip', true), ''), 'unknown'),
    COALESCE(NULLIF(current_setting('app.current_user_agent', true), ''), 'unknown'),
    now()
  );
END;
$$;

REVOKE ALL ON FUNCTION record_platform_audit("AuditAction", text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_platform_audit("AuditAction", text, uuid, jsonb) TO clinic_os_app;

COMMENT ON FUNCTION record_platform_audit("AuditAction", text, uuid, jsonb) IS
  'One audit row for an operator action that belongs to no clinic. tenant_id is hard-coded NULL '
  'rather than taken as a parameter, so this cannot write into a clinic''s own history.';

-- ============================================================================
-- THE OPERATOR DIRECTORY — NAMES AND ROLES, NEVER A SECRET
-- ============================================================================
--
-- The same shape as `platform_clinic_counts()`: a function whose RETURN TYPE cannot be widened into
-- a credential without a signature change somebody has to review. `totp_secret` and `password_hash`
-- are not in it, and cannot be added to it by accident.

CREATE OR REPLACE FUNCTION platform_operator_directory()
RETURNS TABLE (
  user_id uuid,
  full_name text,
  phone_e164 text,
  platform_role text,
  status "UserStatus",
  totp_enrolled boolean,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'platform_operator_directory() requires a bound actor'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NOT is_active_platform_admin() THEN
    RAISE EXCEPTION 'platform_operator_directory() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT u.id, u.full_name, u.phone_e164, u.platform_role, u.status,
         u.totp_confirmed_at IS NOT NULL, u.created_at
    FROM users u
   WHERE u.is_platform_admin IS TRUE
   ORDER BY u.created_at;
END;
$$;

REVOKE ALL ON FUNCTION platform_operator_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_operator_directory() TO clinic_os_app;

COMMENT ON FUNCTION platform_operator_directory() IS
  'The vendor''s own people, for the console''s operators screen. Names, roles and whether a second '
  'factor is enrolled — never the secret, and never a password hash, by return type.';

SELECT set_config('app.current_actor_id', '', false);
