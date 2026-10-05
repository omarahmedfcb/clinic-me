import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { RetryAfterThrottlerGuard, ThrottleOnly } from "../../common/throttlers.ts";
import { META_GRAPH_VERSION } from "./meta-onboarding.ts";
import { signUpClinic, type SignupRefusal } from "./whatsapp-signup.ts";
import { WhatsAppSignupDto } from "./whatsapp-signup.dto.ts";
import {
  WHATSAPP_SIGNUP_LIMIT,
  WHATSAPP_SIGNUP_THROTTLER,
  WHATSAPP_SIGNUP_WINDOW_MS,
} from "./whatsapp-signup-throttle.ts";

/**
 * Where Meta's Embedded Signup becomes a clinic. Public by construction -- the person calling has
 * no clinic, no membership and no token yet -- so there is no `AuthGuard` and no `TenantGuard`, the
 * same way webchat.controller.ts has none. What stands in for authentication is Meta: the code in
 * the body is single-use proof the clinic just completed our Meta flow, and the service verifies the
 * WABA and number against it before anything is created.
 *
 * Its failures are `{ reason }` bodies, not refusal codes: this page is self-contained and public,
 * and renders its own two-language messages (see SignupPage.tsx) rather than the clinic app's table.
 */
@Controller("public/whatsapp-signup")
export class WhatsAppSignupController {
  /** What the page needs to start Meta's flow. All three are public by design -- none is a secret. */
  @Get("config")
  config() {
    const appId = process.env["WHATSAPP_APP_ID"];
    const configId = process.env["WHATSAPP_ES_CONFIG_ID"];
    if (!appId || !configId) {
      throw new BadGatewayException({ reason: "NOT_CONFIGURED" });
    }
    return { appId, configId, graphVersion: META_GRAPH_VERSION };
  }

  @Post()
  @UseGuards(RetryAfterThrottlerGuard)
  @ThrottleOnly(WHATSAPP_SIGNUP_THROTTLER, WHATSAPP_SIGNUP_LIMIT, WHATSAPP_SIGNUP_WINDOW_MS)
  async signUp(@Req() request: Request, @Body() body: WhatsAppSignupDto) {
    const result = await signUpClinic(body, {
      ip: request.ip ?? "unknown",
      userAgent: request.header("user-agent") ?? "unknown",
    });
    if (result.ok) return { tenantId: result.tenantId, displayPhoneNumber: result.displayPhoneNumber };

    const reason: SignupRefusal = result.reason;
    // 409: something the caller can fix by changing a value. 400/502: the Meta side, nothing to retype.
    if (reason === "OWNER_PHONE_TAKEN" || reason === "NUMBER_ALREADY_CONNECTED") {
      throw new ConflictException({ reason });
    }
    if (reason === "META_SETUP_FAILED") throw new BadGatewayException({ reason });
    throw new BadRequestException({ reason });
  }
}
