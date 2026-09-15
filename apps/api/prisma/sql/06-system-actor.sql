-- Phase 1, Checkpoint 3 — the system actor: a real user row that unattended processes write as.
--
-- SCHEMA-DECISIONS.md D16 settles that the audit trigger raises when no actor is bound, and that
-- "raise on nothing" and "a named account for unattended writes" answer two different questions.
-- The first catches an oversight. The second gives a genuine non-human operation a real,
-- auditable identity -- ARCHITECTURE.md §9's nightly no-show auto-marking job is the concrete
-- case that needs one, and seed scripts and data migrations are the same shape of problem.
--
-- Three properties, each deliberate:
--
-- 1. A REAL ROW, not a constant in application code and not NULL-with-special-meaning. Every
--    consumer of audit_logs can join actor_user_id -> users and get a name back, with no branch
--    for "unless it's the system one." audit_logs.actor_user_id is a NOT NULL foreign key into
--    this table; a NULL sentinel would have required weakening that, and a TypeScript constant
--    would have been invisible to it entirely.
--
-- 2. A WELL-KNOWN ID, fixed here in the migration, which is what makes (1) usable. It is
--    UUIDv7-shaped so it does not become the one id in the database that violates D6: the
--    timestamp field is 2026-01-01T00:00:00Z and the random field is replaced with a recognisably
--    reserved constant, so it reads as deliberate rather than generated. Application code must
--    resolve it through system_actor_id() below rather than repeating the literal.
--
-- 3. IT CANNOT LOG IN. An account authorised to write to every table, that can also authenticate,
--    is a backdoor. Two independent things prevent it, either of which would be sufficient:
--    status is LOCKED (verifyCredentials() in modules/auth/user-lookup.ts returns null for any
--    user not ACTIVE), and password_hash holds a sentinel that is not a parseable Argon2 encoding,
--    so no password can ever verify against it. The column is NOT NULL, so a sentinel is the
--    available way to express "no password hash"; making the column nullable to hold this one row
--    would have weakened the schema for every real user.
--
-- phone_e164 is UNIQUE NOT NULL and must therefore hold something. +20000000000 is in Egypt's
-- country code but is not an allocatable subscriber number, so it cannot collide with a real
-- clinic user's phone.

INSERT INTO users (id, email, phone_e164, password_hash, full_name, is_platform_admin, status, created_at, updated_at)
VALUES (
  '019b76da-a800-7000-8000-000000000001',
  NULL,
  '+20000000000',
  'no-login:system-actor',
  'System',
  false,
  'LOCKED',
  now(),
  now()
)
ON CONFLICT (id) DO NOTHING;

-- The single source of truth for the id above. Application code calls this rather than repeating
-- the literal, so the migration stays the only place the value is written down.
CREATE OR REPLACE FUNCTION system_actor_id() RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '019b76da-a800-7000-8000-000000000001'::uuid
$$;

GRANT EXECUTE ON FUNCTION system_actor_id() TO clinic_os_app;

COMMENT ON FUNCTION system_actor_id() IS
  'The well-known users.id that unattended processes (the nightly no-show job, seeds, data '
  'migrations) authenticate as before writing. The row cannot log in: status LOCKED and a '
  'sentinel password_hash. See SCHEMA-DECISIONS.md D16.';
