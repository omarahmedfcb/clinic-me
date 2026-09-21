// Whether this process may hold a sandbox bot. `BOT_SANDBOX=on` turns it on, and the API refuses to
// boot with it on in production.

export const BOT_SANDBOX_VARIABLE = "BOT_SANDBOX";

/**
 * **On is a review setting, and the boot check is what keeps it one.**
 *
 * The sandbox issues a bot credential and a webhook secret and prints both in plain text, and points
 * the clinic's webhook at a local receiver that logs every delivery. All three are exactly what must
 * never exist on a server holding a real clinic's data — printed credentials in a terminal log, and
 * patients' first names and appointment times flowing to a process whose whole job is to write them
 * out.
 *
 * Same shape as `OPERATOR_TOTP` (modules/platform/totp-policy.ts) and for the same reason: a flag
 * that weakens a boundary is a liability the moment it can reach production by accident — a copied
 * `.env`, a stale deployment variable, an image built from a dev shell. So the default is off, only
 * the exact word turns it on, and a production process carrying it refuses to start. A server that
 * will not boot is a loud failure; one quietly running a sandbox is not.
 */
export function botSandboxEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  // Only the exact word. A typo — `BOT_SANDBOX=true`, `1`, `yes` — leaves it off, which is the safe
  // direction for a misconfiguration to fail in.
  return (env[BOT_SANDBOX_VARIABLE] ?? "").trim().toLowerCase() === "on";
}

const isProduction = (env: NodeJS.ProcessEnv): boolean => (env["NODE_ENV"] ?? "").trim() === "production";

/**
 * Refuses to start when the sandbox is on in production. Called from `main.ts` before any port is
 * bound, beside the timezone and operator-TOTP checks.
 */
export function assertBotSandboxAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (!botSandboxEnabled(env) || !isProduction(env)) return;

  throw new Error(
    `${BOT_SANDBOX_VARIABLE}=on is refused when NODE_ENV=production. The sandbox prints a bot ` +
      "credential and a webhook signing secret in plain text and points the clinic's webhook at a " +
      "local receiver that logs every delivery. Unset the variable, or set NODE_ENV correctly if " +
      "this is a development or review process.",
  );
}

/**
 * The same refusal, for the scripts that provision a sandbox rather than for the API.
 *
 * They run outside the server process, so `assertBotSandboxAllowed` would never see them: a script
 * pointed at a production database by a stale `.env` is precisely the accident this is about.
 */
export function assertSandboxScriptAllowed(script: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isProduction(env)) {
    throw new Error(`${script} refuses to run with NODE_ENV=production. It provisions a sandbox bot.`);
  }
  if (!botSandboxEnabled(env)) {
    throw new Error(
      `${script} needs ${BOT_SANDBOX_VARIABLE}=on. It issues a credential and prints its secret, ` +
        "so it does not run unless somebody has asked for a sandbox by name.",
    );
  }
}
