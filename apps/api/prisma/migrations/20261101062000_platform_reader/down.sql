-- Reverses 20261101062000_platform_reader. Refuses once a clinic's trail names the platform reader: those rows need it.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE actor_user_id = '019b76da-a800-7000-8000-000000000002') THEN
    RAISE EXCEPTION 'platform reader down: clinic trails already record reads by the platform, which name this user.';
  END IF;
END $$;

DROP FUNCTION platform_reader_id();
DELETE FROM users WHERE id = '019b76da-a800-7000-8000-000000000002';

DELETE FROM _prisma_migrations WHERE migration_name = '20261101062000_platform_reader';
