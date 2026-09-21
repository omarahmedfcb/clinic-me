import { Body, Controller, Get, HttpCode, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { SkipThrottle, ThrottlerGuard } from "@nestjs/throttler";
import { skipAllExcept } from "../../common/throttlers.ts";
import type { Request, Response } from "express";
import { actorContext } from "../../common/actor-context.ts";
import { AuthGuard, type AuthenticatedRequest } from "../../common/auth.guard.ts";
import { permissionSummary } from "../../common/permissions.ts";
import { prisma } from "../../prisma/client.ts";
import { withTenant } from "../../prisma/with-tenant.ts";
import { AllowsPasswordChange } from "../../common/password-change.guard.ts";
import { IDENTIFIER_THROTTLER, IP_THROTTLER, PASSWORD_THROTTLER } from "./auth-throttle.ts";
import { ChangePasswordDto, LoginDto, SwitchTenantDto } from "./auth.dto.ts";
import { hashPassword, verifyPasswordHash } from "./password.ts";
import { loginCountry, normalisePhone } from "./phone.ts";
import {
  MembershipNotActiveError,
  RefreshTokenExpiredError,
  RefreshTokenInvalidError,
  RefreshTokenReuseDetectedError,
  issueSession,
  revokeAllForUser,
  revokeFamilyForToken,
  rotateRefreshToken,
  switchTenant,
} from "./refresh-tokens.ts";
import { listActiveMemberships, verifyCredentials } from "./user-lookup.ts";

/**
 * The auth endpoints (PHASE-1 §3).
 *
 * ## One response, and one code path, for every failure
 *
 * `verifyCredentials()` returns null identically for "no such user", "wrong password" and "not
 * ACTIVE", and it verifies against a cached dummy hash in the first case so all three cost the same
 * Argon2 work. **This controller must not undo either half**, and undoing the timing half is the
 * easier mistake: an early `return` for an identifier that will not parse as a phone number never
 * reaches the hash, so the fast path becomes an oracle for "that account does not exist" even
 * though the response body is identical.
 *
 * So `login()` has no early returns before `verifyCredentials()`. An unparseable identifier falls
 * through as the raw string, the lookup finds nothing, the dummy hash is verified anyway.
 * `auth-endpoints.integration.spec.ts` asserts this structurally -- that `verifyPasswordHash` is
 * called for a nonexistent identifier -- rather than by measuring wall-clock time, which would be
 * flaky in CI and would end up loosened until it proved nothing.
 *
 * ## The refresh token is a cookie; the access token is not
 *
 * The refresh token is `httpOnly; Secure; SameSite=Strict`, so no script can read it and theft via
 * XSS is not immediately a session takeover. The access token is returned in the body because the
 * SPA must attach it to requests, which means it must be readable -- its fifteen-minute lifetime is
 * what limits that exposure, not secrecy.
 */

const REFRESH_COOKIE = "clinic_os_refresh";
// The name keeps `clinic_os`: it is an identifier, and renaming it signs every open session out.
const REMEMBER_COOKIE = "clinic_os_remember";
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE_PATH = "/api/auth";

/** The same message for every authentication failure. Callers must not be able to tell them apart. */
const INVALID_CREDENTIALS = "Invalid credentials.";

/**
 * **Who may ask to be remembered on a device — and who may not.**
 *
 * Ruled 2026-09-15 with the login redesign. A doctor's and a receptionist's machine is the one they
 * sit at all day in a room with a door; an administrator's or an owner's account can change prices,
 * suspend staff and read the whole clinic's money, and the operator's can create and suspend
 * clinics. A thirty-day cookie on a browser somebody walks away from is a different trade for those
 * two groups, so the product does not offer it to the second.
 *
 * Enforced on the **server**, from the membership's own role, not from what the client asked for:
 * a checkbox hidden in the UI is a suggestion, and `POST /auth/login` is reachable without it.
 */
const REMEMBERABLE_ROLES: readonly string[] = ["DOCTOR", "RECEPTIONIST"];

/**
 * `remember` decides only whether the cookie **persists across browser restarts**.
 *
 * The stored token's own thirty-day expiry is unchanged either way, and that is deliberate rather
 * than an oversight: rotation, revocation and the `refresh_tokens` row are the security boundary,
 * and a session cookie is about not leaving a signed-in browser behind on a shared machine. Said
 * plainly so nobody later reads "remember me" as a claim about token lifetime.
 */
function setRefreshCookie(response: Response, token: string, remember: boolean): void {
  const shared = { httpOnly: true, secure: true, sameSite: "strict" as const, path: COOKIE_PATH };
  response.cookie(REFRESH_COOKIE, token, { ...shared, ...(remember ? { maxAge: REFRESH_TTL_MS } : {}) });

  /*
   * A marker so a rotation keeps the choice.
   *
   * `POST /auth/refresh` receives a cookie and cannot tell whether the browser was told to persist
   * it — so without this, the first token rotation would silently downgrade a remembered session to
   * a session cookie, and the checkbox would appear to work until the user closed the browser a
   * fortnight later. The alternative was a `remembered` column on `refresh_tokens`, which is a
   * migration for one boolean that belongs to the device rather than to the token family.
   *
   * It carries no authority: it says how long to persist a cookie, not whether to accept one.
   */
  if (remember) response.cookie(REMEMBER_COOKIE, "1", { ...shared, maxAge: REFRESH_TTL_MS });
  else response.clearCookie(REMEMBER_COOKIE, shared);
}

/** Whether this browser was told to persist its session. Read on rotation, never trusted for auth. */
function wasRemembered(request: Request): boolean {
  return (request.cookies as Record<string, string> | undefined)?.[REMEMBER_COOKIE] === "1";
}

/** Whether this sign-in may be remembered: the caller asked, **and** the role is one that may. */
export const mayRemember = (asked: boolean | undefined, role: string): boolean =>
  asked === true && REMEMBERABLE_ROLES.includes(role);

function clearRefreshCookie(response: Response): void {
  const shared = { httpOnly: true, secure: true, sameSite: "strict" as const, path: COOKIE_PATH };
  response.clearCookie(REFRESH_COOKIE, shared);
  response.clearCookie(REMEMBER_COOKIE, shared);
}

function readRefreshCookie(request: Request): string {
  const token = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  if (typeof token !== "string" || token.length === 0) throw new UnauthorizedException("Not authenticated.");
  return token;
}

/** Client facts a session is stamped with. `ip` is the real client only because of `trust proxy`. */
function clientFacts(request: Request): { ip: string; userAgent: string } {
  return { ip: request.ip ?? "unknown", userAgent: request.get("user-agent") ?? "unknown" };
}

/** Maps every refresh-token failure to one response. The distinctions matter to us, not to callers. */
function sessionEnded(): UnauthorizedException {
  return new UnauthorizedException("Session is no longer valid. Please log in again.");
}

@Controller("auth")
export class AuthController {
  @Post("login")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle(skipAllExcept(IDENTIFIER_THROTTLER, IP_THROTTLER))
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string; memberships: unknown[]; mustChangePassword: boolean }> {
    // No early return. See the note on this class: falling through with the raw string keeps one
    // code path, so an unparseable identifier costs the same Argon2 verify as a real one.
    const identifier = normalisePhone(body.identifier, loginCountry()) ?? body.identifier;

    const user = await verifyCredentials(identifier, body.password);
    if (!user) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const memberships = await listActiveMemberships(user.id);
    const first = memberships[0];
    // A real account with no active membership gets the same answer as a wrong password. Whether an
    // account exists but is unattached is not something an unauthenticated caller should learn.
    if (!first) throw new UnauthorizedException(INVALID_CREDENTIALS);

    const facts = clientFacts(request);
    const pair = await issueSession(user.id, first.membershipId, facts.ip, facts.userAgent);

    // Recorded here rather than on every authenticated request: "last login" is what the staff
    // list means by it, and a column touched on every call would be a write per request.
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    // The role decides, not the checkbox: `mayRemember` refuses an ADMIN, an OWNER or anyone else
    // outside the two roles that may, however the request was shaped.
    setRefreshCookie(response, pair.refreshToken, mayRemember(body.rememberMe, first.role));
    // The client sends the holder of a temporary password to the change screen; every other route
    // refuses them anyway (`PasswordChangeGuard`), so this is a courtesy and not the enforcement.
    return {
      accessToken: pair.accessToken,
      memberships,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Replaces the caller's password and clears the forced-change flag.
   *
   * The only route that runs while that flag is set — see `PasswordChangeGuard`. Every session is
   * revoked afterwards, this one included: a password change that leaves older sessions alive is
   * one that has not changed what the password protects.
   */
  @Post("password")
  @HttpCode(200)
  @UseGuards(AuthGuard, ThrottlerGuard)
  @SkipThrottle(skipAllExcept(PASSWORD_THROTTLER))
  @AllowsPasswordChange()
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
    @Body() body: ChangePasswordDto,
  ): Promise<{ accessToken: string }> {
    const { sub: userId, membershipId } = request.authClaims;
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!(await verifyPasswordHash(user.passwordHash, body.currentPassword))) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    // Through `withTenant`, which binds the actor `users_audit` requires: a password change is one
    // of the acts the founder asked to be traceable, and the actor here is the person themselves.
    const passwordHash = await hashPassword(body.newPassword);
    await withTenant(request.authClaims.tenantId, actorContext.getOrThrow(), (tx) =>
      tx.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: false } }),
    );
    await revokeAllForUser(userId, "password-changed");

    // A fresh session, so the person who just changed their password is not signed out of the act
    // of changing it.
    const facts = clientFacts(request);
    const pair = await issueSession(userId, membershipId, facts.ip, facts.userAgent);
    setRefreshCookie(response, pair.refreshToken, wasRemembered(request));
    return { accessToken: pair.accessToken };
  }

  /** Rotates the refresh token. Reuse of a consumed token revokes the family -- see refresh-tokens.ts. */
  @Post("refresh")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle(skipAllExcept(IDENTIFIER_THROTTLER, IP_THROTTLER))
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string }> {
    const presented = readRefreshCookie(request);
    const facts = clientFacts(request);

    try {
      const pair = await rotateRefreshToken(presented, facts.ip, facts.userAgent);
      setRefreshCookie(response, pair.refreshToken, wasRemembered(request));
      return { accessToken: pair.accessToken };
    } catch (error) {
      // Every failure clears the cookie. A client holding a token that has been revoked -- including
      // one revoked because somebody else replayed it -- must stop presenting it immediately.
      clearRefreshCookie(response);
      if (
        error instanceof RefreshTokenInvalidError ||
        error instanceof RefreshTokenReuseDetectedError ||
        error instanceof RefreshTokenExpiredError ||
        error instanceof MembershipNotActiveError
      ) {
        throw sessionEnded();
      }
      throw error;
    }
  }

  /** Revokes the presented token's whole family. Idempotent: no cookie is still a successful logout. */
  @Post("logout")
  @HttpCode(204)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    const presented = (request.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (typeof presented === "string" && presented.length > 0) {
      await revokeFamilyForToken(presented, "logout");
    }
    clearRefreshCookie(response);
  }

  /**
   * Switches into another of the user's memberships. The target is validated against the
   * memberships the *presented token's user* holds, so a membershipId belonging to somebody else is
   * refused rather than honoured.
   */
  @Post("switch-tenant")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @SkipThrottle(skipAllExcept(IDENTIFIER_THROTTLER, IP_THROTTLER))
  async switchTenant(
    @Body() body: SwitchTenantDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ accessToken: string }> {
    const presented = readRefreshCookie(request);
    const facts = clientFacts(request);

    try {
      const pair = await switchTenant(presented, body.membershipId, facts.ip, facts.userAgent);
      setRefreshCookie(response, pair.refreshToken, wasRemembered(request));
      return { accessToken: pair.accessToken };
    } catch (error) {
      if (error instanceof MembershipNotActiveError) {
        // Deliberately not "no such membership": a membership the user does not hold and one that
        // does not exist must be the same answer, or this endpoint enumerates membership ids. The
        // session itself is still valid, so the cookie is left alone.
        throw new UnauthorizedException("That workspace is not available for this account.");
      }
      clearRefreshCookie(response);
      if (
        error instanceof RefreshTokenInvalidError ||
        error instanceof RefreshTokenReuseDetectedError ||
        error instanceof RefreshTokenExpiredError
      ) {
        throw sessionEnded();
      }
      throw error;
    }
  }

  /** The current session, from the validated access token. Never from anything the client sent. */
  @Get("me")
  @UseGuards(AuthGuard)
  async me(@Req() request: AuthenticatedRequest): Promise<unknown> {
    const claims = request.authClaims;

    const user = await prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, fullName: true, phoneE164: true, email: true, locale: true },
    });
    if (!user) throw new UnauthorizedException("Not authenticated.");

    // The clinic's currency, for every screen that renders money.
    //
    // It has to come from here because `CLAUDE.md` puts currency in `tenants.currency` and forbids
    // a column or a constant that says EGP. `formatMinor()` in the web app takes the code as a
    // parameter for exactly that reason, and until now nothing supplied it — the only callers were
    // in the component gallery, against a hardcoded `CURRENCY = "EGP"` fixture. The services screen
    // is the first real one, and a screen that formats a price cannot invent the currency it is in.
    //
    // Filtered by the tenant id from the validated token, never from anything the client sent.
    const tenant = await prisma.tenant.findUnique({
      where: { id: claims.tenantId },
      select: { currency: true },
    });
    if (!tenant) throw new UnauthorizedException("Not authenticated.");

    return {
      user,
      membershipId: claims.membershipId,
      tenantId: claims.tenantId,
      currency: tenant.currency,
      role: claims.role,
      memberships: await listActiveMemberships(claims.sub),

      // DISPLAY HINT ONLY -- for hiding controls the user cannot use. It is derived server-side
      // from `role` on every request, so it cannot disagree with enforcement at the moment it is
      // produced, but it is sent to a client and is therefore a claim the client can modify.
      //
      // Nothing may authorise from it: not the client, and not a future server-side caller reading
      // it back. Authorisation is @RequirePermission(capability, level) on the route, evaluated per
      // request against the role in the validated token. A caller that branches on this for
      // anything but rendering is a bug -- test/unit/permission-summary-is-display-only.spec.ts
      // enumerates who may even import it.
      permissions: permissionSummary(claims.role),
    };
  }
}
