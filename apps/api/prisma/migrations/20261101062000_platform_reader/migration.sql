-- Branches step 6.5 (BRANCHES-DESIGN §5, Q8 ruled 2026-10-31): an operator's read of a clinic's file is recorded in the
-- clinic's own trail as "read by the platform", without naming the person. That row needs an actor which is the platform.

-- The system actor's shape (06-system-actor.sql): it cannot log in (LOCKED, a sentinel hash), and its phone sits in the
-- range Egypt does not allocate: +20 followed by a leading 0 is never a subscriber number. test/unit guards it.
SELECT set_config('app.current_actor_id', system_actor_id()::text, false),
       set_config('app.current_user_agent', 'migration:20261101062000_platform_reader', false);
INSERT INTO users (id, email, phone_e164, password_hash, full_name, is_platform_admin, status, created_at, updated_at)
VALUES ('019b76da-a800-7000-8000-000000000002', NULL, '+20000000001', 'no-login:platform-reader', 'Platform', false, 'LOCKED', now(), now())
ON CONFLICT (id) DO NOTHING;
SELECT set_config('app.current_actor_id', '', false), set_config('app.current_user_agent', '', false);

CREATE OR REPLACE FUNCTION platform_reader_id() RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '019b76da-a800-7000-8000-000000000002'::uuid
$$;
GRANT EXECUTE ON FUNCTION platform_reader_id() TO clinic_os_app;

COMMENT ON FUNCTION platform_reader_id() IS
  'The users.id a clinic''s own audit trail names when the vendor read its file: "read by the platform", never the '
  'operator, who is named in the vendor''s trail instead. The row cannot log in: status LOCKED and a sentinel hash.';
