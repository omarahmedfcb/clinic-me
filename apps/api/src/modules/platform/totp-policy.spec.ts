import { readFileSync } from "node:fs";
import path from "node:path";
import { assertOperatorTotpAllowed, operatorTotpRequired, OPERATOR_TOTP_VARIABLE } from "./totp-policy.ts";

/**
 * **The guard the founder asked to see proven: the API refuses to boot with the second factor off
 * in production.**
 *
 * A flag that disables a security control is a liability the moment it can reach a server by
 * accident — a copied `.env`, a stale deployment variable, an image built from a dev shell. The
 * check is worth as much as the proof that it fires, so both halves are here: it throws when it
 * should, and it does *not* throw in every neighbouring case, because a check that refused
 * everything would also pass the first assertion.
 *
 * `env` is passed in rather than mutated globally, which is why this is a unit spec and needs no
 * environment of its own.
 */

const production = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "production", ...extra });

describe("the operator's second factor is on unless explicitly turned off", () => {
  test("it is required when the variable is absent, empty, or anything but `off`", () => {
    const answers = [undefined, "", "on", "true", "1", "false", "no", "0", "OFFF", "of"].map((value) => ({
      value,
      required: operatorTotpRequired(value === undefined ? {} : { [OPERATOR_TOTP_VARIABLE]: value }),
    }));
    // `false`, `no` and `0` are in that list deliberately: a typo must leave the second factor ON,
    // which is the safe direction for a misconfiguration to fail in.
    expect(answers.every((answer) => answer.required)).toBe(true);
  });

  test("and only the exact word turns it off, case and spacing aside", () => {
    for (const value of ["off", "OFF", " off ", "Off"]) {
      expect({ value, required: operatorTotpRequired({ [OPERATOR_TOTP_VARIABLE]: value }) }).toEqual({
        value,
        required: false,
      });
    }
  });
});

describe("the boot check", () => {
  test("refuses production with the second factor off", () => {
    expect(() => assertOperatorTotpAllowed(production({ [OPERATOR_TOTP_VARIABLE]: "off" }))).toThrow(
      /refused when NODE_ENV=production/,
    );
  });

  test("and the message says what to do, not just what is wrong", () => {
    // A boot failure a deployer cannot act on is a boot failure they work around.
    try {
      assertOperatorTotpAllowed(production({ [OPERATOR_TOTP_VARIABLE]: "off" }));
      throw new Error("expected it to throw");
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      expect(message).toContain("Unset the variable");
      expect(message).toContain("NODE_ENV");
    }
  });

  /**
   * The other side, and the reason this is four tests rather than one: a check that threw on
   * everything would satisfy the first assertion above and break every development run.
   */
  test("permits production with the second factor on", () => {
    expect(() => assertOperatorTotpAllowed(production())).not.toThrow();
    expect(() => assertOperatorTotpAllowed(production({ [OPERATOR_TOTP_VARIABLE]: "on" }))).not.toThrow();
  });

  test("permits development and test with it off, which is the whole point of the flag", () => {
    for (const nodeEnv of ["development", "test", "review", undefined]) {
      const env = { [OPERATOR_TOTP_VARIABLE]: "off", ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }) };
      expect(() => assertOperatorTotpAllowed(env)).not.toThrow();
    }
  });

  test("a NODE_ENV that merely contains 'production' is not production", () => {
    // `production-like`, `preproduction`: a substring match here would refuse to boot environments
    // that are not live, and somebody would then remove the check rather than the name.
    for (const nodeEnv of ["preproduction", "production-like", "not-production"]) {
      expect(() =>
        assertOperatorTotpAllowed({ NODE_ENV: nodeEnv, [OPERATOR_TOTP_VARIABLE]: "off" }),
      ).not.toThrow();
    }
  });
});

/**
 * **A function nobody calls refuses nothing.**
 *
 * The block above proves `assertOperatorTotpAllowed` throws when it should. It says nothing about
 * whether the process ever asks it — and a boot check that is never invoked is the exact shape of
 * thing this project keeps finding: correct, tested, and doing nothing.
 *
 * Read from `main.ts` rather than by spawning a build, which would be a minute of compile per run.
 * What it holds is the ordering that matters: the check happens **before** a port is bound, so a
 * refused configuration never serves a single request.
 */
describe("and main.ts actually asks", () => {
  const main = readFileSync(path.resolve(__dirname, "..", "..", "main.ts"), "utf8");

  test("the boot check is called", () => {
    expect(main).toContain("assertOperatorTotpAllowed()");
  });

  test("before anything listens", () => {
    const asks = main.indexOf("assertOperatorTotpAllowed()");
    const listens = main.indexOf("app.listen(");
    expect(asks).toBeGreaterThan(-1);
    expect(listens).toBeGreaterThan(-1);
    expect(asks).toBeLessThan(listens);
  });

  test("and before the application is even constructed", () => {
    // `NestFactory.create` runs module constructors and provider factories. A configuration this
    // refuses should not get that far.
    expect(main.indexOf("assertOperatorTotpAllowed()")).toBeLessThan(main.indexOf("NestFactory.create"));
  });
});
