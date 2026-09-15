-- Phase 3 — patient transfers. `PHASE-3.md` Q16, Q17, Q21; `SCHEMA-DECISIONS.md` D24.
--
-- Moving a patient's ongoing care from one doctor to another, and what the receiving doctor may
-- then read. This is the first deliberate exception to CLAUDE.md's doctor-only clinical rule.
--
--
-- THERE IS NO EXPIRY COLUMN, AND THAT IS THE POINT
--
-- A grant is active when `status = 'ACCEPTED'` AND `now() < decided_at + the window`. That
-- comparison is made on every read. Nothing stores "expired" and no job writes it.
--
-- The founder's reasoning (D24): "a column updated by a job that doesn't exist yet would have meant
-- access never expiring, and nothing would have told us. Computing it at read time means the
-- guarantee holds from day one."
--
-- **If you are here to add a nightly job that marks grants expired, read D24 first.** That job is
-- not an optimisation; it reintroduces exactly the failure this design removes -- a status column
-- flipped by a sweep looks like expiry, tests green against it, and grants access forever if the
-- sweep is never written or silently dies, with absence as the only symptom.
--
--
-- FOUR TERMINAL STATES, AND THE FOURTH IS DELIBERATE
--
-- PENDING -> ACCEPTED | REJECTED | LAPSED.
--
-- LAPSED is the appointment ending -- cancelled, completed or no-showed -- while a request is still
-- open. The patient left and there is still a request waiting for an answer. It is named here so a
-- later reader can tell it was designed rather than fallen into: an unhandled fourth case and a
-- handled one look identical in a state diagram, and only one is safe to refactor.
--
-- LAPSED notifies reception exactly as REJECTED does, because a request that closes itself quietly
-- is worse than one that stays visibly open -- "a rejection that silently reverts is how a patient
-- gets forgotten in a waiting room".

CREATE TYPE "TransferStatus" AS ENUM (
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  -- The appointment ended while the request was still open. Terminal, and never re-opened: a new
  -- occasion is a new request. Re-opening would make the audit trail claim a decision was pending
  -- during a period in which nobody could have answered it.
  'LAPSED'
);

CREATE TABLE patient_transfers (
  id                         UUID PRIMARY KEY,
  tenant_id                  UUID NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  patient_id                 UUID NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,

  from_doctor_id             UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  to_doctor_id               UUID NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,

  -- The occasion. LAPSED is decided from this appointment's status, so the request has to name it;
  -- a transfer request with no occasion could never be closed by anything but a human.
  appointment_id             UUID NOT NULL REFERENCES appointments(id) ON DELETE RESTRICT,

  status                     "TransferStatus" NOT NULL DEFAULT 'PENDING',
  reason                     TEXT,

  -- Membership, not user: `doctors.membership_id` is the only login-to-doctor link, and the same
  -- human can hold memberships in two clinics.
  initiated_by_membership_id UUID NOT NULL REFERENCES memberships(id) ON DELETE RESTRICT,
  decided_by_membership_id   UUID REFERENCES memberships(id) ON DELETE RESTRICT,

  -- The instant the whole access window is measured from. NULL exactly while PENDING.
  decided_at                 TIMESTAMPTZ(6),
  decision_note              TEXT,

  created_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  -- A transfer to oneself is not a transfer.
  CONSTRAINT transfer_not_to_self CHECK (from_doctor_id <> to_doctor_id),

  -- `decided_at` is the anchor every expiry computation reads. If it could be NULL on an ACCEPTED
  -- row, the window would start at an unknown instant and the comparison would silently be
  -- `now() < NULL` -- which is NULL, which is not true, which fails closed but for the wrong
  -- reason and would be invisible. The database refuses the shape instead.
  CONSTRAINT transfer_decided_at_iff_decided CHECK (
    (status = 'PENDING' AND decided_at IS NULL AND decided_by_membership_id IS NULL)
    OR (status <> 'PENDING' AND decided_at IS NOT NULL)
  )
);

-- **At most one open request per patient.** This is the database half of the invariant the whole
-- design serves: a patient physically present appears in exactly one queue at all times. Two open
-- requests for one patient is two possible answers to "who is answerable for them", which is the
-- two-queues failure arriving by another road. The application uses compare-and-set on top of this;
-- the index is what makes the race unwinnable rather than merely unlikely.
CREATE UNIQUE INDEX patient_transfers_one_open_per_patient
  ON patient_transfers (tenant_id, patient_id)
  WHERE status = 'PENDING';

-- Reception's screen lists open requests for the clinic; both doctors' screens filter by their own
-- id. Covered by the tenant prefix.
CREATE INDEX patient_transfers_tenant_status_idx
  ON patient_transfers (tenant_id, status);

-- The access check: "does this doctor hold an active grant for this patient?" -- the hottest read
-- in the design, since it gates every clinical fetch.
CREATE INDEX patient_transfers_grant_lookup_idx
  ON patient_transfers (tenant_id, to_doctor_id, patient_id, status);

-- Closing open requests when an appointment reaches a terminal status.
CREATE INDEX patient_transfers_appointment_idx
  ON patient_transfers (tenant_id, appointment_id);

COMMENT ON TABLE patient_transfers IS
  'Patient care transfers. Access expiry is COMPUTED at read time from decided_at plus the window '
  '(SCHEMA-DECISIONS.md D24) -- there is no expiry column and no job may add one.';

COMMENT ON COLUMN patient_transfers.decided_at IS
  'The instant the access window is measured from. NULL exactly while PENDING, enforced by CHECK. '
  'Never a stored deadline: the deadline is derived on every read so no unwritten job can grant '
  'access forever.';


-- Tenant isolation, identical in shape to every other tenant-scoped table (01-constraints.sql).
-- NULLIF(...) means an unbound session variable fails closed: zero rows visible, zero writable.
ALTER TABLE patient_transfers ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_transfers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_transfers
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);


-- The audit trigger is NOT optional and NOT automatic. 07-audit-triggers.sql attaches these from a
-- literal array of table names, so a new table gets no audit trail unless it is named somewhere --
-- which is how `attachments` ended up with a gap. Who opened whose record, and when, is the entire
-- accountability story for an exception to the doctor-only rule.
CREATE TRIGGER patient_transfers_audit
  AFTER INSERT OR UPDATE OR DELETE ON patient_transfers
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
