-- One user may hold more than one membership in the same clinic — ruled 2026-09-06.
--
--
-- WHY
--
-- On 2026-09-06 the founder separated the owner from desk and clinical work: OWNER lost
-- `appointments.queueActions`, `patients.transfer`, `appointments.write`, `patients.write`,
-- `payments.record` and `appointments.overrideSlotConflict`. His reason was the audit trail —
-- an owner checking a patient in under the owner role records "the owner did this", which in a
-- multi-doctor clinic makes accountability ambiguous.
--
-- The escape hatch for the single-doctor Egyptian clinic, where the owner genuinely is the doctor
-- and often the desk, was that such an owner holds a SECOND membership as DOCTOR or RECEPTIONIST
-- and switches to it. `memberships_user_id_tenant_id_key` made that impossible, so the ruling was
-- unbuildable and the most common clinic in the market could not run its own front desk.
--
--
-- WHAT DEPENDED ON IT: NOTHING, CHECKED RATHER THAN ASSUMED
--
-- `userId_tenantId` appears nowhere in `src/` or `test/` as a lookup or an upsert target — the
-- compound key was never used to find a membership, only to forbid a second one.
--
-- More decisively, **the session was already membership-keyed rather than tenant-keyed**. The
-- access token carries `membershipId`; `switchTenant(presented, targetMembershipId)` rotates the
-- refresh token to a target membership and validates only that it belongs to the user and is
-- ACTIVE. It never asks which tenant that membership is in. Two memberships in one clinic
-- therefore work through the existing switcher with no change to the auth path at all.
--
--
-- WHAT THIS DOES NOT RELAX
--
-- `doctors.membership_id` stays `@unique`: one membership is still at most one doctor record. That
-- is what makes "which doctor is this caller" answerable by construction rather than by an ordered
-- query — see `doctorIdForMembership`, which replaced a `findFirst` on `userId` that this change
-- would otherwise have made nondeterministic.
--
-- RLS is untouched. A membership is still tenant-scoped, and a user still sees only the clinics
-- they belong to.

DROP INDEX IF EXISTS memberships_user_id_tenant_id_key;

COMMENT ON TABLE memberships IS
  'A person''s role at one clinic. A user may hold SEVERAL memberships in the same clinic since '
  '2026-09-06 — an owner who also works the desk holds an OWNER and a RECEPTIONIST membership and '
  'switches between them, so the audit trail records the role that actually acted. Sessions are '
  'keyed by membership_id, not by tenant_id.';
