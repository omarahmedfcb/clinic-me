-- Two additions for the finished WhatsApp bot: complaints ("شكوى"), and a durable slot for the
-- bot's own code-driven step machine (whatsapp-flow.ts) on the conversation it belongs to.

-- ---------------------------------------------------------------------------------------------
-- Conversation.flowState -- opaque JSON, read and written by the WhatsApp bot's step machine only,
-- never by the model. Nullable: a conversation with no bot turn yet (or a webchat conversation)
-- simply has none.
ALTER TABLE conversations ADD COLUMN flow_state jsonb;

-- ---------------------------------------------------------------------------------------------
-- Complaints. Free text only -- no category, no severity -- the founder's call for this pass.
-- Same tenant-isolation + audit shape as every other clinic-owned table (patient_allergies is the
-- template this follows).

CREATE TYPE "ComplaintStatus" AS ENUM (
  'OPEN',
  'RESOLVED'
);

CREATE TABLE complaints (
  id                   uuid PRIMARY KEY,
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  patient_id           uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  -- Short and human-readable -- read back to the patient over WhatsApp, so it has to be something
  -- a patient can plausibly quote back over the phone later. Uniqueness is per clinic: two clinics
  -- may hand out the same short code without colliding.
  reference_number     text NOT NULL,
  description          text NOT NULL,
  status                "ComplaintStatus" NOT NULL DEFAULT 'OPEN',
  source               "AppointmentSource" NOT NULL,
  consent_message_id   text,
  resolved_by_user_id  uuid REFERENCES users(id),
  resolved_at          timestamptz(6),
  created_at           timestamptz(6) NOT NULL DEFAULT now(),
  updated_at           timestamptz(6) NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX complaints_tenant_id_reference_number_key
  ON complaints (tenant_id, reference_number);

CREATE INDEX complaints_tenant_id_status_created_at_idx
  ON complaints (tenant_id, status, created_at);

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON complaints
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON complaints TO clinic_os_app;

-- The audit trigger is NOT optional and NOT automatic (07-audit-triggers.sql's own header) -- a
-- complaint's description can carry what a patient said about a doctor or a staff member, and a
-- silent edit or deletion of that is exactly the gap patient_allergies_audit exists to close.
CREATE TRIGGER complaints_audit
  AFTER INSERT OR UPDATE OR DELETE ON complaints
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
