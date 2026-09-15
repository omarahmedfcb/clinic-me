-- «المستخدمون» critical review, 2026-09-13: the owner demoted himself by editing his own row.
--
-- What happened, from `audit_logs`: `UPDATE by أحمد عبد الرحمن الشناوي — role: OWNER -> RECEPTIONIST`
-- at 07:24:16. The users list's edit dialog defaulted its role select to RECEPTIONIST for an OWNER
-- row, because OWNER is not one of the two roles that select offers, and the save sent the role
-- because it differed. Nothing refused it: an ADMIN was still active, so the "an administrator must
-- remain" guard was satisfied, and no rule said anything about *whose* role was being changed.
--
-- Two rules, and both belong here as well as at the route, because the route is one
-- `prisma.membership.update` away from being bypassed and the seed never goes through it.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

/*
 * **The OWNER's role is fixed.** Who owns a clinic is not a users-list decision.
 *
 * Unconditional, not "unless somebody else is an owner": this is about where the change is made,
 * not about leaving the clinic administrable. Transferring ownership is a deliberate act that will
 * need its own screen, its own refusal and its own ruling — it is not a select box on a dialog that
 * also edits a phone number.
 */
CREATE OR REPLACE FUNCTION refuse_owner_role_change() RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'OWNER' AND NEW.role <> 'OWNER' THEN
    RAISE EXCEPTION 'the owner role cannot be changed from the users list (membership %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_refuse_owner_role_change
  BEFORE UPDATE OF role ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION refuse_owner_role_change();

/*
 * **Nobody changes their own role.** The founder's ruling, and the other half of self-suspension:
 * a person who demotes themselves loses the screen that would undo it, and the capabilities they
 * keep until their token expires are the ones they just gave away.
 *
 * Same shape as `refuse_self_suspension`: a migration or the seed runs as `system_actor_id()`, which
 * holds no membership, so neither is caught.
 */
CREATE OR REPLACE FUNCTION refuse_self_role_change() RETURNS trigger AS $$
DECLARE
  actor UUID;
BEGIN
  IF NEW.role = OLD.role THEN
    RETURN NEW;
  END IF;

  actor := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF actor IS NOT NULL AND actor = NEW.user_id THEN
    RAISE EXCEPTION 'a user cannot change their own role (membership %)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_refuse_self_role_change
  BEFORE UPDATE OF role ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION refuse_self_role_change();

SELECT set_config('app.current_actor_id', '', false);
