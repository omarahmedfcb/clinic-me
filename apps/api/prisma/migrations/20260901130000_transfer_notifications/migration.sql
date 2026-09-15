-- Phase 3 — transfer notifications. `PHASE-3.md` Q16/Q17/Q21, `SCHEMA-DECISIONS.md` D24.
--
-- Four new NotificationKind values, and the two that matter are the ones nobody would think to add.
--
-- TRANSFER_REJECTED exists because of a founder ruling: "a rejection that silently reverts is how a
-- patient gets forgotten in a waiting room". A rejected transfer that only flips a status somewhere
-- is invisible to the desk that raised it -- reception is left believing a request is still being
-- considered, while the patient sits waiting for a doctor who has already declined.
--
-- TRANSFER_LAPSED is the same argument for the case nobody asks about (D24): the appointment ended
-- while the request was still open. That closes the request without anybody answering it, which is
-- exactly when the desk most needs telling, because the outcome looks identical to "still pending"
-- from the outside.
--
-- ALTER TYPE ... ADD VALUE is transactional-safe here only because these values are added and NOT
-- used in the same transaction; the first row carrying one is written by application code later.

ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_REQUESTED';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_ACCEPTED';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_REJECTED';
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'TRANSFER_LAPSED';
