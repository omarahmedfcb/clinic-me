// Where a webhook may point. A10: a URL that resolves inside our own network is refused.
// Pure: no database and no DNS here — the lookup is injected, so the rule can be tested directly.

import { botSandboxEnabled } from "./sandbox-policy.ts";

/**
 * **The one outbound request this API makes on a tenant's behalf is the webhook delivery**, and its
 * address is chosen by a clinic administrator. Without this check, an administrator who registers
 * `https://10.0.0.5/` gets a delivery attempt to a private address — a small blast radius, since the
 * body carries a first name, a time and our ids, and the caller is already an administrator of that
 * clinic, but a real one.
 *
 * Refused **twice**: when the URL is set, so the mistake is visible while somebody is looking at a
 * screen, and again at send time, because DNS is not a promise. A name that resolved publicly on
 * Monday can resolve to `127.0.0.1` on Tuesday, and the send-time check is what closes that.
 */
export type AddressRefusal = "NOT_HTTPS" | "PRIVATE_ADDRESS" | "UNRESOLVABLE";

/** IPv4 and IPv6 ranges that never belong to somebody else's server. */
function isPrivateAddress(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, "");

  // IPv6: loopback, link-local (fe80::/10) and unique-local (fc00::/7), plus IPv4-mapped forms.
  if (value.includes(":")) {
    if (value === "::1" || value === "::") return true;
    if (/^fe[89ab]/.test(value)) return true;
    if (/^f[cd]/.test(value)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    return mapped === null ? false : isPrivateAddress(mapped[1] as string);
  }

  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];

  return (
    a === 0 || // "this network"
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, and the cloud metadata address 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    a >= 224 // multicast and reserved
  );
}

/** A hostname that needs no DNS to be recognised as ours. */
function isLoopbackName(hostname: string): boolean {
  const name = hostname.toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name === "localhost.localdomain";
}

export interface AddressCheck {
  /** Resolves a hostname to addresses. Injected so this module needs no `node:dns` at import time. */
  resolve: (hostname: string) => Promise<string[]>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Whether this URL may be called, given who we are.
 *
 * The sandbox's loopback exception survives, and stays gated: `BOT_SANDBOX=on` is what allows an
 * `http://localhost` receiver, and the API refuses to boot with that flag under
 * `NODE_ENV=production` (`sandbox-policy.ts`). So the exception cannot exist on a server holding a
 * clinic's data, which is the property that matters.
 */
export async function checkWebhookAddress(
  url: string,
  deps: AddressCheck,
): Promise<{ ok: true } | { ok: false; code: AddressRefusal }> {
  const sandbox = botSandboxEnabled(deps.env ?? process.env);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "NOT_HTTPS" };
  }

  if (parsed.protocol !== "https:") {
    // The sandbox may call a loopback receiver over plain HTTP; nothing else may.
    if (!(sandbox && parsed.protocol === "http:" && isLoopbackName(parsed.hostname))) {
      return { ok: false, code: "NOT_HTTPS" };
    }
    return { ok: true };
  }

  if (isLoopbackName(parsed.hostname)) {
    return sandbox ? { ok: true } : { ok: false, code: "PRIVATE_ADDRESS" };
  }

  // A literal address needs no lookup, and a lookup would not make it less private.
  if (isPrivateAddress(parsed.hostname)) {
    return sandbox ? { ok: true } : { ok: false, code: "PRIVATE_ADDRESS" };
  }

  let addresses: string[];
  try {
    addresses = await deps.resolve(parsed.hostname);
  } catch {
    // A name nobody can resolve is not a name we call. Saying so is also kinder than a delivery
    // that fails silently for a day and is then given up on.
    return { ok: false, code: "UNRESOLVABLE" };
  }

  if (addresses.length === 0) return { ok: false, code: "UNRESOLVABLE" };
  // **Every** address, not the first: a name with one public and one private answer is the shape a
  // rebinding attack takes.
  if (addresses.some((address) => isPrivateAddress(address))) {
    return sandbox ? { ok: true } : { ok: false, code: "PRIVATE_ADDRESS" };
  }

  return { ok: true };
}

/** The production resolver. Separated so nothing in a unit spec touches DNS. */
export async function resolveHostname(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const answers = await lookup(hostname, { all: true });
  return answers.map((answer) => answer.address);
}
