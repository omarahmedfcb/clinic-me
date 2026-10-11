import { BadGatewayException, Controller, Get } from "@nestjs/common";
import { META_GRAPH_VERSION } from "./meta-onboarding.ts";

/**
 * What the browser needs to start Meta's Embedded Signup popup: used by the platform console's
 * new-clinic form and by the clinic owner's "Reconnect WhatsApp" button. All three values are public
 * by design -- none is a secret. Creating a clinic is operator-only (platform-clinic-whatsapp.controller.ts).
 */
@Controller("public/whatsapp-signup")
export class WhatsAppSignupController {
  @Get("config")
  config() {
    const appId = process.env["WHATSAPP_APP_ID"];
    const configId = process.env["WHATSAPP_ES_CONFIG_ID"];
    if (!appId || !configId) {
      throw new BadGatewayException({ reason: "NOT_CONFIGURED" });
    }
    return { appId, configId, graphVersion: META_GRAPH_VERSION };
  }
}
