// The new-clinic form's WhatsApp step: open Meta's popup, then create the clinic from what it returns.
// The popup logic is the same code the owner's reconnect button uses (../signup/meta-signup.ts).

import type { TranslationKey } from "../../i18n/strings.ts";
import { fetchSignupConfig } from "../signup/signup-api.ts";
import { launchEmbeddedSignup, loadFacebookSdk } from "../signup/meta-signup.ts";
import { createClinicWithWhatsApp, type NewClinicInput } from "./platform-api.ts";

export type ClinicWithWhatsAppResult =
  | { ok: true; who: string; temporaryPassword: string }
  | { ok: false; messageKey: TranslationKey };

export async function createClinicThroughMeta(
  draft: NewClinicInput,
  existingNumber: boolean,
): Promise<ClinicWithWhatsAppResult> {
  try {
    const config = await fetchSignupConfig();
    if (config === null) return { ok: false, messageKey: "signup.error.notConfigured" };

    const fb = await loadFacebookSdk(config.appId, config.graphVersion);
    const outcome = await launchEmbeddedSignup(fb, config.configId, { existingNumber });
    if (outcome.kind === "cancelled") return { ok: false, messageKey: "signup.error.cancelled" };
    if (outcome.kind === "error") return { ok: false, messageKey: "signup.error.UNKNOWN" };

    const nameEn = (draft.nameEn ?? "").trim();
    const result = await createClinicWithWhatsApp({
      clinicName: draft.name.trim(),
      ...(nameEn === "" ? {} : { clinicNameEn: nameEn }),
      slug: draft.slug.trim(),
      timezone: draft.timezone.trim(),
      country: draft.country,
      currency: draft.currency,
      address: draft.address.trim(),
      clinicPhone: draft.phone.trim(),
      ownerFullName: draft.adminFullName.trim(),
      ownerPhone: draft.adminPhone.trim(),
      subscriptionStartsOn: draft.subscriptionStartsOn,
      renewalOn: draft.renewalOn,
      ...outcome.result,
    });
    if (!result.ok) return { ok: false, messageKey: `signup.error.${result.failure}` as TranslationKey };
    return { ok: true, who: draft.adminFullName, temporaryPassword: result.temporaryPassword };
  } catch {
    return { ok: false, messageKey: "signup.error.UNKNOWN" };
  }
}
