// Whether the operator's second factor is enforced. `OPERATOR_TOTP=off` skips it, and the API
// refuses to boot with it off in production.

export const OPERATOR_TOTP_VARIABLE = "OPERATOR_TOTP";

/**
 * **Off is a development and review setting, and the boot check is what keeps it one.**
 *
 * Ruled 2026-09-15, after the second factor blocked a review: the seeded operator was created with
 * a confirmed authenticator, so the console asked for a six-digit code the reviewer had no way to
 * produce and the enrolment screen was unreachable behind it.
 *
 * A flag that turns off a security control is a liability the moment it can reach production by
 * accident — a copied `.env`, a stale deployment variable, a Docker image built from a dev shell.
 * So it is not "default on, overridable": it is on unless explicitly `off`, **and** `assertOperator
 * TotpAllowed` refuses to start the process when it is off and `NODE_ENV` is production. A server
 * that will not boot is a loud failure; an operator surface silently accepting a password alone is
 * a quiet one.
 *
 * `env` is a parameter rather than a direct read of `process.env`, so a unit spec can exercise both
 * cases without mutating global state — the same reason `storage.config.ts` takes one.
 */
export function operatorTotpRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  // Only the exact word turns it off. A typo — `OPERATOR_TOTP=false`, `0`, `no` — leaves the second
  // factor on, which is the safe direction for a misconfiguration to fail in.
  return (env[OPERATOR_TOTP_VARIABLE] ?? "").trim().toLowerCase() !== "off";
}

/** Whether this environment is a production one, by `NODE_ENV`. */
const isProduction = (env: NodeJS.ProcessEnv): boolean => (env["NODE_ENV"] ?? "").trim() === "production";

/**
 * Refuses to start when the second factor is disabled in production.
 *
 * Called from `main.ts` before anything binds a port, beside the timezone check, and for the same
 * reason that one is there: a service that cannot do its job safely should say so at startup rather
 * than at the moment somebody needs it.
 */
export function assertOperatorTotpAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (operatorTotpRequired(env) || !isProduction(env)) return;

  throw new Error(
    `${OPERATOR_TOTP_VARIABLE}=off is refused when NODE_ENV=production. The operator console can ` +
      "create clinics, suspend them and reset a clinic administrator's password, and its second " +
      "factor is not optional in a live deployment. Unset the variable, or set NODE_ENV correctly " +
      "if this is a development or review process.",
  );
}
