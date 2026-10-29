// Connecting (or reconnecting) WhatsApp for a clinic that already exists: the console's per-clinic
// "Connect WhatsApp" button. Operator-only. The Meta code in the body is single-use proof the operator
// just finished our Meta flow for this clinic.

import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { actorContext } from "../../common/actor-context.ts";
import { connectWhatsAppToClinic } from "../whatsapp/whatsapp-attach.ts";
import { AttachWhatsAppDto } from "../whatsapp/whatsapp-attach.dto.ts";
import { recordOperatorAction } from "./platform-audit.ts";
import { PlatformAuthGuard, type PlatformRequest } from "./platform.guard.ts";

@Controller("platform/clinics")
@UseGuards(PlatformAuthGuard)
export class PlatformClinicWhatsAppAttachController {
  @Post(":tenantId/whatsapp")
  @HttpCode(200)
  async connect(
    @Req() request: PlatformRequest,
    @Param("tenantId", ParseUUIDPipe) tenantId: string,
    @Body() body: AttachWhatsAppDto,
  ) {
    const result = await connectWhatsAppToClinic(tenantId, body, {
      ip: request.ip ?? "unknown",
      userAgent: request.header("user-agent") ?? "unknown",
    });

    if (result.ok) {
      await recordOperatorAction(actorContext.getOrThrow(), {
        tenantId,
        action: "UPDATE",
        entityType: "tenants",
        entityId: tenantId,
        // No token, no secret: an audit row is readable by the clinic.
        detail: { whatsapp: result.mode, by: request.platformAdmin.fullName },
      });
      return { mode: result.mode, displayPhoneNumber: result.displayPhoneNumber };
    }

    const reason = result.reason;
    if (reason === "CLINIC_NOT_FOUND") throw new NotFoundException({ reason });
    if (reason === "ALREADY_CONNECTED" || reason === "NUMBER_ALREADY_CONNECTED") throw new ConflictException({ reason });
    if (reason === "META_SETUP_FAILED") throw new BadGatewayException({ reason });
    throw new BadRequestException({ reason });
  }
}
