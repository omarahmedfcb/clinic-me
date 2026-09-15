import { Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { Body } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { LoginDto } from "../auth/auth.dto.ts";
import { normalisePhone, loginCountry } from "../auth/phone.ts";
import { verifyCredentials } from "../auth/user-lookup.ts";
import { issuePlatformToken } from "./platform-token.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

/** The same sentence for every way of failing to sign in. */
const INVALID_CREDENTIALS = "Invalid credentials.";

/**
 * The operator's surface — pilot-readiness 0a. **It reads no tenant-scoped row, ever.**
 *
 * Nothing here calls `withTenant`, so `app.current_tenant_id` is never bound and every RLS policy
 * on every clinical and financial table evaluates false. That is not a rule this controller follows;
 * it is a property of not having a tenant, and `platform-isolation.integration.spec.ts` holds it by
 * querying those tables from an operator's session and requiring zero rows.
 *
 * **A separate login from the clinic's**, because `POST /auth/login` requires an active membership
 * and an operator has none — it would answer `INVALID_CREDENTIALS` to a valid operator. Sharing the
 * route would have meant teaching it about an account with no clinic, which is the coupling this
 * whole item exists to avoid.
 */
@Controller("platform")
export class PlatformController {
  /**
   * Throttled like the clinic login, and for the same reason: Argon2id is deliberately slow, so an
   * unthrottled verify is a cheap way to make the server do expensive work.
   */
  @Post("login")
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  async login(@Body() body: LoginDto): Promise<{ accessToken: string; fullName: string }> {
    // No early return, matching the clinic login: an unparseable identifier costs the same verify
    // as a real one, so timing does not distinguish them.
    const identifier = normalisePhone(body.identifier, loginCountry()) ?? body.identifier;
    const user = await verifyCredentials(identifier, body.password);

    // **The flag is checked here and again on every request** (see `PlatformAuthGuard`). A clinic
    // account that is not an operator gets the same answer as a wrong password: whether an account
    // exists and merely lacks the flag is not something an unauthenticated caller should learn.
    if (!user || !user.isPlatformAdmin) throw new UnauthorizedException(INVALID_CREDENTIALS);

    return { accessToken: await issuePlatformToken(user.id), fullName: user.fullName };
  }

  /** Who the operator is. The whole of 0a's surface — the clinic list and the rest are 0b onwards. */
  @Get("me")
  @UseGuards(PlatformAuthGuard)
  me(@Req() request: PlatformRequest): { userId: string; fullName: string } {
    return request.platformAdmin;
  }
}
