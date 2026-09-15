import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../../scripts/route-capabilities.ts";

/**
 * The two things about the password toggle that a component test structurally cannot see.
 *
 * ## What moved, and what is left here
 *
 * The behaviour of the control — click it, the input type flips, the label flips, a half-typed
 * value survives, the form does not submit — is now proven in
 * `apps/web/src/design-system/PasswordField.spec.tsx`, which renders the component in jsdom and
 * drives it. That test is strictly better than the source checks it replaced, and those are gone.
 *
 * **This file was kept rather than deleted because two assertions survive that move**, and both are
 * about things outside the component:
 *
 * 1. **That `LoginPage` actually uses it.** A component test proves the control works; it cannot
 *    prove the login screen renders it. Swapping `PasswordField` back for a plain
 *    `<TextInput type="password">` would leave every one of those seven tests green while the
 *    feature disappeared from the only screen that has it.
 * 2. **That the Arabic strings exist.** `PasswordField` takes `toggleLabel` as a prop, so it renders
 *    whatever it is handed — the component test passes its own fixtures. Whether
 *    `login.password.show` and `login.password.hide` exist in the catalogue, and say what they
 *    should, is a fact about `strings.ts`.
 *
 * Both are the seam between a working part and a shipped feature, and the seam is where this
 * project keeps finding things: a permission gate that was right in the matrix and wrong in the nav
 * item, a capability the API enforced and no screen asked about.
 *
 * The other `web-*.spec.ts` files in this directory remain source checks. Migrating them to the new
 * runner is a later batch, by ruling.
 */

const WEB = path.resolve(__dirname, "..", "..", "..", "web", "src");
const LOGIN = stripComments(readFileSync(path.join(WEB, "features", "auth", "LoginPage.tsx"), "utf8"));
const STRINGS = readFileSync(path.join(WEB, "i18n", "strings.ts"), "utf8");

describe("the toggle reaches the login screen", () => {
  test("LoginPage renders PasswordField, not a bare type=password input", () => {
    expect(LOGIN).toContain("<PasswordField");
    expect(LOGIN).not.toMatch(/<TextInput[^>]*type="password"/s);
  });

  test("it passes the label from passwordVisibility rather than a literal", () => {
    // The component renders whatever `toggleLabel` it is handed. Handing it a hardcoded string
    // would render one label in both states -- a toggle that never says what clicking will do --
    // and the component test could not tell, because it supplies its own labels.
    expect(LOGIN).toContain("passwordVisibility(passwordVisible).labelKey");
  });

  test("visibility resets on a successful sign-in, not only the value", () => {
    // Reception shares a machine. Clearing the password while leaving the field revealed would
    // leave the next person looking at an empty box in plain-text mode, and the one after that
    // typing into it.
    expect(LOGIN).toMatch(/setPassword\(""\);\s*setPasswordVisible\(false\);/);
  });
});

describe("the Arabic the toggle needs exists", () => {
  test("both labels are in the catalogue, and say what clicking will do", () => {
    expect(STRINGS).toContain('"login.password.show": "إظهار كلمة السر"');
    expect(STRINGS).toContain('"login.password.hide": "إخفاء كلمة السر"');
  });

  test("and their English counterparts, because the toggle is on the login screen", () => {
    // `web-locale.spec.ts` enforces a complete English catalogue globally; asserted here too
    // because these two keys are the ones this feature added, and the login screen is where the
    // language toggle lives.
    expect(STRINGS).toContain('"login.password.show": "Show password"');
    expect(STRINGS).toContain('"login.password.hide": "Hide password"');
  });
});
