// The Embedded Signup popup's public settings. Used by the console's new-clinic form and by the
// owner's "Reconnect WhatsApp" button; creating a clinic itself is operator-only (platform-api.ts).

export interface SignupConfig {
  appId: string;
  configId: string;
  graphVersion: string;
}

export async function fetchSignupConfig(): Promise<SignupConfig | null> {
  const response = await fetch("/api/public/whatsapp-signup/config");
  return response.ok ? ((await response.json()) as SignupConfig) : null;
}
