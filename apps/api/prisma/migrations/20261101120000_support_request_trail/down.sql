-- Reverses 20261101120000_support_request_trail, only while nothing has been done under a support session: once it has, dropping
-- these columns and this record would erase who acted and who approved, and the next up would fail on the rows left behind.
DO $$
BEGIN
  IF NOT (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user) THEN
    RAISE EXCEPTION 'support request trail down: % cannot see past RLS, so the emptiness check would see nothing. Run it as the migration superuser.', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM audit_logs WHERE support_session_id IS NOT NULL) OR EXISTS (SELECT 1 FROM support_session_requests) THEN
    RAISE EXCEPTION 'support request trail down: work has been recorded under a support session. Reversing would erase both identities from the audit trail.';
  END IF;
END $$;
DROP FUNCTION record_support_request(uuid, uuid, uuid, integer, text, text);
DROP TABLE support_session_requests;

DROP TRIGGER audit_logs_support_identities ON audit_logs;
DROP FUNCTION stamp_support_identities();
DROP INDEX audit_logs_support_session_id_idx;
ALTER TABLE audit_logs DROP CONSTRAINT audit_logs_support_role, DROP CONSTRAINT audit_logs_support_both_identities;
ALTER TABLE audit_logs DROP COLUMN support_approver_id, DROP COLUMN support_session_id;

DELETE FROM _prisma_migrations WHERE migration_name = '20261101120000_support_request_trail';
