-- The platform console — pilot-readiness 0b–0g.
--
-- The operator must see **how many** patients a clinic has and never **which**. That cannot be a
-- promise the service keeps: an operator session is unbound, so RLS already returns zero rows from
-- `patients`, and the obvious way to get a count anyway — bind each tenant in turn — would hand the
-- operator the clinic's whole record as a side effect.
--
-- So the counts come from a function whose RETURN TYPE physically cannot carry a name, a diagnosis
-- or an amount. Same shape as `read_orphaned_audit_logs` (08-audit-logs-rls.sql): SECURITY DEFINER,
-- owned by the migration superuser, refusing any caller who is not an ACTIVE platform admin, with
-- the actor read from the session rather than taken as a parameter so a caller cannot name someone
-- else as the reader.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

/*
 * The clinic's country — the parsing hint `ARCHITECTURE.md` §18b already assumes exists.
 *
 * "Phone numbers: libphonenumber with **the tenant's country** as the parsing hint" has been the
 * written rule since Phase 1, and there was no column to read it from: every caller fell back to
 * `DEFAULT_PHONE_COUNTRY`, one process-wide value, which is exactly the "never assume +20" that
 * `CLAUDE.md` forbids — it just assumed it in one place instead of many. Creating clinics from a
 * console is what makes that unsurvivable: two clinics in one deployment can be in two countries.
 *
 * Backfilled to EG explicitly rather than by DEFAULT, so the value is a statement about the two
 * existing Egyptian clinics rather than a default that silently applies to the next row.
 */
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "country" TEXT;
UPDATE "tenants" SET "country" = 'EG' WHERE "country" IS NULL;
ALTER TABLE "tenants" ALTER COLUMN "country" SET NOT NULL;

ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_country_is_supported";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_country_is_supported"
  CHECK ("country" IN ('EG', 'SA', 'AE'));

-- A reason is required to suspend, and it is kept. "Why is this clinic switched off" is the
-- question somebody asks months later, and `tenants.status` alone cannot answer it.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspension_reason" TEXT;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMPTZ(6);

-- Both are set together or neither is. A suspended clinic with no reason is the row this column
-- exists to prevent, and a reason left behind after reactivation misreports a live clinic.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_suspension_is_explained";
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_suspension_is_explained" CHECK (
  ("status" <> 'SUSPENDED' AND "suspension_reason" IS NULL AND "suspended_at" IS NULL)
  OR
  ("status" = 'SUSPENDED' AND "suspension_reason" IS NOT NULL
    AND length(btrim("suspension_reason")) > 0 AND "suspended_at" IS NOT NULL)
);

/*
 * Per-clinic aggregates for the console's list. **Counts and instants only.**
 *
 * Returning a composite of scalars rather than rows is the point: there is no field here that a
 * later change could quietly widen into a patient name without altering the signature, which is a
 * reviewable event. `security_invoker` is deliberately NOT used — the whole purpose is to read
 * across tenants, which is exactly what every RLS policy forbids the caller.
 */
CREATE OR REPLACE FUNCTION platform_clinic_counts()
RETURNS TABLE (
  tenant_id uuid,
  patients integer,
  doctors integer,
  staff integer,
  appointments_this_month integer,
  last_activity timestamptz
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
    RAISE EXCEPTION 'platform_clinic_counts() requires a bound actor'
      USING HINT = 'Call it inside withPlatformActor(). See SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin
  FROM users u WHERE u.id = v_actor_id;

  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_clinic_counts() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT t.id,
         (SELECT count(*)::int FROM patients p WHERE p.tenant_id = t.id),
         (SELECT count(*)::int FROM doctors d WHERE d.tenant_id = t.id),
         (SELECT count(*)::int FROM memberships m WHERE m.tenant_id = t.id AND m.status = 'ACTIVE'),
         (SELECT count(*)::int FROM appointments a
           WHERE a.tenant_id = t.id
             AND a.scheduled_start >= date_trunc('month', now())),
         (SELECT max(a.scheduled_start) FROM appointments a WHERE a.tenant_id = t.id)
    FROM tenants t;
END;
$$;

REVOKE ALL ON FUNCTION platform_clinic_counts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_clinic_counts() TO clinic_os_app;

COMMENT ON FUNCTION platform_clinic_counts() IS
  'Per-clinic aggregates for the platform console. Counts and instants only, by return type. '
  'Refuses any caller that is not an ACTIVE platform admin, reading the actor from the session.';

/*
 * Who the operator may issue a temporary password to — 0e. **ADMIN and OWNER only, by the WHERE
 * clause**, so a doctor's account, the one whose login reaches clinical content, is not in the
 * result set at all rather than filtered out of it afterwards.
 *
 * Names of a clinic's own administrators, which the operator needs to do the job the console exists
 * for. No patient appears here, and the return type cannot be widened into one silently.
 */
CREATE OR REPLACE FUNCTION platform_clinic_admins()
RETURNS TABLE (tenant_id uuid, user_id uuid, full_name text, role "MembershipRole")
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
    RAISE EXCEPTION 'platform_clinic_admins() requires a bound actor'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin
  FROM users u WHERE u.id = v_actor_id;

  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_clinic_admins() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT m.tenant_id, u.id, u.full_name, m.role
    FROM memberships m
    JOIN users u ON u.id = m.user_id
   WHERE m.status = 'ACTIVE'
     AND m.role IN ('ADMIN', 'OWNER');
END;
$$;

REVOKE ALL ON FUNCTION platform_clinic_admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_clinic_admins() TO clinic_os_app;

COMMENT ON FUNCTION platform_clinic_admins() IS
  'Clinic administrators, for the platform console''s password-reset path. ADMIN and OWNER only: a '
  'doctor''s account is not in the result set, because that is the login that reaches clinical content.';

SELECT set_config('app.current_actor_id', '', false);
