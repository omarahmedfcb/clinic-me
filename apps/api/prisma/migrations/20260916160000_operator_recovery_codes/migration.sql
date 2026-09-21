-- Operator recovery codes — pilot-readiness item 0, the second factor's lost-phone path.
--
-- One row per unused code. Consuming a code DELETES its row, so the row count is the number of
-- codes left and there is no "used" flag that can be read stale. Hashed with the same Argon2id
-- settings as a password, because that is what it is: a credential that opens the console alone.

-- The recovery sign-in is its own audit action, not a LOGIN with a detail field. It is the one path
-- that opens the console without the authenticator, so "how often, and to whom" has to be
-- answerable by filtering the column rather than by parsing JSON.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OPERATOR_RECOVERY_CODE_USED';
-- And the replacement itself. Both are second-factor events on the console, and both have to be
-- answerable by filtering the action column rather than by reading JSON out of every row.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'OPERATOR_TOTP_REPLACED';

CREATE TABLE "operator_recovery_codes" (
  "id"         uuid PRIMARY KEY,
  "user_id"    uuid        NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "code_hash"  text        NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "operator_recovery_codes_user_id_idx" ON "operator_recovery_codes" ("user_id");

-- No row-level security, matching `users` and `refresh_tokens`: an operator has no tenant, so there
-- is no tenant_id for a policy to compare against. Reachability is decided by the platform guards
-- and by the fact that nothing outside `platform-operators.ts` reads this table.
--
-- No GRANT either: ALTER DEFAULT PRIVILEGES in the app_role migration already gives clinic_os_app
-- SELECT/INSERT/UPDATE/DELETE on tables this role creates.

-- A candidate authenticator, held while it is being proved during a replacement after a recovery
-- login. Separate from `totp_secret` so the working factor is never destroyed before the new one
-- has answered: a replacement abandoned half-way must leave the operator able to sign in.
ALTER TABLE "users" ADD COLUMN "totp_pending_secret" text;
