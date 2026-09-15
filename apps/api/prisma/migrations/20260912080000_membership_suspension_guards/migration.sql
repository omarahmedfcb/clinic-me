-- «المستخدمون» review, 2026-09-12: nobody suspends themselves, and no clinic is left unadministered.
--
-- **Both rules are enforced here as well as at the route.** The route returns a sentence naming
-- which rule was hit, which a trigger cannot; the trigger is what makes the rule true for the seed,
-- for direct SQL, and for whatever writes this table next. The route check alone was the whole of
-- it before this, and a route check is one `prisma.membership.update` away from being bypassed.
--
-- The second rule is written as "an active administrator must remain", not as "do not suspend the
-- last one", because the users screen is gaining a role editor in the same review: demoting the
-- last ADMIN to RECEPTIONIST leaves the clinic in exactly the state suspending them would, and a
-- guard that only watched `status` would have been silent about it.

SELECT set_config('app.current_actor_id', system_actor_id()::text, false);

/*
 * Self-suspension: the acting user cannot take their own membership out of service.
 *
 * `app.current_actor_id` is the acting human, set by `withTenant` on every application statement.
 * A migration or the seed runs as `system_actor_id()`, which holds no membership, so neither is
 * caught by this. An unbound session has no actor and is not caught either — this is a usability
 * guard, not a privilege boundary, and RLS is what stands between tenants.
 */
CREATE OR REPLACE FUNCTION refuse_self_suspension() RETURNS trigger AS $$
DECLARE
  actor UUID;
BEGIN
  IF NEW.status <> 'SUSPENDED' OR OLD.status = 'SUSPENDED' THEN
    RETURN NEW;
  END IF;

  actor := NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
  IF actor IS NOT NULL AND actor = NEW.user_id THEN
    RAISE EXCEPTION 'a user cannot suspend their own membership (%)', NEW.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_refuse_self_suspension
  BEFORE UPDATE OF status ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION refuse_self_suspension();

/*
 * An active administrator must remain in the clinic.
 *
 * AFTER, and counting the table rather than reasoning about the row: a BEFORE trigger would have to
 * predict the post-update state, and the count is the thing that actually matters. The row's own
 * tenant is the scope — a clinic is left without an administrator one clinic at a time, and the
 * same human administering a second clinic does not help the first.
 *
 * OWNER and ADMIN are counted together because `users.manage` is FULL for both: either can restore
 * the other, so a clinic with one of either is not stranded.
 */
CREATE OR REPLACE FUNCTION require_an_active_administrator() RETURNS trigger AS $$
DECLARE
  remaining INTEGER;
BEGIN
  IF OLD.role NOT IN ('OWNER', 'ADMIN') OR OLD.status <> 'ACTIVE' THEN
    RETURN NULL;
  END IF;
  IF NEW.role IN ('OWNER', 'ADMIN') AND NEW.status = 'ACTIVE' THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO remaining
    FROM memberships m
   WHERE m.tenant_id = OLD.tenant_id
     AND m.status = 'ACTIVE'
     AND m.role IN ('OWNER', 'ADMIN');

  IF remaining = 0 THEN
    RAISE EXCEPTION 'clinic % would be left with no active administrator', OLD.tenant_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_require_an_active_administrator
  AFTER UPDATE OF status, role ON "memberships"
  FOR EACH ROW EXECUTE FUNCTION require_an_active_administrator();

SELECT set_config('app.current_actor_id', '', false);
