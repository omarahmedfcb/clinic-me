-- Phase 1, Checkpoint 3 — extends RLS from the 12 clinical/financial tables in 01-constraints.sql
-- (D4) to the remaining 17 tenant-scoped tables. See SCHEMA-DECISIONS.md D15 for the full
-- reasoning; summary: D4's boundary was "is this data sensitive," which is the wrong question.
-- The right one is "is there a second layer if the application layer fails." Every tenant-scoped
-- table needs that second layer, not just the clinically/financially sensitive ones -- Layer 2
-- (the Prisma tenant-scoping extension) is application code, and application code has bugs.
--
-- Tenant, User, and RefreshToken are NOT included here. They are genuinely cross-tenant by
-- design (Tenant IS a tenant; User and RefreshToken are scoped indirectly through Membership) --
-- see tenant-scoped-models.ts's "none" classification. AuditLog and MessageTemplate are also not
-- included: both have a nullable tenantId where NULL is a meaningful, deliberate value (a
-- platform-wide MessageTemplate, an AuditLog row surviving tenant deletion via ON DELETE SET
-- NULL) -- the same RLS predicate used everywhere else here would make those legitimately-null
-- rows invisible to every tenant-scoped session, which is a different problem needing its own
-- design, not a mechanical copy-paste of this file.
--
-- Same policy shape as 01-constraints.sql, verbatim: ENABLE + FORCE (without FORCE, the table
-- owner -- the role migrations run as -- bypasses RLS entirely, D4), USING + WITH CHECK (USING
-- alone would still let a session write a row stamped with another tenant's id), and
-- NULLIF(current_setting(...), '')::uuid rather than a bare cast (an unset session variable
-- fails closed -- zero rows visible, zero rows writable -- instead of throwing or matching).

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointments
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE appointment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointment_events
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE doctors ENABLE ROW LEVEL SECURITY;
ALTER TABLE doctors FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON doctors
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE services ENABLE ROW LEVEL SECURITY;
ALTER TABLE services FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON services
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE schedule_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedule_templates
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE schedule_breaks ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_breaks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedule_breaks
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE schedule_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedule_exceptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON schedule_exceptions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contacts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE followup_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_tasks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON followup_tasks
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON messages
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_records
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Not in the founder's list -- flagged, not silently added or dropped: usage_alerts has a
-- required (non-nullable) tenant_id, exactly like usage_records above, which is on the list.
-- Same "is there a second layer" reasoning applies identically. Included on that basis; revert
-- this one block if the omission from the original list was deliberate rather than an oversight.
ALTER TABLE usage_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_alerts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON usage_alerts
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscriptions
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE access_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access_grants
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
