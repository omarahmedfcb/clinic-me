-- Where a patient record came from. DESK unless the WhatsApp bot created it.
-- Provenance is derived from the authenticated actor, never accepted from a request body.

CREATE TYPE "PatientOrigin" AS ENUM ('DESK', 'WHATSAPP_BOT');

-- Existing rows were all created at the desk, which is true rather than a convenient default: no
-- other path into this table has ever existed.
ALTER TABLE patients ADD COLUMN created_via "PatientOrigin" NOT NULL DEFAULT 'DESK';
