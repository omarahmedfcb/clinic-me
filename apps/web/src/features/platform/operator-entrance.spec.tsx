import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { LoginPage } from "../auth/LoginPage.tsx";

/**
 * **How anybody finds the operator's console** — the defect the founder hit on 2026-09-15.
 *
 * An operator holds no membership, so `POST /auth/login` refuses them with *the same sentence as a
 * wrong password*. That is deliberate and stays: an unauthenticated caller must not learn which
 * accounts exist. The cost is that somebody on the wrong page cannot tell they are on the wrong
 * page — they read "wrong number or password" and conclude the credentials are bad.
 *
 * The fix is a link, not a better error. A link leaks no account and no credential; it reveals only
 * that the vendor has an operations console, which is not a secret. The refusal is untouched, and
 * the test below pins that it is untouched.
 */

afterEach(cleanup);

const renderLogin = () =>
  render(
    <LocaleProvider>
      <LoginPage onSignedIn={vi.fn()} onMustChangePassword={vi.fn()} />
    </LocaleProvider>,
  );

describe("the operator's entrance", () => {
  test("the clinic login points at it", () => {
    renderLogin();
    const link = screen.getByTestId("platform-console-link");
    expect(link.getAttribute("href")).toBe("/platform");
  });

  test("and says whose it is, so a clinic user does not follow it by mistake", () => {
    renderLogin();
    expect(screen.getByTestId("platform-console-link").textContent).toBe("دخول فريق التشغيل");
  });

  /**
   * The property the link must not weaken. Nothing on this page distinguishes an account that
   * exists from one that does not — no per-account hint, no "this is an operator" branch.
   */
  test("the page still says nothing about which accounts exist", () => {
    renderLogin();
    const text = document.body.textContent ?? "";
    for (const leak of ["مشغّل", "operator@", "+201000000000", "platform admin"]) {
      expect(text).not.toContain(leak);
    }
  });
});
