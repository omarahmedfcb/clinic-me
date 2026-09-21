import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { BRAND } from "../../brand/brand.ts";
import { ClinicBadge } from "./ClinicBadge.tsx";
import { clinicInitials } from "./clinic-initials.ts";

/**
 * **The guard the founder asked for: with and without a clinic logo, the top bar shows the right
 * element — and the NOMED mark is never the fallback.**
 *
 * His ruling of 2026-09-15: *"when no logo is uploaded, the NOMED mark is NOT used there — show the
 * clinic's initials in a teal circle instead, so no clinic looks like it belongs to us. The NOMED
 * logo stays in the sidebar only."*
 *
 * Both halves are asserted, because only checking that the initials render would still pass if
 * somebody put our mark beside them.
 */

afterEach(cleanup);

const CLINIC = "عيادة النيل لطب الأسرة";

const renderBadge = (logoUrl: string | null) =>
  render(
    <LocaleProvider>
      <ClinicBadge
        clinicName={CLINIC}
        logoUrl={logoUrl}
        userName="منى سيد فهمي"
        roleText="مسؤول"
        onAccount={vi.fn()}
      />
    </LocaleProvider>,
  );

describe("the clinic's mark in the top bar", () => {
  test("with a logo, the logo is rendered and no initials are", () => {
    renderBadge("blob:fake-logo");

    const logo = screen.getByTestId("clinic-logo");
    expect(logo.getAttribute("src")).toBe("blob:fake-logo");
    expect(screen.queryByTestId("clinic-initials")).toBeNull();
  });

  test("without a logo, the clinic's own initials are rendered", () => {
    renderBadge(null);

    const initials = screen.getByTestId("clinic-initials");
    expect(initials.textContent).toBe(clinicInitials(CLINIC));
    // Not a stand-in for the logo: there is no <img> in the badge at all in this state.
    expect(screen.queryByTestId("clinic-logo")).toBeNull();
  });

  /**
   * **The half that matters.** A fallback showing our mark would satisfy "something renders" and
   * would put NOMED's identity on a clinic that has not chosen it.
   */
  test("and the fallback is never the NOMED mark, in either state", () => {
    for (const logoUrl of ["blob:fake-logo", null]) {
      cleanup();
      const { container } = renderBadge(logoUrl);
      const html = container.innerHTML;

      expect(html).not.toContain(BRAND.markSvg);
      expect(html).not.toContain(BRAND.markMonoSvg);
      expect(html).not.toContain(BRAND.lockupWebp);
      expect(html).not.toContain(BRAND.name);
    }
  });

  test("the initials sit in a filled teal disc, from the token and not a literal", () => {
    renderBadge(null);
    const classes = screen.getByTestId("clinic-initials").className;
    // `bg-primary` is the sampled brand teal; `web-colour-tokens.spec.ts` separately asserts that
    // the token exists, and `brand.spec.ts` that no component hard-codes a hex.
    expect(classes).toContain("bg-primary");
    expect(classes).toContain("rounded-full");
  });

  test("the clinic name is the heading, and the person is secondary to it", () => {
    renderBadge(null);

    // A real `h1`: it is the primary heading of every screen in the shell, not a styled paragraph.
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe(CLINIC);

    const account = screen.getByTestId("account-menu");
    expect(account.textContent).toContain("منى سيد فهمي");
    expect(account.textContent).toContain("مسؤول");
    // Secondary by size and colour, so the ordering the ruling asks for is visible and not implied.
    expect(account.className).toContain("text-xs");
    expect(account.className).toContain("text-ink-muted");
    expect(heading.className).toContain("text-xl");
  });
});

describe("a clinic's initials", () => {
  /**
   * What the rule produces, including what it gets wrong — the standing requirement that a matching
   * rule is presented with its false positives rather than only its intended cases.
   */
  test("takes the first two words, dropping the article", () => {
    const cases: [string, string][] = [
      ["عيادة النيل لطب الأسرة", "عن"],
      ["مركز الشفاء للجلدية والتجميل", "مش"],
      ["Nile Family Clinic", "NF"],
    ];
    expect(cases.map(([name]) => [name, clinicInitials(name)])).toEqual(cases);
  });

  test("two clinics whose names begin the same way differ only in the second letter", () => {
    // Stated as a test rather than only in a comment: it is the known cost of not keeping a list of
    // generic leading words, and it is acceptable for a mark that sits beside the name it shortens.
    expect(clinicInitials("عيادة النيل")).toBe("عن");
    expect(clinicInitials("عيادة الشفاء")).toBe("عش");
    expect(clinicInitials("عيادة النور")).toBe("عن");
  });

  test("a one-word name gives one letter rather than throwing", () => {
    expect(clinicInitials("النيل")).toBe("ن");
    expect(clinicInitials("")).toBe("");
  });
});
