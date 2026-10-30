-- The outbound worker (clinic-os-outbound) runs as the SYSTEM actor, and platform_clinic_files is
-- readable only by an ACTIVE platform admin (policy platform_only). Read directly, the worker saw NO
-- files, so it judged every clinic to have no subscription range and paused its bot a few seconds
-- after it was created -- and it could never have found an expired subscription either.
--
-- This function is the worker's one way in: every clinic's range, as text, and nothing else. It refuses
-- any caller that is not the system actor, so a clinic or operator session cannot use it to read
-- other clinics' dates. A file written before the start day existed (end day only) reports the clinic's
-- creation day as its start, so it keeps working exactly as before. Safe to run twice.

CREATE OR REPLACE FUNCTION subscription_ranges_for_worker()
RETURNS TABLE (
  tenant_id uuid,
  starts_on text,
  ends_on text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor_id uuid;
BEGIN
  v_actor_id := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF v_actor_id IS NULL OR v_actor_id IS DISTINCT FROM system_actor_id() THEN
    RAISE EXCEPTION 'subscription_ranges_for_worker() is for the system actor only'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    f.tenant_id,
    COALESCE(f.subscription_starts_on, LEAST(t.created_at::date, f.renewal_on))::text,
    f.renewal_on::text
  FROM platform_clinic_files f
  JOIN tenants t ON t.id = f.tenant_id
  WHERE f.renewal_on IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION subscription_ranges_for_worker() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION subscription_ranges_for_worker() TO clinic_os_app;
ALTER FUNCTION subscription_ranges_for_worker() OWNER TO clinic_os_definer;

COMMENT ON FUNCTION subscription_ranges_for_worker() IS
  'Every clinic''s subscription range as YYYY-MM-DD text, for the outbound worker. System actor only.';
