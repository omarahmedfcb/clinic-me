-- Phase 4, PR 7g — a paused consultation. `PHASE-4.md` Q34.
--
-- The patient stepped out for imaging or a lab. The draft stays open and private; PAUSED counts as
-- present for the same doctor, and the queue shows it distinctly so reception knows why somebody is
-- neither waiting nor finished.
--
-- One statement, and deliberately alone in this migration: Postgres will not let a value added to an
-- enum be used by a later statement in the same transaction.

ALTER TYPE "AppointmentStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
