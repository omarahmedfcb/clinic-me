-- Two nullable columns on `doctors` — ruled by the founder 2026-09-05.
--
--
-- WHY ONLY TWO
--
-- The ask was "room number, contact, personal and professional data, licence". Checked against the
-- schema before building: contact already exists (users.phone_e164, users.email, reached through
-- the membership), specialty and license_number already exist, and signature_url already exists.
-- What was genuinely missing was room number, licence *expiry* — only the number was stored —
-- and personal/HR data.
--
-- His ruling narrowed it: "add room number and licence expiry only. Skip personal data (DOB,
-- national ID) and qualifications for now — those are HR data on a screen that isn't HR, and
-- licence expiry is the one with an operational consequence."
--
-- That consequence is real and is the reason this column is not decoration: a doctor practising on
-- an expired licence is a regulatory problem for the clinic, and the date is knowable in advance.
-- Nothing acts on it yet. When something does, it should derive "expired" at read time against a
-- passed-in instant rather than storing a flag a job has to maintain — the rule
-- `SCHEMA-DECISIONS.md` D24 and the transfer window already follow.
--
--
-- BOTH NULLABLE, AND NEITHER GETS A CHECK
--
-- Every existing doctor row predates both columns, and a clinic that has never recorded a room is
-- not in an invalid state. NOT NULL with a backfilled placeholder would be inventing data.
--
-- No CHECK on `license_expiry` either, and that is deliberate rather than an oversight: a licence
-- that expired last year is a fact the system must be able to record, precisely so it can be
-- surfaced. A constraint refusing past dates would make the one case worth knowing about
-- unstorable.
--
-- `room_number` is text, not an integer. Clinic rooms are called "2", "2أ", "الأشعة" and "Ground
-- floor B" — a numeric column would refuse three of those four.

ALTER TABLE doctors ADD COLUMN room_number    text;
ALTER TABLE doctors ADD COLUMN license_expiry date;

COMMENT ON COLUMN doctors.room_number IS
  'Free text, not a number: rooms are called "2", "2أ" and "الأشعة". Nullable — a clinic that has '
  'not assigned rooms is not in an invalid state.';

COMMENT ON COLUMN doctors.license_expiry IS
  'When the practising licence lapses. Nullable, and deliberately unconstrained: a licence that '
  'expired last year must be recordable, or the case worth surfacing is the one case that cannot '
  'be stored. Derive "expired" at read time against a passed-in instant; never store a flag.';
