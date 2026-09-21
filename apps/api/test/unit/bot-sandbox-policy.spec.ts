import { readFileSync } from "node:fs";
import path from "node:path";
import {
  assertBotSandboxAllowed,
  assertSandboxScriptAllowed,
  BOT_SANDBOX_VARIABLE,
  botSandboxEnabled,
} from "../../src/modules/bot/sandbox-policy.ts";

/**
 * **The sandbox cannot exist in production, and this is the proof rather than the intention.**
 *
 * It issues a bot credential, prints its secret and the webhook signing secret in a terminal, and
 * points a clinic's webhook at a process whose whole job is to write deliveries out. On a laptop
 * that is the point; on a server holding a real clinic's data every one of those is a leak.
 *
 * Same shape as `totp-policy.spec.ts`: it throws when it should, and does *not* throw in every
 * neighbouring case — a check that refused everything would also pass the first assertion.
 */
const API_ROOT = path.resolve(__dirname, "..", "..");
const production = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "production", ...extra });

describe("the sandbox is off unless explicitly turned on", () => {
  test("only the exact word turns it on", () => {
    for (const value of [undefined, "", "off", "true", "1", "yes", "ON!", "onn"]) {
      expect(botSandboxEnabled(value === undefined ? {} : { [BOT_SANDBOX_VARIABLE]: value })).toBe(false);
    }
    // Case and surrounding space are forgiven; nothing else is.
    for (const value of ["on", "ON", " on "]) {
      expect(botSandboxEnabled({ [BOT_SANDBOX_VARIABLE]: value })).toBe(true);
    }
  });
});

describe("the API refuses to boot with a sandbox in production", () => {
  test("it throws, and the message says which variable and why", () => {
    expect(() => assertBotSandboxAllowed(production({ [BOT_SANDBOX_VARIABLE]: "on" }))).toThrow(
      /BOT_SANDBOX=on is refused when NODE_ENV=production/,
    );
  });

  test("and does not throw in any neighbouring case", () => {
    expect(() => assertBotSandboxAllowed(production())).not.toThrow();
    expect(() => assertBotSandboxAllowed(production({ [BOT_SANDBOX_VARIABLE]: "off" }))).not.toThrow();
    expect(() => assertBotSandboxAllowed({ [BOT_SANDBOX_VARIABLE]: "on" })).not.toThrow();
    expect(() => assertBotSandboxAllowed({ NODE_ENV: "development", [BOT_SANDBOX_VARIABLE]: "on" })).not.toThrow();
  });

  test("main.ts calls it, before a port is bound", () => {
    // The check is worth nothing unbound: this is the assertion that it is actually wired, and that
    // it runs before `NestFactory.create`, which is where the port and the database come up.
    const main = readFileSync(path.join(API_ROOT, "src", "main.ts"), "utf8");
    const called = main.indexOf("assertBotSandboxAllowed()");
    const created = main.indexOf("NestFactory.create");
    expect(called).toBeGreaterThan(-1);
    expect(called).toBeLessThan(created);
  });
});

describe("the sandbox scripts refuse the same way, because they run outside the API", () => {
  test("a production environment is refused whether or not the flag is set", () => {
    expect(() => assertSandboxScriptAllowed("sandbox-bot", production({ [BOT_SANDBOX_VARIABLE]: "on" }))).toThrow(
      /refuses to run with NODE_ENV=production/,
    );
    expect(() => assertSandboxScriptAllowed("sandbox-bot", production())).toThrow(/NODE_ENV=production/);
  });

  test("and so is a development environment that never asked for a sandbox", () => {
    expect(() => assertSandboxScriptAllowed("webhook-echo", {})).toThrow(/needs BOT_SANDBOX=on/);
    expect(() => assertSandboxScriptAllowed("webhook-echo", { [BOT_SANDBOX_VARIABLE]: "on" })).not.toThrow();
  });

  test("both sandbox scripts call it before they do anything", () => {
    for (const script of ["sandbox-bot.ts", "webhook-echo.ts"]) {
      const source = readFileSync(path.join(API_ROOT, "scripts", script), "utf8");
      expect(source).toContain("assertSandboxScriptAllowed(");
    }
  });
});
