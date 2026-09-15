import { SignJWT } from "jose";
import { AccessTokenExpiredError, AccessTokenInvalidError, issueAccessToken, verifyAccessToken } from "./jwt.ts";

const CLAIMS = {
  sub: "user-1",
  membershipId: "membership-1",
  tenantId: "tenant-1",
  role: "DOCTOR" as const,
};

describe("jwt", () => {
  test("issues a token that verifies back to the same claims", async () => {
    const token = await issueAccessToken(CLAIMS);
    const verified = await verifyAccessToken(token);
    expect(verified).toEqual(CLAIMS);
  });

  test("rejects an expired access token", async () => {
    // Built directly with jose, bypassing issueAccessToken's fixed 15-minute TTL, specifically to
    // construct an already-expired token without waiting or adding a TTL override to production
    // code just for this test.
    const secret = new TextEncoder().encode(process.env["JWT_SECRET"]);
    const expiredToken = await new SignJWT({
      membershipId: CLAIMS.membershipId,
      tenantId: CLAIMS.tenantId,
      role: CLAIMS.role,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(CLAIMS.sub)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret);

    await expect(verifyAccessToken(expiredToken)).rejects.toBeInstanceOf(AccessTokenExpiredError);
  });

  test("rejects a token signed with the wrong secret", async () => {
    const wrongSecret = new TextEncoder().encode("not-the-real-secret");
    const token = await new SignJWT({
      membershipId: CLAIMS.membershipId,
      tenantId: CLAIMS.tenantId,
      role: CLAIMS.role,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(CLAIMS.sub)
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(wrongSecret);

    await expect(verifyAccessToken(token)).rejects.toBeInstanceOf(AccessTokenInvalidError);
  });

  test("rejects a malformed token", async () => {
    await expect(verifyAccessToken("not-a-jwt")).rejects.toBeInstanceOf(AccessTokenInvalidError);
  });
});
