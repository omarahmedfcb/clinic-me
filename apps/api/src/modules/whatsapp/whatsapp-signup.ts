// Clinic creation through Meta Embedded Signup, run by the platform operator from the console. The
// one place that turns "the clinic finished Meta's form" into: a tenant, its OWNER, a bot credential,
// and a WhatsApp connection -- the same four things that used to be a console click plus a hand-pasted .env.
//
// Order is deliberate. Everything that can be refused locally (phones, a taken number, a missing
// key, password hashing) happens BEFORE the Meta code is exchanged, because the code lives 30
// seconds and is single use: a refusal after it is spent costs the clinic the whole Meta flow.

import { uuidv7 } from "uuidv7";
import { prisma } from "../../prisma/client.ts";
import { injected } from "../../prisma/injected.ts";
import { withPlatformActor, withTenant, type ActorContext } from "../../prisma/with-tenant.ts";
import { systemActor } from "../audit/system-actor.ts";
import { hashPassword } from "../auth/password.ts";
import { normalisePhone } from "../auth/phone.ts";
import { issueBotCredential } from "../bot/bot-credential.service.ts";
import { generateTemporaryPassword } from "../memberships/staff.service.ts";
import { newTenantData, type SupportedCountry } from "../platform/new-clinic.ts";
import { setClinicSuspension } from "../platform/platform-clinics.ts";
import { encryptSecret, loadEncryptionKey } from "./connection-crypto.ts";
import {
  exchangeSignupCode,
  findAuthorizedNumber,
  MetaOnboardingError,
  registerPhoneNumber,
  resolveAuthorizedNumber,
  subscribeAppToWaba,
} from "./meta-onboarding.ts";
import { accessTokenAad, botSecretAad } from "./whatsapp-connections.ts";
import { buildClinicSlug, randomRegistrationPin } from "./whatsapp-signup-helpers.ts";
import { runCoexistenceSync } from "./whatsapp-coexistence.ts";

export interface SignupInput {
  clinicName: string;
  clinicNameEn?: string;
  /** Typed by the operator, like the console's own form. Absent: built from the English name. */
  slug?: string;
  timezone: string;
  country: SupportedCountry;
  currency: string;
  address: string;
  clinicPhone: string;
  ownerFullName: string;
  ownerPhone: string;
  /** From `FB.login`'s authResponse. */
  code: string;
  /** From the `WA_EMBEDDED_SIGNUP` message event: the browser's claim, verified against Meta below. */
  wabaId: string;
  /** Absent when the number came from the WhatsApp Business app: Meta's completion event names the
   *  WABA only, so the server finds the number from the clinic's own token. */
  phoneNumberId?: string;
  businessId?: string;
  /** True for a number migrated from the WhatsApp Business app (coexistence): already registered. */
  skipRegistration: boolean;
}

export type SignupRefusal =
  | "INVALID_PHONE"
  | "OWNER_PHONE_TAKEN"
  | "SLUG_TAKEN"
  | "NUMBER_ALREADY_CONNECTED"
  | "META_CODE_REJECTED"
  | "META_NUMBER_MISMATCH"
  | "META_SETUP_FAILED";

export type SignupResult =
  | { ok: true; tenantId: string; ownerUserId: string; displayPhoneNumber: string | null; temporaryPassword: string }
  | { ok: false; reason: SignupRefusal };

export async function signUpClinic(input: SignupInput, request: { ip: string; userAgent: string }): Promise<SignupResult> {
  // Configuration, read first so a missing value is a 500 before anything is spent. Country,
  // timezone and currency now come from the operator's form, as in the console's own create-clinic.
  const { country, timezone, currency } = input;
  const key = loadEncryptionKey();

  const ownerPhone = normalisePhone(input.ownerPhone, country);
  const clinicPhone = normalisePhone(input.clinicPhone, country);
  if (ownerPhone === null || clinicPhone === null) return { ok: false, reason: "INVALID_PHONE" };

  const phoneTaken = await prisma.user.findFirst({ where: { phoneE164: ownerPhone }, select: { id: true } });
  if (phoneTaken !== null) return { ok: false, reason: "OWNER_PHONE_TAKEN" };

  const isTaken = async (phoneNumberId: string): Promise<boolean> =>
    (await prisma.tenant.findFirst({ where: { whatsappPhoneNumberId: phoneNumberId }, select: { id: true } })) !== null;
  if (input.phoneNumberId !== undefined && (await isTaken(input.phoneNumberId))) {
    return { ok: false, reason: "NUMBER_ALREADY_CONNECTED" };
  }

  const slug = input.slug ?? buildClinicSlug(input.clinicNameEn);
  if ((await prisma.tenant.findFirst({ where: { slug }, select: { id: true } })) !== null) {
    return { ok: false, reason: "SLUG_TAKEN" };
  }

  // The operator never learns a password the owner chose: a temporary one, replaced at first sign-in.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  // ---- Meta -------------------------------------------------------------------------------------
  let accessToken: string;
  try {
    accessToken = (await exchangeSignupCode(input.code)).accessToken;
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.warn(`WhatsApp signup: ${error.message}`);
      return { ok: false, reason: "META_CODE_REJECTED" };
    }
    throw error;
  }

  let number;
  try {
    number = await resolveAuthorizedNumber(accessToken, input.wabaId, input.phoneNumberId ?? null);
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.warn(`WhatsApp signup: ${error.message}`);
      return { ok: false, reason: "META_NUMBER_MISMATCH" };
    }
    throw error;
  }
  if (number === null) return { ok: false, reason: "META_NUMBER_MISMATCH" };
  // When the browser named no number, the one found above is only now known to be free.
  if (await isTaken(number.phoneNumberId)) return { ok: false, reason: "NUMBER_ALREADY_CONNECTED" };

  const numberMode = input.skipRegistration ? "COEXISTENCE" : "NEW_NUMBER";
  if (input.skipRegistration !== number.isOnBizApp) {
    // The browser's claim and Meta's record disagree. The claim only picks the flow; log the mismatch.
    console.warn(`WhatsApp signup: browser said skipRegistration=${input.skipRegistration}, Meta says is_on_biz_app=${number.isOnBizApp}`);
  }

  try {
    await subscribeAppToWaba(accessToken, input.wabaId);
    if (!input.skipRegistration) {
      await registerPhoneNumber(accessToken, number.phoneNumberId, randomRegistrationPin());
    }
  } catch (error) {
    if (error instanceof MetaOnboardingError) {
      console.error(`WhatsApp signup: ${error.message}`);
      return { ok: false, reason: "META_SETUP_FAILED" };
    }
    throw error;
  }

  // ---- Our side ---------------------------------------------------------------------------------
  const tenantData = newTenantData({
    name: input.clinicName,
    nameEn: input.clinicNameEn ?? null,
    slug,
    phone: clinicPhone,
    address: input.address,
    timezone,
    country,
    currency,
  });
  const tenantId = tenantData.id;
  const ownerUserId = uuidv7();
  const system: ActorContext = { ...(await systemActor()), ip: request.ip, userAgent: request.userAgent };
  // From here the new owner is the actor: the audit trail says who signed the clinic up.
  const owner: ActorContext = { userId: ownerUserId, ip: request.ip, userAgent: request.userAgent };

  // Tenant and owner in one unbound transaction, exactly as the platform console's createClinic does.
  await withPlatformActor(system, async (tx) => {
    await tx.tenant.create({ data: { ...tenantData, whatsappPhoneNumberId: number.phoneNumberId } });
    await tx.user.create({
      data: {
        id: ownerUserId,
        fullName: input.ownerFullName,
        phoneE164: ownerPhone,
        passwordHash,
        mustChangePassword: true,
        status: "ACTIVE",
      },
    });
  });

  try {
    // The owner holds no membership yet, so this one write is attributed to the system actor.
    await withTenant(tenantId, system, (tx) =>
      tx.membership.create({ data: injected({ id: uuidv7(), userId: ownerUserId, role: "OWNER", status: "ACTIVE" }) }),
    );

    // The existing issuance path, unchanged: its AI_AGENT membership is what makes a clinic bookable.
    const issued = await issueBotCredential({ tenantId, actor: owner }, new Date());
    if (!issued.ok) throw new Error("A clinic created a moment ago already had a live bot credential.");

    await withTenant(tenantId, owner, (tx) =>
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
    // The tenant and owner exist and the bot half does not. Leaving that clinic ACTIVE would be a
    // clinic that signed in to a bot that never answers; suspending it puts it in the operator's
    // console with a reason, which is where somebody will look.
    console.error(`WhatsApp signup: tenant ${tenantId} was created but did not finish`, error);
    await setClinicSuspension(system, tenantId, {
      suspended: true,
      reason: "WhatsApp setup did not finish; needs an operator.",
    }).catch((suspendError: unknown) => console.error("WhatsApp signup: could not suspend", suspendError));
    throw error;
  }

  // Meta's 24-hour window for the contactsn and history syncs starts now. Not awaited: the clinic is
  // already signed up, and a failure here is logged for the operator rather than shown to them.
  if (numberMode === "COEXISTENCE") void runCoexistenceSync(tenantId, accessToken, number.phoneNumberId);

  return { ok: true, tenantId, ownerUserId, displayPhoneNumber: number.displayPhoneNumber, temporaryPassword };
}
