import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ALTER_APP_ROLE_PASSWORD,
  RESEED_INSTRUCTIONS,
} from "../../prisma/seed/reseed-instructions.ts";

/**
 * The seed's recovery message works, and stays tied to `docs/SETUP.md`.
 *
 * ## The failure this exists to catch
 *
 * On 2026-09-07 the seed printed a four-line recipe for starting over, the founder followed it
 * exactly, and it failed at the last step with `AuthenticationFailed`.
 *
 * The cause was three commands earlier. `docker compose down -v` discards the volume, and
 * `20260821194449_app_role` recreates `clinic_os_app` **with no password** — deliberately, because
 * migration files are committed and a password in one would be a secret in source control
 * (`SCHEMA-DECISIONS.md` D12/D13). Nothing in the repository sets that password for
 * `clinic_os_dev`: `test/integration/globalSetup.ts` sets it, for `clinic_os_test`.
 *
 * `docs/SETUP.md` §6 documents the missing command and calls it *"the sharpest edge in the whole
 * setup"*. The seed's own recovery message simply did not carry it — so the document was right and
 * the thing a reader actually reads, at the moment they need it, was wrong.
 *
 * ## Why this asserts identity with SETUP.md rather than merely mentioning ALTER ROLE
 *
 * A test that only checked for the substring `ALTER ROLE` would pass against a command with the
 * wrong role, the wrong database, or a missing `PGPASSWORD` — every one of which fails in exactly
 * the same confusing way as omitting the step entirely. Asserting the two are the same string makes
 * the document and the message one fact with two renderings, so editing either alone fails here.
 *
 * This is the project's standing preference applied to a console message: an invariant held up only
 * by someone remembering to update both copies is not enforced.
 */

const API_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");
const SETUP_MD = path.join(REPO_ROOT, "docs", "SETUP.md");
const SEED_INDEX = path.join(API_ROOT, "prisma", "seed", "index.ts");

describe("the seed's re-seed recipe is runnable as printed", () => {
  test("it carries the ALTER ROLE step, without which it fails at the last command", () => {
    expect(RESEED_INSTRUCTIONS).toContain("ALTER ROLE clinic_os_app WITH PASSWORD");
  });

  test("that command is character-identical to the one in docs/SETUP.md", () => {
    // Normalised for line endings only. `transfers.controller.ts` was committed CRLF while its
    // neighbours are LF, so this file does not assume either.
    const setup = readFileSync(SETUP_MD, "utf8").replace(/\r\n/g, "\n");
    expect(setup).toContain(ALTER_APP_ROLE_PASSWORD.replace(/\r\n/g, "\n"));
  });

  test("the recipe's steps are ordered so the password is set after the role exists", () => {
    // `20260821194449_app_role` is what creates the role, so ALTER ROLE before `migrate deploy`
    // would fail on a fresh volume — and would fail in a way that looks like a typo rather than an
    // ordering mistake.
    const migrate = RESEED_INSTRUCTIONS.indexOf("prisma migrate deploy");
    const alter = RESEED_INSTRUCTIONS.indexOf("ALTER ROLE");
    const seed = RESEED_INSTRUCTIONS.indexOf("npm run seed");

    expect(migrate).toBeGreaterThan(-1);
    expect(alter).toBeGreaterThan(migrate);
    expect(seed).toBeGreaterThan(alter);
  });
});

describe("there is exactly one copy of the recipe", () => {
  /**
   * The recipe lived in two places until 2026-09-07 — the module docblock of `index.ts` and the
   * string it printed — and **both copies were missing the same step**, which is what a second copy
   * reliably produces. This asserts the seed no longer spells the recipe out itself.
   *
   * `prisma migrate deploy` is the marker rather than `ALTER ROLE`: a reappearing copy would be
   * pasted from the old text, which had the migrate line and never had the alter line. Catching it
   * by the line the wrong version *does* contain is the point.
   */
  test("index.ts does not spell out a second, divergent recipe", () => {
    const source = readFileSync(SEED_INDEX, "utf8");
    expect(source).not.toContain("prisma migrate deploy");
  });
});
