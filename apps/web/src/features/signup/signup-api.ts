// The public signup's two calls. No token, no cookie: the person has no clinic yet.

export interface SignupConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export interface SignupPayload {
  clinicName: string;
  clinicNameEn?: string;
  address: string;
  clinicPhone: string;
  ownerFullName: string;
  ownerPhone: string;
  password: string;
  code: string;
  wabaId: string;
  phoneNumberId?: string;
  businessId?: string;
  skipRegistration: boolean;
}

export type SignupFailure =
  | "INVALID_PHONE"
  | "OWNER_PHONE_TAKEN"
  | "NUMBER_ALREADY_CONNECTED"
  | "META_CODE_REJECTED"
  | "META_NUMBER_MISMATCH"
  | "META_SETUP_FAILED"
  | "INVALID_FIELD"
  | "RATE_LIMITED"
  | "UNKNOWN";

export async function fetchSignupConfig(): Promise<SignupConfig | null> {
  const response = await fetch("/api/public/whatsapp-signup/config");
  return response.ok ? ((await response.json()) as SignupConfig) : null;
}

export async function submitSignup(
  payload: SignupPayload,
): Promise<{ ok: true; displayPhoneNumber: string | null } | { ok: false; failure: SignupFailure }> {
  const response = await fetch("/api/public/whatsapp-signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (response.ok) {
    const data = (await response.json()) as { displayPhoneNumber: string | null };
    return { ok: true, displayPhoneNumber: data.displayPhoneNumber };
  }
  if (response.status === 429) return { ok: false, failure: "RATE_LIMITED" };

  const body = (await response.json().catch(() => ({}))) as { reason?: string; code?: string };
  const known: SignupFailure[] = [
    "INVALID_PHONE", "OWNER_PHONE_TAKEN", "NUMBER_ALREADY_CONNECTED",
    "META_CODE_REJECTED", "META_NUMBER_MISMATCH", "META_SETUP_FAILED",
  ];
  const reason = known.find((value) => value === body.reason);
  if (reason) return { ok: false, failure: reason };
  return { ok: false, failure: body.code === "INVALID_FIELD" ? "INVALID_FIELD" : "UNKNOWN" };
}
