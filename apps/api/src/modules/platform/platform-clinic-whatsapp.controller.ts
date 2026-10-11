// Creating a clinic together with its WhatsApp connection: the console's new-clinic form, final step.
// Operator-only. The Meta code in the body is single-use proof the clinic just finished our Meta flow.

import { BadGatewayException, BadRequestException, Body, ConflictException, Controller, HttpCode, Post, Req, UseGuards } from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { WhatsAppSignupDto } from "../whatsapp/whatsapp-signup.dto.ts";
import { signUpClinic, type SignupRefusal } from "../whatsapp/whatsapp-signup.ts";
import { recordOperatorAction } from "./platform-audit.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

@Controller("platform/clinics/whatsapp")
@UseGuards(PlatformAuthGuard)
export class PlatformClinicWhatsAppController {
  @Post()
  @HttpCode(201)
  async create(@Req() request: PlatformRequest, @Body() body: WhatsAppSignupDto) {
    const result = await signUpClinic(body, {
      ip: request.ip ?? "unknown",
      userAgent: request.header("user-agent") ?? "unknown",
    });

    if (result.ok) {
      await recordOperatorAction(actorContext.getOrThrow(), {
        tenantId: result.tenantId,
        action: "CREATE",
        entityType: "tenants",
        entityId: result.tenantId,
        // The temporary password is not in here, and must never be: an audit row is readable by the clinic.
        detail: { name: body.clinicName, slug: body.slug, whatsapp: true, by: request.platformAdmin.fullName },
      });
      return {
        tenantId: result.tenantId,
        adminUserId: result.ownerUserId,
        displayPhoneNumber: result.displayPhoneNumber,
        temporaryPassword: result.temporaryPassword,
      };
    }

    const reason: SignupRefusal = result.reason;
    // 409: something the operator can fix by changing a value. 400/502: the Meta side, nothing to retype.
    if (reason === "OWNER_PHONE_TAKEN" || reason === "NUMBER_ALREADY_CONNECTED" || reason === "SLUG_TAKEN") {
      throw new ConflictException({ reason });
    }
    if (reason === "META_SETUP_FAILED") throw new BadGatewayException({ reason });
    throw new BadRequestException({ reason });
  }
}
