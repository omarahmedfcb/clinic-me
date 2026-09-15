-- Phase 1, Checkpoint 3 — resolves a contradiction between two guarantees (SCHEMA-DECISIONS.md
-- D18, amending D17).
--
-- audit_logs.tenant_id carried ON DELETE SET NULL. Setting it to NULL is an UPDATE, and the D5
-- append-only trigger refuses UPDATE on audit_logs unconditionally, for every role, with no
-- override. The two cannot both hold. Observed, not theorised: deleting a tenant whose tables are
-- empty but whose audit history is not fails with
--
--     P0001  Table audit_logs is append-only
--
-- with no constraint name and no table attached, because it is a bare RAISE EXCEPTION from
-- forbid_mutation() rather than a foreign-key violation. Someone deleting a tenant is told the
-- audit table is append-only, which says nothing about what they actually did wrong.
--
-- That state is ordinary, not exotic: an audit row exists for every write to any of the 29
-- scoped tables, and those rows survive the deletion of the row they describe. A clinic that
-- registered a patient and later deleted them is already in it.
--
-- Resolution: RESTRICT, matching the 29 other tenant_id foreign keys in this schema. The
-- guarantee that changes is the weaker and more recently added one -- SET NULL was Prisma's
-- default for an optional relation, never a decision -- and D14 had already concluded that
-- deleting a tenant is not the mechanism for offboarding one. This makes the schema say what D14
-- concluded, rather than leaving a contradicting FK action in place that could never fire.
--
-- RESTRICT rather than NO ACTION deliberately. The two differ only in that NO ACTION defers its
-- check to end of statement, which exists to let a statement delete the referencing rows itself
-- -- precisely what append-only forbids here. NO ACTION would buy nothing and would make this the
-- one tenant_id foreign key in the schema shaped differently from its 29 siblings.
--
-- tenant_id stays nullable. NULL remains meaningful, and is now reachable only from
-- read_orphaned_audit_logs()'s own BREAK_GLASS_ACCESS rows (platform-level events belonging to no
-- tenant) and from whatever future anonymisation process D14 calls for. What it no longer means
-- is "a tenant row was deleted out from under this one", which was never achievable.

ALTER TABLE audit_logs DROP CONSTRAINT "audit_logs_tenant_id_fkey";

ALTER TABLE audit_logs
  ADD CONSTRAINT "audit_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
