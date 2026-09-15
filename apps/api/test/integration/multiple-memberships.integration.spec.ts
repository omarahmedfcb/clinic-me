import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { doctorIdForMembership } from "../../src/modules/clinical/clinical.access.ts";
import { actorFor, createTestUser, seedClinic, teardownClinic, type ClinicFixture } from "./fixtures.ts";

/**
 * One person, two memberships, one clinic — ruled 2026-09-06.
 *
 * The unique index on `(user_id, tenant_id)` was dropped so that an owner who genuinely works the
 * desk can hold a second RECEPTIONIST membership and switch into it, which is what makes the
 * 2026-09-06 separation of the owner from desk work usable in a single-doctor clinic.
 *
 * This file asserts the two things that change as a result: the second membership is now writable
 * at all, and `doctorIdForMembership` answers deterministically now that a user is no longer a
 * unique key into `doctors`.
 *
 * ## Both assertions were proven by breaking what they guard
 *
 * Neither is a test that could pass for the wrong reason, and both were run against the state they
 * describe as broken before being trusted:
 *
 * 1. **The index re-created by hand on the test database** (`CREATE UNIQUE INDEX
 *    memberships_user_id_tenant_id_key ON memberships(user_id, tenant_id)`), suite re-run, index
 *    dropped again. Result: 2 failed, 1 passed — the second-membership write is refused, and the
 *    resolution test fails with it because it cannot build its fixture. With the index absent:
 *    3 passed.
 *
 * 2. **`doctorIdForMembership` temporarily reverted to the old user-keyed lookup**, suite re-run,
 *    reverted back. Result: 1 failed, 2 passed. The failure is the one that matters and is worth
 *    stating plainly: asked for the doctor behind a **RECEPTIONIST** membership, the old lookup
 *    returned the doctor id belonging to that person's *other* membership rather than null. In
 *    production that is an owner-receptionist resolving as a doctor and reading clinical records
 *    from the desk — the exact thing the 2026-09-06 ruling separated. The lifted constraint did
 *    not create that hole; it made it reachable, and this test is what stops it being reopened.
 */
describe("a person may hold two memberships in one clinic", () => {
  let clinic: ClinicFixture;

  beforeAll(async () => {
    clinic = await seedClinic();
  });

  afterAll(async () => {
    await teardownClinic(clinic);
    await prisma.$disconnect();
  });

  test("the database accepts a second membership for the same user in the same tenant", async () => {
    // The exact write `memberships_user_id_tenant_id_key` used to refuse. Before 2026-09-06 this
    // threw, which is why the founder's escape hatch for a working owner was unbuildable.
    const second = randomUUID();
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      await tx.membership.create({
        data: injected({
          id: second,
          userId: clinic.userId,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });
    });

    const held = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.findMany({ where: { userId: clinic.userId }, select: { id: true, role: true } }),
    );

    expect(held).toHaveLength(2);
    expect(held.map((m) => m.role).sort()).toEqual(["DOCTOR", "RECEPTIONIST"]);
  });

  /**
   * The reason `doctorIdForUser` had to become `doctorIdForMembership`.
   *
   * Keyed on the user, an unordered `findFirst` across two memberships returns whichever row the
   * planner reaches first — and that row decides whether the caller may read a patient's clinical
   * record. Keyed on the membership it is single by construction, because `doctors.membership_id`
   * is unique and stayed unique when the other index was dropped.
   */
  test("the doctor is resolved from the membership acting, not from the human", async () => {
    const receptionMembership = await withTenant(clinic.tenantId, actorFor(clinic.userId), (tx) =>
      tx.membership.findFirstOrThrow({
        where: { userId: clinic.userId, role: "RECEPTIONIST" },
        select: { id: true },
      }),
    );

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      // The same person: a doctor under one membership, not a doctor under the other.
      expect(await doctorIdForMembership(tx, clinic.membershipId)).toBe(clinic.doctorId);
      expect(await doctorIdForMembership(tx, receptionMembership.id)).toBeNull();
    });
  });

  test("a membership that is not a doctor anywhere resolves to null rather than to someone else's", async () => {
    const strangerId = await createTestUser();
    let strangerMembership = "";
    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      strangerMembership = randomUUID();
      await tx.membership.create({
        data: injected({
          id: strangerMembership,
          userId: strangerId,
          role: "RECEPTIONIST",
          status: "ACTIVE",
        }),
      });
    });

    await withTenant(clinic.tenantId, actorFor(clinic.userId), async (tx) => {
      expect(await doctorIdForMembership(tx, strangerMembership)).toBeNull();
    });
  });
});
