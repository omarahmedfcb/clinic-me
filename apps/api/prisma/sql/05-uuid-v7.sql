-- Phase 1, Checkpoint 3 — a UUIDv7 generator in the database.
--
-- Why this exists at all: SCHEMA-DECISIONS.md D6 says ids are UUIDv7 generated in the
-- application, and every `id` column is deliberately declared with no `@default` so that a
-- create arriving without an id is a loud bug rather than a silent fallback to v4. The audit
-- trigger (07-audit-triggers.sql) breaks that assumption for exactly one table: it inserts into
-- audit_logs from inside Postgres, where there is no application to ask for an id. Something has
-- to mint one.
--
-- Why not an extension: D6 rejected pg_uuidv7 because the hosting provider is not chosen yet and
-- data residency may force a smaller Egyptian host where it is unavailable. That reasoning does
-- not weaken just because the caller is now a trigger instead of the application, so this uses
-- nothing outside core Postgres 13+.
--
-- Why not gen_random_uuid(): that is v4. Mixing v4 ids into a table whose every other id is v7
-- would give audit_logs random-ordered primary keys -- the exact index-locality loss v7 exists to
-- avoid, on the one table that only ever grows and is only ever queried in time order.
--
-- Construction, per RFC 9562 §5.7: 48 bits of Unix milliseconds, 4 bits of version (7), 12 bits
-- random, 2 bits of variant (0b10), 62 bits random -- 74 random bits in total. The random bytes
-- come from gen_random_uuid(), which is core (pgcrypto not required): a v4 UUID's last 10 bytes
-- are cryptographically random apart from its own version and variant bits, and both of those sit
-- at offsets this function overwrites anyway.
CREATE OR REPLACE FUNCTION uuid_generate_v7() RETURNS uuid
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  v_bytes bytea;
BEGIN
  -- int8send yields 8 big-endian bytes; bytes 3..8 are the low 48 bits of the millisecond value.
  v_bytes := substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3 FOR 6)
             || substring(uuid_send(gen_random_uuid()) FROM 7 FOR 10);

  -- Byte 6: replace the high nibble with the version, keeping the low nibble random.
  v_bytes := set_byte(v_bytes, 6, (get_byte(v_bytes, 6) & 15) | 112);
  -- Byte 8: replace the top two bits with the RFC 9562 variant (0b10), keeping the rest random.
  v_bytes := set_byte(v_bytes, 8, (get_byte(v_bytes, 8) & 63) | 128);

  RETURN encode(v_bytes, 'hex')::uuid;
END;
$$;

COMMENT ON FUNCTION uuid_generate_v7() IS
  'RFC 9562 UUIDv7. Core Postgres only, no extension (SCHEMA-DECISIONS.md D6). Used by the audit '
  'trigger, which has no application to obtain an id from. Application code must keep generating '
  'its own ids via the uuidv7 npm package -- this is not a schema default and must not become one.';
