-- Phase 2 — notifications. PHASE-2.md §16.
--
-- Two tables, and the interesting decisions are about why they are not one, and why neither is
-- `audit_logs`.
--
--
-- WHY NOT audit_logs
--
-- It already records every mutation with an actor, a tenant and a timestamp, so it looks like a
-- free notification feed. Four reasons it cannot be one:
--
--   1. It is append-only by trigger (D5). Read state is a mutation, so a read_at column there
--      could never be written -- read state would need a second table keyed by audit-row id, at
--      which point the second table exists anyway, in a worse shape.
--   2. It is written by a trigger, which knows a row changed but not WHY. A reschedule and a
--      cancellation are both UPDATE on appointments, so telling them apart means diffing
--      previous_state against new_state -- a second, weaker copy of the state machine that
--      transition() already owns.
--   3. Its JSONB columns are whole-row snapshots, so a visit's diagnosis is in there. Anything
--      reading audit_logs to render a UI is one careless select from putting clinical content in
--      a reception notification.
--   4. Retention differs. Audit rows are kept because a regulator may ask; notifications are
--      prunable UI state. Coupling them means keeping notifications forever or making the audit
--      trail deletable.
--
--
-- WHY READ STATE IS A SEPARATE TABLE, AND PER MEMBERSHIP
--
-- One notification has many recipients -- reception, admin and the doctor may all see one booking
-- -- and a single read_at column cannot hold three people's read state.
--
-- Per MEMBERSHIP, not per user: a person can hold memberships in two clinics (ARCHITECTURE.md §4;
-- the seeded دينا does), so per-user read state would mark a notification read at one clinic by
-- reading it at the other.

CREATE TYPE "NotificationKind" AS ENUM (
  'APPOINTMENT_BOOKED',
  'APPOINTMENT_CANCELLED',
  'APPOINTMENT_RESCHEDULED'
);

CREATE TABLE notifications (
  id             uuid NOT NULL,
  tenant_id      uuid NOT NULL,
  kind           "NotificationKind" NOT NULL,
  appointment_id uuid,
  patient_id     uuid,
  actor_user_id  uuid NOT NULL,
  source         "AppointmentSource" NOT NULL,
  occurred_at    timestamptz(6) NOT NULL,
  payload        jsonb NOT NULL,
  created_at     timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notifications_pkey PRIMARY KEY (id)
);

CREATE INDEX "notifications_tenant_id_occurred_at_idx" ON notifications (tenant_id, occurred_at);

ALTER TABLE notifications
  ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notifications_appointment_id_fkey" FOREIGN KEY (appointment_id)
    REFERENCES appointments (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notifications_patient_id_fkey" FOREIGN KEY (patient_id)
    REFERENCES patients (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notifications_actor_user_id_fkey" FOREIGN KEY (actor_user_id)
    REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN notifications.payload IS
  'Only what the notification list renders -- a display name, a time. NEVER clinical content: this '
  'is read by reception, and CLAUDE.md separates clinical content by endpoint and DTO rather than '
  'by remembering to leave it out of a JSONB blob.';

CREATE TABLE notification_reads (
  id              uuid NOT NULL,
  tenant_id       uuid NOT NULL,
  notification_id uuid NOT NULL,
  membership_id   uuid NOT NULL,
  read_at         timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT notification_reads_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX "notification_reads_notification_id_membership_id_key"
  ON notification_reads (notification_id, membership_id);
CREATE INDEX "notification_reads_tenant_id_membership_id_idx"
  ON notification_reads (tenant_id, membership_id);

ALTER TABLE notification_reads
  ADD CONSTRAINT "notification_reads_tenant_id_fkey" FOREIGN KEY (tenant_id)
    REFERENCES tenants (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notification_reads_notification_id_fkey" FOREIGN KEY (notification_id)
    REFERENCES notifications (id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "notification_reads_membership_id_fkey" FOREIGN KEY (membership_id)
    REFERENCES memberships (id) ON DELETE RESTRICT ON UPDATE CASCADE;


-- ============================================================================
-- RLS — both tables, the ordinary fail-closed shape (D15)
-- ============================================================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notifications
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_reads
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- ============================================================================
-- AUDIT — notifications yes, notification_reads NO
-- ============================================================================
--
-- `notifications` gets the standard trigger: a row appearing is a real event in the clinic's
-- history and its creation is worth recording.
--
-- `notification_reads` is deliberately EXEMPT, and this is the one decision in this file that
-- needs to be a decision rather than an omission. Marking something read is a write, and D16
-- audits every write without degrading -- so opening the bell would insert an audit row per
-- notification per glance. A receptionist opening it twenty times a day would generate more audit
-- traffic than the clinic's actual clinical work, burying the trail this project keeps precisely
-- so that it can be read.
--
-- The exemption is on the same reasoning that exempts `audit_logs` itself: this table records that
-- someone LOOKED, not that anything changed. Nothing here alters a patient's record, a booking or
-- money, and D16's purpose is attributing changes to those.
--
-- `audit-triggers.integration.spec.ts` derives its expectation from "has RLS", so its exclusion
-- list is updated in the same commit -- otherwise this exemption would look like a forgotten
-- table rather than a considered one.

CREATE TRIGGER notifications_audit
  AFTER INSERT OR UPDATE OR DELETE ON notifications
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
