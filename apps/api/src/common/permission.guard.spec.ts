import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthenticatedRequest } from "./auth.guard.ts";
import { PermissionGuard } from "./permission.guard.ts";

function fakeContext(role: "OWNER" | "ADMIN" | "DOCTOR" | "RECEPTIONIST"): ExecutionContext {
  const request: Partial<AuthenticatedRequest> = {
    authClaims: { sub: "user-1", membershipId: "m-1", tenantId: "t-1", role },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

/**
 * The decorator now carries a level as well as a capability, because §8 has three levels and the
 * middle one is real. `guardRequiring("schedules", "own")` is what `@RequirePermission("schedules",
 * "own")` produces.
 */
function guardRequiring(capability: string | undefined, level: "full" | "own" = "own"): PermissionGuard {
  const required = capability === undefined ? undefined : { capability, level };
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  return new PermissionGuard(reflector);
}

describe("PermissionGuard", () => {
  test("allows the request through when no @RequirePermission() is present", () => {
    const guard = guardRequiring(undefined);
    expect(guard.canActivate(fakeContext("RECEPTIONIST"))).toBe(true);
  });

  test("allows a role with full access to the required capability", () => {
    const guard = guardRequiring("patients.write");
    expect(guard.canActivate(fakeContext("RECEPTIONIST"))).toBe(true);
  });

  test("allows a role with own-level access to a route that asks for own", () => {
    const guard = guardRequiring("doctorSchedules.manage", "own");
    expect(guard.canActivate(fakeContext("DOCTOR"))).toBe(true);
  });

  test("full satisfies a route that asks for own", () => {
    // The ordering that makes the two levels a hierarchy rather than two unrelated flags.
    const guard = guardRequiring("doctorSchedules.manage", "own");
    expect(guard.canActivate(fakeContext("OWNER"))).toBe(true);
  });

  test("OWN DOES NOT satisfy a route that asks for full", () => {
    // The asymmetry, and the reason the level is on the decorator at all. A doctor may manage her
    // own schedule; a route that edits anyone's must not accept her on the strength of that.
    const guard = guardRequiring("doctorSchedules.manage", "full");
    expect(() => guard.canActivate(fakeContext("DOCTOR"))).toThrow(ForbiddenException);
  });

  test("denies a role with no access to the required capability", () => {
    const guard = guardRequiring("visits.write");
    expect(() => guard.canActivate(fakeContext("RECEPTIONIST"))).toThrow(ForbiddenException);
  });
});
