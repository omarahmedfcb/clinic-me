// Connecting WhatsApp to a clinic that already exists on the platform -- one that was created without
// it, or whose connection needs attention. Operator-run from the console, through Meta's Embedded
// Signup, exactly like the new-clinic form's WhatsApp option minus the tenant and owner creation.
//
// Same ordering rule as signup.ts: everything that can be refused locally happens BEFORE the Meta code
// is exchanged, because the code lives 30 seconds and is single use.
//
//   no connection row      -> attach (bot credential, number, connection)
//   connection, not ACTIVE -> reconnect the same number with a fresh token (whatsapp-reconnect.ts)
//   connection, ACTIVE     -> refused: there is nothing to do

import { uuidv7 } from "uuidv7";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withPlatformActor, withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { issueBotCredential, revokeBotCredential } from "../bot/bot-credential.service.ts";
import { encryptSecret, loadEncryptionKey } from "./connection-crypto.ts";
import {
  exchangeSignupCode,
  MetaOnboardingError,
  registerPhoneNumber,
  resolveAuthorizedNumber,
  subscribeAppToWaba,
} from "./meta-onboarding.ts";
import { runCoexistenceSync } from "./whatsapp-coexistence.ts";
import { accessTokenAad, botSecretAad } from "./whatsapp-connections.ts";
import { reconnectWhatsApp } from "./whatsapp-reconnect.ts";
import { randomRegistrationPin } from "./whatsapp-signup-helpers.ts";

export interface AttachInput {
  /** From `FB.login`'s authResponse. */
  code: string;
  /** From the `WA_EMBEDDED_SIGNUP` event: the browser's claim, verified against Meta below. */
  wabaId: string;
  phoneNumberId?: string;
  businessId?: string;
  /** True for a number migrated from the WhatsApp Business app (coexistence): already registered. */
  skipRegistration: boolean;
}

export type AttachRefusal =
  | "CLINIC_NOT_FOUND"
  | "ALREADY_CONNECTED"
  | "NUMBER_ALREADY_CONNECTED"
  | "META_CODE_REJECTED"
  | "META_NUMBER_MISMATCH"
  | "META_SETUP_FAILED";

export type AttachResult =
  | { ok: true; mode: "ATTACHED" | "RECONNECTED"; displayPhoneNumber: string | null }
  | { ok: false; reason: AttachRefusal };

export async function connectWhatsAppToClinic(
  tenantId: string,
  input: AttachInput,
  request: { ip: string; userAgent: string },
): Promise<AttachResult> {
  const key = loadEncryptionKey();
  const system: ActorContext = { ...(await systemActor()), ip: request.ip, userAgent: request.userAgent };

  const tenant = await prisma.tenant.findFirst({ where: { id: tenantId }, select: { id: true } });
  if (tenant === null) return { ok: false, reason: "CLINIC_NOT_FOUND" };

  const existing = await withTenant(tenantId, system, (tx) =>
    tx.whatsAppConnection.findFirst({ select: { status: true, displayPhoneNumber: true } }),
  );

  if (existing !== null) {
    if (existing.status === "ACTIVE") return { ok: false, reason: "ALREADY_CONNECTED" };
    const reconnected = await reconnectWhatsApp(
      { tenantId, actor: system },
      {
        code: input.code,
        wabaId: input.wabaId,
        ...(input.phoneNumberId === undefined ? {} : { phoneNumberId: input.phoneNumberId }),
      },
    );
    if (!reconnected.ok) {
      // A clinic that has a row can never be "NO_CONNECTION"; it would mean the row vanished mid-request.
      return { ok: false, reason: reconnected.reason === "NO_CONNECTION" ? "META_SETUP_FAILED" : reconnected.reason };
    }
    return { ok: true, mode: "RECONNECTED", displayPhoneNumber: existing.displayPhoneNumber };
  }

  const isTaken = async (phoneNumberId: string): Promise<boolean> =>
    (await prisma.tenant.findFirst({ where: { whatsappPhoneNumberId: phoneNumberId }, select: { id: true } })) !== null;
  if (input.phoneNumberId !== undefined && (await isTaken(input.phoneNumberId))) {
    return { ok: false, reason: "NUMBER_ALREADY_CONNECTED" };
  }

  // ---- Meta -------------------------------------------------------------------------------------
  let accessToken: string;
  try {
    accessToken = (await exchangeSignupCode(input.code)).accessToken;
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.warn(`WhatsApp attach: ${error.message}`);
      return { ok: false, reason: "META_CODE_REJECTED" };
    }
    throw error;
  }

  let number;
  try {
    number = await resolveAuthorizedNumber(accessToken, input.wabaId, input.phoneNumberId ?? null);
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.warn(`WhatsApp attach: ${error.message}`);
      return { ok: false, reason: "META_NUMBER_MISMATCH" };
    }
    throw error;
  }
  if (number === null) return { ok: false, reason: "META_NUMBER_MISMATCH" };
  if (await isTaken(number.phoneNumberId)) return { ok: false, reason: "NUMBER_ALREADY_CONNECTED" };

  const numberMode = input.skipRegistration ? "COEXISTENCE" : "NEW_NUMBER";

  try {
    await subscribeAppToWaba(accessToken, input.wabaId);
    if (!input.skipRegistration) {
      await registerPhoneNumber(accessToken, number.phoneNumberId, randomRegistrationPin());
    }
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.error(`WhatsApp attach: ${error.message}`);
      return { ok: false, reason: "META_SETUP_FAILED" };
    }
    throw error;
  }

  // ---- Our side ---------------------------------------------------------------------------------
  // The number is claimed on the tenant first: its unique index is what settles two operators racing.
  try {
    await withPlatformActor(system, (tx) =>
      tx.tenant.update({ where: { id: tenantId }, data: { whatsappPhoneNumberId: number.phoneNumberId } }),
    );
  } catch (error) {
    console.error(`WhatsApp attach: could not claim the number for tenant ${tenantId}`, error);
    return { ok: false, reason: "NUMBER_ALREADY_CONNECTED" };
  }

  try {
    const ctx = { tenantId, actor: system };
    let issued = await issueBotCredential(ctx, new Date());
    if (!issued.ok) {
      // A clinic with no connection row has no bot consumer for a leftover credential (a signup that
      // stopped halfway leaves one). Replace it rather than strand the clinic.
      await revokeBotCredential(ctx, new Date());
      issued = await issueBotCredential(ctx, new Date());
      if (!issued.ok) throw new Error("Could not issue a bot credential for the clinic.");
    }

    await withTenant(tenantId, system, (tx) =>
      tx.whatsAppConnection.create({
        data: injected({
          id: uuidv7(),
          wabaId: input.wabaId,
          phoneNumberId: number.phoneNumberId,
          numberMode,
          businessId: input.businessId ?? null,
          displayPhoneNumber: number.displayPhoneNumber,
          verifiedName: number.verifiedName,
          accessTokenEnc: encryptSecret(accessToken, key, accessTokenAad(tenantId)),
          botCredentialId: issued.credentialId,
          botSecretEnc: encryptSecret(issued.secret, key, botSecretAad(tenantId)),
        }),
      }),
    );
  } catch (error) {
    // The clinic is live and stays live. Give the number back so the operator can simply try again.
    console.error(`WhatsApp attach: tenant ${tenantId} did not finish`, error);
    await withPlatformActor(system, (tx) =>
      tx.tenant.update({ where: { id: tenantId }, data: { whatsappPhoneNumberId: null } }),
    ).catch((undoError: unknown) => console.error("WhatsApp attach: could not release the number", undoError));
    throw error;
  }

  if (numberMode === "COEXISTENCE") void runCoexistenceSync(tenantId, accessToken, number.phoneNumberId);

  return { ok: true, mode: "ATTACHED", displayPhoneNumber: number.displayPhoneNumber };
}
