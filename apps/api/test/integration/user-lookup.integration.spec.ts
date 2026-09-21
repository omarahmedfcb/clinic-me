import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { hashPassword } from "../../src/modules/auth/password.ts";
import { listActiveMemberships, verifyCredentials } from "../../src/modules/auth/user-lookup.ts";
import { actorFor, createTestTenant, createTestUser, deleteTestTenant, deleteTestUser } from "./fixtures.ts";

// swc compiles named exports as non-configurable getters (`Object.defineProperty(..., { get })`
// with no `configurable: true`), so `jest.spyOn` on an already-imported module namespace throws
// "Cannot redefine property". jest.mock() + requireActual() is the robust equivalent: it replaces
// the module in Jest's own registry before anything imports it, wrapping only verifyPasswordHash
// in a jest.fn() while every other export (hashPassword) stays real.
jest.mock("../../src/modules/auth/password.ts", () => {
  const actual = jest.requireActual("../../src/modules/auth/password.ts");
  return { ...actual, verifyPasswordHash: jest.fn(actual.verifyPasswordHash) };
});
import { verifyPasswordHash } from "../../src/modules/auth/password.ts";

describe("user-lookup", () => {
  let tenantId: string;
  let userId: string;
  let phone: string;
  const password = "correct-horse-battery-staple";

  beforeAll(async () => {
    tenantId = await createTestTenant();
    userId = await createTestUser();
    phone = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).phoneE164;

    await withTenant(tenantId, actorFor(userId), async (tx) =>
      tx.membership.create({
        data: injected({ id: randomUUID(), userId, role: "DOCTOR", status: "ACTIVE" }),
      }),
    );

    // Through `withTenant`: `users` carries an audit trigger as of 2026-09-13 and it refuses a write
    // with no actor bound, exactly as every tenant table's does. The membership is created first so
    // the actor resolves to a role rather than to UNKNOWN.
    const passwordHash = await hashPassword(password);
    await withTenant(tenantId, actorFor(userId), (tx) =>
      tx.user.update({ where: { id: userId }, data: { passwordHash } }),
    );
  });

  afterAll(async () => {
    await withTenant(tenantId, actorFor(userId), async (tx) => tx.membership.deleteMany());
    await deleteTestUser(userId);
    await deleteTestTenant(tenantId);
    await prisma.$disconnect();
  });

  describe("verifyCredentials", () => {
    test("returns the user for a correct phone + password", async () => {
      const result = await verifyCredentials(phone, password);
      expect(result?.id).toBe(userId);
    });

    test("returns null for a wrong password", async () => {
      await expect(verifyCredentials(phone, "wrong-password")).resolves.toBeNull();
    });

    test("returns null for a nonexistent identifier", async () => {
      await expect(verifyCredentials("+201999999999", password)).resolves.toBeNull();
    });

    test("still runs a real Argon2 verify for a nonexistent identifier (timing-safety guard)", async () => {
      // Structural, not a wall-clock timing measurement (which would be flaky in CI): asserts the
      // dummy-hash path in user-lookup.ts actually calls verifyPasswordHash. Without this, a
      // future refactor could add an early `if (!user) return null` before the verify call --
      // every other test here would stay green, response *content* would look identical, and
      // only response *timing* would silently start leaking which identifiers are registered.
      const mockedVerify = verifyPasswordHash as jest.Mock;
      mockedVerify.mockClear();
      await verifyCredentials("+201999999998", "irrelevant-password");
      expect(mockedVerify).toHaveBeenCalledTimes(1);
    });

    test("returns null for a non-ACTIVE user even with the correct password", async () => {
      // Bound, like every other write to `users` since the audit trigger: suspending a person is
      // precisely the administrative act that trail exists to record.
      const setStatus = (status: "ACTIVE" | "SUSPENDED"): Promise<unknown> =>
        withTenant(tenantId, actorFor(userId), (tx) =>
          tx.user.update({ where: { id: userId }, data: { status } }),
        );

      await setStatus("SUSPENDED");
      try {
        await expect(verifyCredentials(phone, password)).resolves.toBeNull();
      } finally {
        await setStatus("ACTIVE");
      }
    });
  });

  describe("listActiveMemberships", () => {
    test("returns an ACTIVE membership in an ACTIVE tenant", async () => {
      const memberships = await listActiveMemberships(userId);
      expect(memberships).toHaveLength(1);
      expect(memberships[0]?.tenantId).toBe(tenantId);
      expect(memberships[0]?.role).toBe("DOCTOR");
    });

    test("excludes a membership whose tenant is not ACTIVE", async () => {
      // Through withTenant() rather than a bare prisma.tenant.update(): since D22 the `tenants`
      // table carries an audit trigger, and the trigger refuses any write with no actor bound
      // (D16). That is the trigger working -- suspending a clinic is exactly the administrative
      // act the audit trail exists to record -- so the test binds an actor like every other
      // tenant-scoped write in the codebase does.
      // The reason and the instant travel with the status from 0b–0g: `tenants_suspension_is_explained`
      // refuses a suspended clinic with no explanation, and refuses a live one that still carries a
      // stale one. This test is about who may log in, and supplies both halves so the CHECK passes.
      const setStatus = (status: "ACTIVE" | "SUSPENDED"): Promise<unknown> =>
        withTenant(tenantId, { userId, ip: "127.0.0.1", userAgent: "jest-integration-tests" }, (tx) =>
          tx.tenant.update({
            where: { id: tenantId },
            data:
              status === "SUSPENDED"
                ? { status, suspensionReason: "suspended by a test", suspendedAt: new Date() }
                : { status, suspensionReason: null, suspendedAt: null },
          }),
        );

      await setStatus("SUSPENDED");
      try {
        await expect(listActiveMemberships(userId)).resolves.toHaveLength(0);
      } finally {
        await setStatus("ACTIVE");
      }
    });

    test("excludes a membership that is itself not ACTIVE", async () => {
      // A second real actor: a trigger refuses suspending the membership you are acting through
      // (2026-09-12), and a real user id is needed because the audit row has a foreign key to it.
      // This test is about which memberships are listed, not about that rule.
      const actingUserId = await createTestUser();
      const byColleague = <T>(run: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>): Promise<T> =>
        withTenant(tenantId, actorFor(actingUserId), run);

      await byColleague(async (tx) =>
        tx.membership.updateMany({ where: { userId }, data: { status: "SUSPENDED" } }),
      );
      try {
        await expect(listActiveMemberships(userId)).resolves.toHaveLength(0);
      } finally {
        await byColleague(async (tx) =>
          tx.membership.updateMany({ where: { userId }, data: { status: "ACTIVE" } }),
        );
        await deleteTestUser(actingUserId);
      }
    });

    test("returns an empty list for a user with no memberships", async () => {
      const otherUserId = await createTestUser();
      try {
        await expect(listActiveMemberships(otherUserId)).resolves.toHaveLength(0);
      } finally {
        await deleteTestUser(otherUserId);
      }
    });
  });
});
