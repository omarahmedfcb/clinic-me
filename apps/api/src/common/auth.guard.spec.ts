import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedException } from "@nestjs/common";
import { SignJWT } from "jose";
import type { Request } from "express";
import { issueAccessToken } from "../modules/auth/jwt.ts";
import { AuthGuard, type AuthenticatedRequest } from "./auth.guard.ts";

const CLAIMS = {
  sub: "user-1",
  membershipId: "membership-1",
  tenantId: "tenant-1",
  role: "DOCTOR" as const,
};

function fakeContext(headers: Record<string, string | undefined>): {
  context: ExecutionContext;
  request: Partial<AuthenticatedRequest>;
} {
  const request: Partial<AuthenticatedRequest> = { headers: headers as Request["headers"] };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe("AuthGuard", () => {
  const guard = new AuthGuard();

  test("rejects a missing token", async () => {
    const { context } = fakeContext({});
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test("rejects an Authorization header with no Bearer prefix", async () => {
    const { context } = fakeContext({ authorization: "some-token-without-bearer-prefix" });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test("rejects a malformed token", async () => {
    const { context } = fakeContext({ authorization: "Bearer not-a-real-jwt" });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test("rejects an expired token", async () => {
    const secret = new TextEncoder().encode(process.env["JWT_SECRET"]);
    const expired = await new SignJWT({
      membershipId: CLAIMS.membershipId,
      tenantId: CLAIMS.tenantId,
      role: CLAIMS.role,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(CLAIMS.sub)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret);

    const { context } = fakeContext({ authorization: `Bearer ${expired}` });
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  test("accepts a valid token and attaches claims to the request", async () => {
    const token = await issueAccessToken(CLAIMS);
    const { context, request } = fakeContext({ authorization: `Bearer ${token}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.authClaims).toEqual(CLAIMS);
  });
});
