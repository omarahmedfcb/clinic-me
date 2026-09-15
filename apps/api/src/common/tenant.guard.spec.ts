import type { ExecutionContext } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { tenantContext } from "../prisma/tenant-context.ts";
import type { AuthenticatedRequest } from "./auth.guard.ts";
import { TenantGuard } from "./tenant.guard.ts";

const AUTH_CLAIMS = {
  sub: "user-1",
  membershipId: "membership-1",
  tenantId: "tenant-from-jwt",
  role: "DOCTOR" as const,
  permissions: [],
};

function fakeContext(overrides: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
}): ExecutionContext {
  const request: Partial<AuthenticatedRequest> = {
    authClaims: AUTH_CLAIMS,
    method: "POST",
    originalUrl: "/some/route",
    body: overrides.body ?? {},
    query: (overrides.query ?? {}) as AuthenticatedRequest["query"],
    headers: (overrides.headers ?? {}) as AuthenticatedRequest["headers"],
  };
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe("TenantGuard", () => {
  const guard = new TenantGuard();

  // enterWith() binds ambiently past this test's own execution -- clear it after each test so
  // one test's tenant binding can't leak into the next.
  afterEach(() => {
    tenantContext.enterWith(undefined as unknown as string);
  });

  test("populates tenantContext from the JWT claim when nothing else supplies a tenantId", () => {
    guard.canActivate(fakeContext({}));
    expect(tenantContext.tryGet()).toBe("tenant-from-jwt");
  });

  test("ignores a tenantId in the request body -- JWT claim wins", () => {
    guard.canActivate(fakeContext({ body: { tenantId: "attacker-supplied-tenant" } }));
    expect(tenantContext.tryGet()).toBe("tenant-from-jwt");
  });

  test("ignores a tenantId in the query string -- JWT claim wins", () => {
    guard.canActivate(fakeContext({ query: { tenantId: "attacker-supplied-tenant" } }));
    expect(tenantContext.tryGet()).toBe("tenant-from-jwt");
  });

  test("ignores a tenantId in an x-tenant-id header -- JWT claim wins", () => {
    guard.canActivate(fakeContext({ headers: { "x-tenant-id": "attacker-supplied-tenant" } }));
    expect(tenantContext.tryGet()).toBe("tenant-from-jwt");
  });

  test("logs a security warning when a tenantId is supplied via body/query/header", () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      guard.canActivate(fakeContext({ body: { tenantId: "attacker-supplied-tenant" } }));
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toContain("SECURITY");
      expect(warnSpy.mock.calls[0]?.[0]).toContain("body");
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("logs once per source when a tenantId is supplied in more than one place at once", () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      guard.canActivate(
        fakeContext({
          body: { tenantId: "x" },
          query: { tenantId: "y" },
          headers: { "x-tenant-id": "z" },
        }),
      );
      expect(warnSpy).toHaveBeenCalledTimes(3);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("does not log anything when no tenantId is supplied outside the JWT", () => {
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      guard.canActivate(fakeContext({}));
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
