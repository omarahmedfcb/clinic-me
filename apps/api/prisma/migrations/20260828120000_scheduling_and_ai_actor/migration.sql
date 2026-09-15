-- Phase 2, Checkpoint 1 — PHASE-2.md §6.
--
-- Seven changes, in four groups: the scheduling policy columns, the schedule-exception rules, the
-- service buffer, and the two additions that belong to Phase 7 but are cheap only now.
--
-- Nothing here is destructive and nothing rewrites a row. Every added column has a DEFAULT, so
-- existing tenants and services keep working with the behaviour they have today.
--
--
-- ============================================================================
-- 1. SCHEDULING POLICY AS COLUMNS, NOT AS KEYS IN tenants.settings
-- ============================================================================
--
-- `tenants.settings` is JSONB and every row in it is `{}`; no shape has ever been defined. Putting
-- granularity and lead times there would be a loose type defended by a runtime guard, which is the
-- trade D20 already examined and rejected for `locale`. Columns give Prisma `number` at every call
-- site, give Postgres a CHECK, and cost one migration.
--
-- slot_granularity_minutes is server-resolved and must never become caller-overridable
-- (PHASE-2.md Q18). A caller-chosen granularity of 1 turns the availability endpoint into an
-- oracle that enumerates a doctor's whole day minute by minute.
--
-- Two lead-time columns rather than five, one per AppointmentSource: the real distinction is a
-- human standing in the clinic (RECEPTION, DOCTOR, WALK_IN) versus a remote self-service channel
-- (WHATSAPP, ONLINE). Five columns tracking five enum values would be four opportunities for them
-- to disagree about a single policy. Staff default to 0 -- booking a walk-in for right now is
-- legitimate; the agent doing it is not, hence 120.
--
-- no_show_grace_minutes is ARCHITECTURE.md §9's "clinic-configurable, default 30 min", which has
-- had no home since it was written. It goes in now rather than being invented in Phase 3 by
-- whoever writes the nightly job.

ALTER TABLE tenants
  ADD COLUMN slot_granularity_minutes    INT NOT NULL DEFAULT 15,
  ADD COLUMN booking_lead_minutes_staff  INT NOT NULL DEFAULT 0,
  ADD COLUMN booking_lead_minutes_patient INT NOT NULL DEFAULT 120,
  ADD COLUMN booking_horizon_days        INT NOT NULL DEFAULT 90,
  ADD COLUMN no_show_grace_minutes       INT NOT NULL DEFAULT 30;

-- Bounds, not preferences. A zero or negative granularity makes the slot grid non-terminating; a
-- granularity above 240 makes the engine unable to express an ordinary clinic. The upper bounds
-- exist so a typo (1440 instead of 14) is refused at the write rather than discovered as a doctor
-- with no availability.
ALTER TABLE tenants
  ADD CONSTRAINT tenants_slot_granularity_sane
    CHECK (slot_granularity_minutes BETWEEN 1 AND 240),
  ADD CONSTRAINT tenants_booking_lead_staff_sane
    CHECK (booking_lead_minutes_staff BETWEEN 0 AND 10080),
  ADD CONSTRAINT tenants_booking_lead_patient_sane
    CHECK (booking_lead_minutes_patient BETWEEN 0 AND 10080),
  ADD CONSTRAINT tenants_booking_horizon_sane
    CHECK (booking_horizon_days BETWEEN 1 AND 730),
  ADD CONSTRAINT tenants_no_show_grace_sane
    CHECK (no_show_grace_minutes BETWEEN 0 AND 1440);

COMMENT ON COLUMN tenants.slot_granularity_minutes IS
  'Slot grid step. Server-resolved only -- PHASE-2.md Q18: a caller-chosen granularity of 1 '
  'enumerates a doctor''s day minute by minute. The availability DTO must never accept it.';


-- ============================================================================
-- 2. SERVICE BUFFER
-- ============================================================================
--
-- PHASE-2.md Q20. Widens the OCCUPIED footprint of an appointment to [start, end + buffer]; the
-- BOOKABLE slot stays [start, start + duration]. The buffer belongs to the PRECEDING appointment's
-- service, not the one being booked, so occupancy queries join each appointment's own service.
--
-- Default 0 means every existing clinic behaves exactly as it does today until someone sets it.

ALTER TABLE services
  ADD COLUMN buffer_minutes INT NOT NULL DEFAULT 0;

ALTER TABLE services
  ADD CONSTRAINT services_buffer_minutes_sane CHECK (buffer_minutes BETWEEN 0 AND 240);


-- ============================================================================
-- 3. SCHEDULE EXCEPTIONS — CLINIC-WIDE ROWS, AND RULES THAT ARE CONSTRAINTS
-- ============================================================================
--
-- doctor_id becomes nullable: NULL means every doctor in the tenant (PHASE-2.md Q13). Without it,
-- HOLIDAY and BLOCKED are two names for identical behaviour, and a public holiday in a four-doctor
-- clinic is four rows -- with the fifth doctor, hired next month, inheriting none of them and
-- working Eid. Widening a column to nullable rewrites no rows and invalidates no existing data.

ALTER TABLE schedule_exceptions
  ALTER COLUMN doctor_id DROP NOT NULL;

COMMENT ON COLUMN schedule_exceptions.doctor_id IS
  'NULL means every doctor in the tenant (PHASE-2.md Q13). This is what makes HOLIDAY distinct '
  'from BLOCKED: clinic-wide versus one doctor.';

-- The time rules, as CHECKs rather than as an application convention. D5''s argument, unchanged:
-- application-only enforcement is a comment, not a guarantee.
--
--   BLOCKED / HOLIDAY      both NULL (the whole day) or both set (part of it)
--   EXTRA_AVAILABILITY     both always set -- a null window is not "all day available", it is
--                          meaningless, because there is no working day for it to add to
--
-- Note `<>` and not `<`. A window may cross midnight: PHASE-2.md Q8 rules that cross-midnight
-- sessions are supported rather than rejected, because evening clinics running past midnight are
-- ordinary in Egypt and a clinic whose real hours the system refuses to represent is a lost
-- customer. `start_time < end_time` would have forbidden exactly that. What remains meaningless
-- under either reading is a zero-length window, and that is what this rejects.

ALTER TABLE schedule_exceptions
  ADD CONSTRAINT schedule_exceptions_times_by_type CHECK (
    CASE type
      WHEN 'EXTRA_AVAILABILITY' THEN start_time IS NOT NULL AND end_time IS NOT NULL
      ELSE (start_time IS NULL) = (end_time IS NULL)
    END
  ),
  ADD CONSTRAINT schedule_exceptions_window_not_empty CHECK (
    start_time IS NULL OR end_time IS NULL OR start_time <> end_time
  );

-- Supports "every exception affecting this date", which the slot engine's fetch runs per day and
-- which now has to include clinic-wide rows (doctor_id IS NULL) alongside per-doctor ones.
CREATE INDEX schedule_exceptions_tenant_id_date_idx
  ON schedule_exceptions (tenant_id, date);


-- ============================================================================
-- 4. SCHEDULE TEMPLATES — THE CONSTRAINT THAT IS DELIBERATELY NOT `<`
-- ============================================================================
--
-- This is the one worth reading twice, because the obvious constraint is the wrong one.
--
-- `CHECK (start_time < end_time)` was proposed and OVERRULED (PHASE-2.md Q8). It would have made
-- the engine simpler at the cost of the first clinic that works 22:00-01:00 being unable to
-- describe its hours at all -- discovered during onboarding, in front of the founder. A day's
-- availability depending on the previous day's templates is complexity this project can carry.
--
-- So a template with end_time < start_time is VALID and means a session crossing midnight. What is
-- still invalid is end_time = start_time, which is either a zero-length day or a 24-hour one and
-- is not a night shift under any reading.

ALTER TABLE schedule_templates
  ADD CONSTRAINT schedule_templates_window_not_empty CHECK (start_time <> end_time);

COMMENT ON CONSTRAINT schedule_templates_window_not_empty ON schedule_templates IS
  'Deliberately <> and not <. end_time < start_time is a valid cross-midnight session '
  '(PHASE-2.md Q8); only a zero-length window is refused.';

ALTER TABLE schedule_breaks
  ADD CONSTRAINT schedule_breaks_window_not_empty CHECK (start_time <> end_time);


-- ============================================================================
-- 5. AUDIT: THE TRIGGERING MESSAGE
-- ============================================================================
--
-- ARCHITECTURE.md §12 rule 3: every AI tool call is written to audit_logs with the triggering
-- message ID. A real column rather than a key inside new_state -- it is a foreign key with
-- referential integrity, it is indexable, and "which actions did this message cause" is a question
-- an incident review will ask. NULL for every action with a human behind it, which is all of them
-- until Phase 7.
--
-- ON DELETE RESTRICT, explicitly, for the reason D18 records: Prisma's default for an optional
-- relation is SET NULL, SET NULL is an UPDATE, and the D5 append-only trigger refuses an UPDATE on
-- audit_logs unconditionally. Left defaulted, deleting a message would fail with "Table audit_logs
-- is append-only" instead of a foreign-key violation -- the same bug D18 found on tenant_id.
--
-- The direction is also right on its own terms: a message that caused an audited action can no
-- longer be deleted. The evidence outlives the convenience.

ALTER TABLE audit_logs
  ADD COLUMN message_id UUID NULL;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_message_id_fkey
    FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX audit_logs_message_id_idx ON audit_logs (message_id);

COMMENT ON COLUMN audit_logs.message_id IS
  'The WhatsApp message that triggered this action. WRITES only, by decision: ARCHITECTURE.md '
  '§12 rule 3 was amended on 2026-08-28 to "every tool call that writes", because reads leave no '
  'row here (D16 triggers fire on INSERT/UPDATE/DELETE) and auditing every availability lookup '
  'would outnumber the appointments themselves for a read that discloses nothing.';


-- ============================================================================
-- 6. THE AI_AGENT ROLE
-- ============================================================================
--
-- ARCHITECTURE.md §12 rule 2's synthetic actor. Added now because ALTER TYPE ... ADD VALUE is free
-- against a memberships table this size and awkward against a production one, and because
-- src/common/permissions.ts is keyed by this enum -- so the value's arrival forces a decision on
-- all twenty capabilities at a moment when the answer can be "none of them, deliberately".
--
-- It holds nothing. Nothing authenticates as AI_AGENT until Phase 7, and a capability granted to a
-- role nobody holds is a capability nobody reviews. permissions-ai-agent-holds-nothing.spec.ts
-- asserts the empty column, so the first grant has to delete an assertion rather than add a line.

ALTER TYPE "MembershipRole" ADD VALUE IF NOT EXISTS 'AI_AGENT';
