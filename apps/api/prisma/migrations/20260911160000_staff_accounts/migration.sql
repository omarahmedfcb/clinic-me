-- «المستخدمون» — the staff list. Phase 5, PR 10.
--
-- One column. Everything else the screen needs already exists: `users.last_login_at` has been on
-- the table since Phase 1 with nothing writing to it, `memberships.status` already carries
-- SUSPENDED, and suspension is a status change rather than a delete because a staff row is the
-- actor on every audit line that person ever wrote.
--
-- **A temporary password is a password.** It is Argon2-hashed like any other and is never stored in
-- plaintext; "shown once" means the response carries it and nothing else ever can.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

ALTER TABLE "users" ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false;

SELECT set_config('app.current_actor_id', '', false);
