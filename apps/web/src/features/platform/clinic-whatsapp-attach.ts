// The console's "Connect WhatsApp" button for a clinic that already exists: open Meta's popup, then hand
// what it returns to the server, which attaches the number (or reconnects the same one). The popup logic
// is the same code the new-clinic form and the owner's reconnect button use (../signup/meta-signup.ts).

import type { TranslationKey } from "../../i18n/strings.ts";
import { fetchSignupConfig } from "../signup/signup-api.ts";
import { launchEmbeddedSignup, loadFacebookSdk } from "../signup/meta-signup.ts";
import { connectWhatsApp, keepPlatformSessionAlive, refreshPlatformSession, type ConnectWhatsAppFailure } from "./platform-api.ts";

const FAILURE_TEXT: Record<ConnectWhatsAppFailure, TranslationKey> = {
  CLINIC_NOT_FOUND: "platform.whatsapp.error.CLINIC_NOT_FOUND",
  ALREADY_CONNECTED: "platform.whatsapp.error.ALREADY_CONNECTED",
  NUMBER_ALREADY_CONNECTED: "signup.error.NUMBER_ALREADY_CONNECTED",
  META_CODE_REJECTED: "signup.error.META_CODE_REJECTED",
  META_NUMBER_MISMATCH: "signup.error.META_NUMBER_MISMATCH",
  META_SETUP_FAILED: "signup.error.META_SETUP_FAILED",
  SESSION_EXPIRED: "signup.error.SESSION_EXPIRED",
  UNKNOWN: "signup.error.UNKNOWN",
};

export type AttachWhatsAppResult = { ok: true } | { ok: false; messageKey: TranslationKey };

export async function attachWhatsAppThroughMeta(tenantId: string, existingNumber: boolean): Promise<AttachWhatsAppResult> {
  let stopKeepAlive: (() => void) | undefined;
  try {
    // See clinic-whatsapp-create.ts: renew the operator's token now and keep it alive while Meta's popup is open.
    const [config, sessionOk] = await Promise.all([fetchSignupConfig(), refreshPlatformSession()]);
    if (!sessionOk) return { ok: false, messageKey: "signup.error.SESSION_EXPIRED" };
    if (config === null) return { ok: false, messageKey: "signup.error.notConfigured" };
    stopKeepAlive = keepPlatformSessionAlive();

    const fb = await loadFacebookSdk(config.appId, config.graphVersion);
    const outcome = await launchEmbeddedSignup(fb, config.configId, { existingNumber });
    if (outcome.kind === "cancelled") return { ok: false, messageKey: "signup.error.cancelled" };
    if (outcome.kind === "error") return { ok: false, messageKey: "signup.error.UNKNOWN" };

    const result = await connectWhatsApp(tenantId, outcome.result);
    if (!result.ok) return { ok: false, messageKey: FAILURE_TEXT[result.failure] };
    return { ok: true };
  } catch {
    return { ok: false, messageKey: "signup.error.UNKNOWN" };
  } finally {
    stopKeepAlive?.();
  }
}
