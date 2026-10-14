-- A reminder, cancellation notice, documents link or "go to the room" message we gave up sending is
-- invisible to the patient and, without this, to the clinic too: nothing at the desk would say the
-- patient was never told. Kept as its own migration because ALTER TYPE ... ADD VALUE and a use of the
-- new value cannot share a transaction.
ALTER TYPE "NotificationKind" ADD VALUE IF NOT EXISTS 'WHATSAPP_MESSAGE_FAILED';
