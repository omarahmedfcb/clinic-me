import { randomUUID } from "node:crypto";
import { prisma } from "../../src/prisma/client.ts";
import { injected } from "../../src/prisma/injected.ts";
import { withTenant } from "../../src/prisma/with-tenant.ts";
import { verifyAccessToken } from "../../src/modules/auth/jwt.ts";
import {
  issueSession,
  MembershipNotActiveError,
  RefreshTokenReuseDetectedError,
  rotateRefreshToken,
  switchTenant,
} from "../../src/modules/auth/refresh-tokens.ts";
import { actorFor, createTestTenant, createTestUser, deleteTestTenant, deleteTestUser } from "./fixtures.ts";

const IP = "127.0.0.1";
const USER_AGENT = "jest";

async function createMembership(tenantId: string, userId: string, status: "ACTIVE" | "SUSPENDED" = "ACTIVE") {
  const membershipId = randomUUID();
  await withTenant(tenantId, actorFor(userId), async (tx) =>
    tx.membership.create({ data: injected({ id: membershipId, userId, role: "DOCTOR", status }) }),
  );
  return membershipId;
}

describe("refresh-tokens", () => {
  let tenantA: string;
  let tenantB: string;
  let tenantC: string;
  let tenantD: string;
  let userId: string;
  let membershipA: string;
  let membershipB: string;
  let membershipDSuspended: string;

  beforeAll(async () => {
    tenantA = await createTestTenant();
    tenantB = await createTestTenant();
    tenantC = await createTestTenant(); // user has no membership here at all
    tenantD = await createTestTenant(); // user's membership here is SUSPENDED
    userId = await createTestUser();
    membershipA = await createMembership(tenantA, userId);
    membershipB = await createMembership(tenantB, userId);
    // Shared across every test that needs a revoked/suspended membership -- memberships has a
    // unique (user_id, tenant_id) constraint, so creating a fresh one per test for the same user
    // would collide on the second test.
    membershipDSuspended = await createMembership(tenantD, userId, "SUSPENDED");
  });

  afterAll(async () => {
    await prisma.refreshToken.deleteMany({ where: { userId } });
    await withTenant(tenantA, actorFor(userId), async (tx) => tx.membership.deleteMany());
    await withTenant(tenantB, actorFor(userId), async (tx) => tx.membership.deleteMany());
    await withTenant(tenantD, actorFor(userId), async (tx) => tx.membership.deleteMany());
    await deleteTestUser(userId);
    await deleteTestTenant(tenantA);
    await deleteTestTenant(tenantB);
    await deleteTestTenant(tenantC);
    await deleteTestTenant(tenantD);
    await prisma.$disconnect();
  });

  test("issueSession then rotateRefreshToken produces a working new pair", async () => {
    const session = await issueSession(userId, membershipA, IP, USER_AGENT);
    const rotated = await rotateRefreshToken(session.refreshToken, IP, USER_AGENT);

    const claims = await verifyAccessToken(rotated.accessToken);
    expect(claims.sub).toBe(userId);
    expect(claims.membershipId).toBe(membershipA);
    expect(claims.tenantId).toBe(tenantA);
  });

  test("a consumed refresh token, replayed, revokes the entire family", async () => {
    const session = await issueSession(userId, membershipA, IP, USER_AGENT);
    const rotatedOnce = await rotateRefreshToken(session.refreshToken, IP, USER_AGENT);

    // Replaying the already-consumed original token is the attack this defends against.
    await expect(rotateRefreshToken(session.refreshToken, IP, USER_AGENT)).rejects.toBeInstanceOf(
      RefreshTokenReuseDetectedError,
    );

    // The requirement that matters: the family is revoked, not just the replayed token. The
    // *next* legitimate token in the chain -- otherwise perfectly valid, unexpired, never
    // presented before this point -- must also now be unusable.
    await expect(rotateRefreshToken(rotatedOnce.refreshToken, IP, USER_AGENT)).rejects.toBeInstanceOf(
      RefreshTokenReuseDetectedError,
    );
  });

  test("switchTenant issues a token for a membership the user actually has", async () => {
    const session = await issueSession(userId, membershipA, IP, USER_AGENT);
    const switched = await switchTenant(session.refreshToken, membershipB, IP, USER_AGENT);

    const claims = await verifyAccessToken(switched.accessToken);
    expect(claims.membershipId).toBe(membershipB);
    expect(claims.tenantId).toBe(tenantB);
  });

  test("switchTenant refuses a membership the user does not have", async () => {
    const session = await issueSession(userId, membershipA, IP, USER_AGENT);
    const someoneElsesMembershipId = randomUUID();

    await expect(
      switchTenant(session.refreshToken, someoneElsesMembershipId, IP, USER_AGENT),
    ).rejects.toBeInstanceOf(MembershipNotActiveError);
  });

  test("switchTenant refuses a tenant the user has no membership in at all", async () => {
    const session = await issueSession(userId, membershipA, IP, USER_AGENT);
    const otherUserId = await createTestUser();
    const otherUsersMembershipInTenantC = await createMembership(tenantC, otherUserId);

    try {
      await expect(
        switchTenant(session.refreshToken, otherUsersMembershipInTenantC, IP, USER_AGENT),
      ).rejects.toBeInstanceOf(MembershipNotActiveError);
    } finally {
      await withTenant(tenantC, actorFor(otherUserId), async (tx) => tx.membership.deleteMany({ where: { userId: otherUserId } }));
      await deleteTestUser(otherUserId);
    }
  });

  test("a revoked membership cannot be switched to", async () => {
    const session = await issueSession(userId, membershipA, IP, USER_AGENT);

    await expect(
      switchTenant(session.refreshToken, membershipDSuspended, IP, USER_AGENT),
    ).rejects.toBeInstanceOf(MembershipNotActiveError);
  });

  test("issueSession refuses a membership that is not active", async () => {
    await expect(
      issueSession(userId, membershipDSuspended, IP, USER_AGENT),
    ).rejects.toBeInstanceOf(MembershipNotActiveError);
  });
});
