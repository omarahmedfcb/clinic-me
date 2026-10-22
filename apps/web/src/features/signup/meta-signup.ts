// Meta's Embedded Signup in the browser: load the JS SDK, launch the flow, and collect the two
// things it hands back separately -- the one-time `code` (FB.login's callback) and the asset ids
// (a `WA_EMBEDDED_SIGNUP` message event). Either can arrive first, so the result resolves when both have.
// https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation

interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents: boolean; xfbml: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null }) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

export interface EmbeddedSignupResult {
  code: string;
  wabaId: string;
  /** Absent for a number moved over from the WhatsApp Business app: Meta's completion event for that
 *  flow names the WABA only, and the server finds the number itself. */
  phoneNumberId?: string;
  businessId?: string;
  /** A number moved over from the WhatsApp Business app is already registered for Cloud API. */
  skipRegistration: boolean;
}

export type EmbeddedSignupOutcome =
  | { kind: "done"; result: EmbeddedSignupResult }
  | { kind: "cancelled" }
  | { kind: "error" };

let sdkReady: Promise<FacebookSdk> | undefined;

// If only one of the two halves (code, asset ids) arrives, give the other this long before failing.
const OTHER_HALF_GRACE_MS = 10_000;

const isFacebookOrigin = (origin: string): boolean => {
  try {
    const host = new URL(origin).hostname;
    return host === "facebook.com" || host.endsWith(".facebook.com");
  } catch {
    return false;
  }
};

export function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  sdkReady ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      if (!window.FB) return reject(new Error("Facebook SDK did not initialise."));
      window.FB.init({ appId, autoLogAppEvents: true, xfbml: true, version });
      resolve(window.FB);
    };
    const script = document.createElement("script");
    script.src = "https://connect.facebook.net/en_US/sdk.js";
    script.async = true;
    script.defer = true;
    script.crossOrigin = "anonymous";
    script.onerror = () => reject(new Error("Could not load the Facebook SDK."));
    document.body.appendChild(script);
  });
  return sdkReady;
}

/**
 * `existingNumber` opens Meta's "connect your existing WhatsApp Business app number" flow
 * (coexistence): the clinic scans a QR code from the Business app and keeps using the number there.
 * Without it Meta runs the default flow, which registers a brand-new number.
 */
export function launchEmbeddedSignup(
  fb: FacebookSdk,
  configId: string,
  options: { existingNumber?: boolean } = {},
): Promise<EmbeddedSignupOutcome> {
  return new Promise((resolve) => {
    let code: string | undefined;
    let assets: Omit<EmbeddedSignupResult, "code"> | undefined;
    let settled = false;
    let graceTimer: number | undefined;

    const finish = (outcome: EmbeddedSignupOutcome): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(graceTimer);
      window.removeEventListener("message", onMessage);
      resolve(outcome);
    };
    const tryFinish = (): void => {
      if (code !== undefined && assets !== undefined) return finish({ kind: "done", result: { code, ...assets } });
      window.clearTimeout(graceTimer);
      graceTimer = window.setTimeout(() => finish({ kind: "error" }), OTHER_HALF_GRACE_MS);
    };

    function onMessage(event: MessageEvent): void {
      if (!isFacebookOrigin(event.origin)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type !== "WA_EMBEDDED_SIGNUP") return;

        if (data.event === "CANCEL") return finish({ kind: "cancelled" });
        if (data.event === "ERROR") {
          console.error("[embedded-signup] Meta reported an error", data);
          return finish({ kind: "error" });
        }

        const wabaId = data.data?.waba_id ?? data.data?.waba_ids?.[0];
        if (typeof data.event !== "string" || !data.event.startsWith("FINISH") || typeof wabaId !== "string") {
          console.warn("[embedded-signup] ignored event", data);
          return;
        }
        // Only the plain FINISH names a number; FINISH_ONLY_WABA and the coexistence event name the
        // WABA alone, and the server then finds the number itself from the clinic's token.
        const phoneNumberId = data.data?.phone_number_id;
        assets = {
          wabaId,
          ...(typeof phoneNumberId === "string" ? { phoneNumberId } : {}),
          businessId: typeof data.data?.business_id === "string" ? data.data.business_id : undefined,
          skipRegistration: data.event === "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
        };
        tryFinish();
      } catch {
        // Not JSON: some other message on the window.
      }
    }
    window.addEventListener("message", onMessage);

    fb.login(
      (response) => {
        const received = response.authResponse?.code;
        if (!received) return finish(assets === undefined ? { kind: "cancelled" } : { kind: "error" });
        code = received;
        tryFinish();
      },
      {
        config_id: configId,
        response_type: "code",
        override_default_response_type: true,
        extras: {
          setup: {},
          ...(options.existingNumber ? { featureType: "whatsapp_business_app_onboarding" } : {}),
        },
      },);
  });
}
