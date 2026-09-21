import { checkWebhookAddress } from "../../src/modules/bot/webhook-address.ts";

/**
 * **A10: the one outbound request we make cannot be aimed at our own network.**
 *
 * The address is chosen by a clinic administrator, so "they are already an administrator" bounds the
 * damage without removing it: a delivery to `169.254.169.254` is a request to a cloud metadata
 * service, made by our server, with our network position.
 *
 * Two properties this file pins, and the second is the one an allowlist usually misses:
 * every resolved address is checked rather than the first, and the check runs again at send time
 * because DNS is not a promise.
 */
const publicDns = { resolve: async () => ["93.184.216.34"] };
const privateDns = { resolve: async () => ["10.0.0.5"] };
const mixedDns = { resolve: async () => ["93.184.216.34", "127.0.0.1"] };
const noAnswer = { resolve: async () => [] };

const production = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

describe("a webhook may only point outward", () => {
  test("an ordinary HTTPS host resolving publicly is allowed", async () => {
    expect(await checkWebhookAddress("https://bot.example.test/hook", { ...publicDns, env: production })).toEqual({
      ok: true,
    });
  });

  test("plain HTTP is refused, whatever it resolves to", async () => {
    expect(await checkWebhookAddress("http://bot.example.test/hook", { ...publicDns, env: production })).toEqual({
      ok: false,
      code: "NOT_HTTPS",
    });
  });

  test("a literal private address is refused without a lookup", async () => {
    for (const host of ["10.0.0.5", "127.0.0.1", "192.168.1.10", "172.16.0.9", "169.254.169.254", "[::1]"]) {
      expect(await checkWebhookAddress(`https://${host}/hook`, { ...noAnswer, env: production })).toEqual({
        ok: false,
        code: "PRIVATE_ADDRESS",
      });
    }
  });

  test("a public name that resolves privately is refused — the lookup is the point", async () => {
    expect(await checkWebhookAddress("https://inside.example.test/hook", { ...privateDns, env: production })).toEqual({
      ok: false,
      code: "PRIVATE_ADDRESS",
    });
  });

  test("every answer is checked, not the first: one private address is enough to refuse", async () => {
    // The shape a rebinding attack takes — a name answering with one public and one private address.
    expect(await checkWebhookAddress("https://both.example.test/hook", { ...mixedDns, env: production })).toEqual({
      ok: false,
      code: "PRIVATE_ADDRESS",
    });
  });

  test("a name nobody can resolve is refused rather than attempted", async () => {
    const failing = { resolve: async () => Promise.reject(new Error("ENOTFOUND")), env: production };
    expect(await checkWebhookAddress("https://nowhere.example.test/hook", failing)).toEqual({
      ok: false,
      code: "UNRESOLVABLE",
    });
    expect(await checkWebhookAddress("https://empty.example.test/hook", { ...noAnswer, env: production })).toEqual({
      ok: false,
      code: "UNRESOLVABLE",
    });
  });

  test("localhost is refused in production, by name as well as by address", async () => {
    expect(await checkWebhookAddress("https://localhost/hook", { ...noAnswer, env: production })).toEqual({
      ok: false,
      code: "PRIVATE_ADDRESS",
    });
  });

  test("something that is not a URL is refused, not thrown", async () => {
    expect(await checkWebhookAddress("not a url", { ...publicDns, env: production })).toEqual({
      ok: false,
      code: "NOT_HTTPS",
    });
  });
});

describe("the sandbox exception, and the gate on it", () => {
  const sandbox = { BOT_SANDBOX: "on" } as NodeJS.ProcessEnv;

  test("the sandbox may call a loopback receiver over plain HTTP", async () => {
    expect(await checkWebhookAddress("http://localhost:5183/webhook", { ...noAnswer, env: sandbox })).toEqual({
      ok: true,
    });
  });

  test("the same URL is refused without the flag", async () => {
    // The gate: `BOT_SANDBOX=on` is what allows it, and the API refuses to boot with that flag under
    // NODE_ENV=production — so this exception cannot exist on a server holding a clinic's data.
    expect(await checkWebhookAddress("http://localhost:5183/webhook", { ...noAnswer, env: {} })).toEqual({
      ok: false,
      code: "NOT_HTTPS",
    });
  });

  test("even with the flag, plain HTTP to somewhere else is refused", async () => {
    expect(await checkWebhookAddress("http://bot.example.test/hook", { ...publicDns, env: sandbox })).toEqual({
      ok: false,
      code: "NOT_HTTPS",
    });
  });
});
