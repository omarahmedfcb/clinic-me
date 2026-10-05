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
  phoneNumberId: string;
  businessId?: string;
  /** A number moved over from the WhatsApp Business app is already registered for Cloud API. */
  skipRegistration: boolean;
}

export type EmbeddedSignupOutcome =
  | { kind: "done"; result: EmbeddedSignupResult }
  | { kind: "cancelled" }
  | { kind: "error" };

let sdkReady: Promise<FacebookSdk> | undefined;

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

export function launchEmbeddedSignup(fb: FacebookSdk, configId: string): Promise<EmbeddedSignupOutcome> {
  return new Promise((resolve) => {
    let code: string | undefined;
    let assets: Omit<EmbeddedSignupResult, "code"> | undefined;
    let settled = false;

    const finish = (outcome: EmbeddedSignupOutcome): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      resolve(outcome);
    };
    const tryFinish = (): void => {
      if (code !== undefined && assets !== undefined) finish({ kind: "done", result: { code, ...assets } });
    };

    function onMessage(event: MessageEvent): void {
      if (!event.origin.endsWith("facebook.com")) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type !== "WA_EMBEDDED_SIGNUP") return;

        if (data.event === "CANCEL") return finish({ kind: "cancelled" });
        if (data.event === "ERROR") return finish({ kind: "error" });

        const wabaId = data.data?.waba_id ?? data.data?.waba_ids?.[0];
        const phoneNumberId = data.data?.phone_number_id;
        if (typeof wabaId !== "string" || typeof phoneNumberId !== "string") return;
        assets = {
          wabaId,
          phoneNumberId,
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
        if (!received) return finish({ kind: "cancelled" });
        code = received;
        tryFinish();
      },
      { config_id: configId, response_type: "code", override_default_response_type: true, extras: { setup: {} } },
    );
  });
}
