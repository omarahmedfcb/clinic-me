-- Four notifications between the desk and the doctor: consultation started and ended (to reception),
-- patient checked in and patient paid (to the doctor). Only adds enum values: ALTER TYPE ... ADD VALUE
-- and a use of the new value cannot share a transaction, and nothing here uses them.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'CONSULTATION_STARTED';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'CONSULTATION_ENDED';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'PATIENT_CHECKED_IN';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'PATIENT_PAID';
