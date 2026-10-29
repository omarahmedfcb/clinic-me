-- Three read-only lookups for the platform console and the clinic sign-in, all SECURITY DEFINER and
-- owned by clinic_os_definer like every helper since 20260918080000.
--
--   1. platform_whatsapp_states()      which clinics have a WhatsApp connection, and in what state.
--                                      Operator-only (the actor is checked), because the answer spans tenants.
--   2. subscription_end_for_tenant()   the clinic's renewal date, for the in-app "subscription ends in N days"
--                                      banner. platform_clinic_files is operator-only under RLS, so a clinic
--                                      session cannot read it directly.
--   3. user_has_expired_subscription() whether a person who just proved their password belongs to a clinic that
--                                      was suspended because its subscription expired, so the sign-in screen can
--                                      say so instead of "invalid credentials".
-- Everything is safe to run twice.

GRANT SELECT ON platform_clinic_files TO clinic_os_definer;

DROP POLICY IF EXISTS definer_reads ON platform_clinic_files;
CREATE POLICY definer_reads ON platform_clinic_files
  FOR SELECT TO clinic_os_definer USING (true);

-- ---------------------------------------------------------------------------------------------
-- 1. The console's WhatsApp badges.
-- Returns the connection's status and the number shown on it. Never a token, a secret or a credential id.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION platform_whatsapp_states()
RETURNS TABLE (
  tenant_id uuid,
  status text,
  display_phone_number text
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
    RAISE EXCEPTION 'platform_whatsapp_states() requires a bound actor'
      USING HINT = 'Call it inside withPlatformActor(). See SCHEMA-DECISIONS.md D16.',
            ERRCODE = 'raise_exception';
  END IF;

  SELECT u.is_platform_admin AND u.status = 'ACTIVE' INTO v_is_admin
  FROM users u WHERE u.id = v_actor_id;

  IF v_is_admin IS NOT TRUE THEN
    RAISE EXCEPTION 'platform_whatsapp_states() refused: actor % is not an active platform admin', v_actor_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT c.tenant_id, c.status, c.display_phone_number
    FROM whatsapp_connections c;
END;
$$;

REVOKE ALL ON FUNCTION platform_whatsapp_states() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_whatsapp_states() TO clinic_os_app;
ALTER FUNCTION platform_whatsapp_states() OWNER TO clinic_os_definer;

COMMENT ON FUNCTION platform_whatsapp_states() IS
  'Connection status and displayed number per clinic, for the console badges. '
  'Refuses any caller that is not an ACTIVE platform admin, reading the actor from the session.';

-- ---------------------------------------------------------------------------------------------
-- 2. The clinic's own renewal date. Called with the tenant id from the validated token only.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION subscription_end_for_tenant(p_tenant_id uuid)
RETURNS date
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT f.renewal_on FROM platform_clinic_files f WHERE f.tenant_id = p_tenant_id;
$$;

REVOKE ALL ON FUNCTION subscription_end_for_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION subscription_end_for_tenant(uuid) TO clinic_os_app;
ALTER FUNCTION subscription_end_for_tenant(uuid) OWNER TO clinic_os_definer;

-- ---------------------------------------------------------------------------------------------
-- 3. "Your clinic's subscription expired", for someone whose password was already verified.
-- The reason string is the one the expiry job writes (subscription-expiry.ts).
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION user_has_expired_subscription(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM memberships m
    JOIN tenants t ON t.id = m.tenant_id
    WHERE m.user_id = p_user_id
      AND m.status = 'ACTIVE'
      AND t.status = 'SUSPENDED'
      AND t.suspension_reason = 'SUBSCRIPTION_EXPIRED'
  );
$$;

REVOKE ALL ON FUNCTION user_has_expired_subscription(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION user_has_expired_subscription(uuid) TO clinic_os_app;
ALTER FUNCTION user_has_expired_subscription(uuid) OWNER TO clinic_os_definer;
