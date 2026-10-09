// A clinic whose WhatsApp connection stopped working (token no longer valid, our app removed, Meta
// disconnected the number) runs Embedded Signup again from inside the app. No new clinic, no new
// owner: the same number gets a fresh token and the connection goes back to ACTIVE.

import { withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { encryptSecret, loadEncryptionKey } from "./connection-crypto.ts";
import { runCoexistenceSync } from "./whatsapp-coexistence.ts";
import { accessTokenAad } from "./whatsapp-connections.ts";
import { exchangeSignupCode, MetaOnboardingError, resolveAuthorizedNumber, subscribeAppToWaba } from "./meta-onboarding.ts";

export type ReconnectResult =
  | { ok: true }
  | { ok: false; reason: "NO_CONNECTION" | "META_CODE_REJECTED" | "META_NUMBER_MISMATCH" | "META_SETUP_FAILED" };

export async function reconnectWhatsApp(
  caller: { tenantId: string; actor: ActorContext },
  input: { code: string; wabaId: string; phoneNumberId?: string },
): Promise<ReconnectResult> {
  const key = loadEncryptionKey();

  const existing = await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.whatsAppConnection.findFirst({ select: { phoneNumberId: true, numberMode: true } }),
  );
  if (existing === null) return { ok: false, reason: "NO_CONNECTION" };

  let accessToken: string;
  try {
    accessToken = (await exchangeSignupCode(input.code)).accessToken;
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.warn(`WhatsApp reconnect: ${error.message}`);
      return { ok: false, reason: "META_CODE_REJECTED" };
    }
    throw error;
  }

  let number;
  try {
    number = await resolveAuthorizedNumber(accessToken, input.wabaId, input.phoneNumberId ?? null);
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.warn(`WhatsApp reconnect: ${error.message}`);
      return { ok: false, reason: "META_NUMBER_MISMATCH" };
    }
    throw error;
  }
  // Reconnecting is for THIS clinic's number. A different one is a different clinic's connection.
  if (number === null || number.phoneNumberId !== existing.phoneNumberId) {
    return { ok: false, reason: "META_NUMBER_MISMATCH" };
  }

  try {
    await subscribeAppToWaba(accessToken, input.wabaId);
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.error(`WhatsApp reconnect: ${error.message}`);
      return { ok: false, reason: "META_SETUP_FAILED" };
    }
    throw error;
  }

  await withTenant(caller.tenantId, caller.actor, (tx) =>
    tx.whatsAppConnection.updateMany({
      where: { tenantId: caller.tenantId },
      data: {
        wabaId: input.wabaId,
        accessTokenEnc: encryptSecret(accessToken, key, accessTokenAad(caller.tenantId)),
        status: "ACTIVE",
        disconnectReason: null,
        statusChangedAt: new Date(),
        syncRequestedAt: null,
      },
    }),
  );

  // A coexistence number that was disconnected is onboarded afresh, with a fresh 24-hour window.
  if (existing.numberMode === "COEXISTENCE") {
    void runCoexistenceSync(caller.tenantId, accessToken, existing.phoneNumberId);
  }
  return { ok: true };
}
