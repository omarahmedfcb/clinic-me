import { expect, test, type Page, type Route } from "@playwright/test";

/**
 * **The two things jsdom cannot answer.**
 *
 * `playwright.config.ts` records a condition the founder set on `smoke.spec.ts`: no content
 * assertions, because a second suite that checks what a screen says drifts from the first and rots.
 * That condition stands, and this file is deliberately not that. These two tests assert properties
 * the unit suites are structurally incapable of reaching:
 *
 *   1. **`@media print`.** jsdom parses the print stylesheet and never evaluates the query, so the
 *      one assertion that would have caught the blank-printing bug of 2026-09-09 — *what is
 *      actually visible on paper* — could not be written. `PrintDocuments.spec.tsx` asserts the
 *      structure the fix depends on (the print root is a child of `body`); this asserts the result.
 *   2. **Layout geometry.** "The first field's box is on the right" is a computed position. A
 *      renderer that ignored `dir` entirely would satisfy every `dir="rtl"` attribute assertion in
 *      the project, and this is an Arabic-first product.
 *
 * Approved by the founder on 2026-09-09. No database: every API call is fulfilled here, so the run
 * is deterministic and needs nothing but the built bundle.
 */

const APPOINTMENT = "11111111-1111-4111-8111-111111111111";
const DOCTOR = "44444444-4444-4444-8444-444444444444";

const ME = {
  user: { id: "u1", fullName: "هشام محمود الديب", phoneE164: "+201005551004", email: null, locale: "ar" },
  membershipId: "m1",
  tenantId: "t1",
  currency: "EGP",
  role: "DOCTOR",
  memberships: [{ membershipId: "m1", tenantId: "t1", tenantName: "عيادة النيل", tenantSlug: "nile", role: "DOCTOR" }],
  permissions: { "visits.write": "full", "visits.readContent": "full", "appointments.read": "full" },
};

const HEADER = {
  patientId: "p1",
  fullNameAr: "مريم حسن عبد الله",
  fullNameEn: null,
  dateOfBirth: "1990-04-02",
  gender: "FEMALE",
  phoneE164: "+201000000000",
  allergies: [],
  allergiesReviewedAt: null,
  coverage: { standing: "NONE" },
  visitCount: 2,
  lastVisitAt: null,
};

const DRAFT = {
  id: "v1",
  appointmentId: APPOINTMENT,
  doctorId: DOCTOR,
  revision: 0,
  complaint: null,
  medicalHistory: null,
  examination: null,
  diagnosis: "التهاب الجيوب الأنفية",
  treatmentPlan: null,
  doctorNotes: null,
  updatedAt: "2026-09-09T08:00:00.000Z",
  resumed: false,
};

/** The clinic's letterhead. `CLINIC_NAME` is what the print test looks for on the paper. */
const CLINIC_NAME = "عيادة النيل لطب الأسرة";

/**
 * Answers every `/api` call the visit screen makes.
 *
 * Matched by substring and ending in a permissive default, deliberately: an unmatched route would
 * otherwise hang until the test timed out, and the failure would name the timeout rather than the
 * request. Order matters — the most specific patterns come first.
 */
async function mockApi(page: Page): Promise<void> {
  await page.route("**/api/**", async (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (url.includes("/auth/refresh")) return json({ accessToken: "test-token" });
    if (url.includes("/auth/me")) return json(ME);
    if (url.includes("/visit/draft")) return json(DRAFT, 201);
    if (url.includes("/clinical-summary")) return json(HEADER);
    if (url.includes("/clinical-profile")) {
      return json({ patientId: "p1", entries: [], lastUpdatedAt: null, lastUpdatedBy: null, heightCm: null, firstVisit: false });
    }
    if (url.includes("/prescription")) return json({ prescriptionId: null, notes: null, items: [], printedCount: 0 });
    if (url.includes("/investigations")) return json({ freeText: null, items: [] });
    if (url.includes("/clinic-identity/doctors/")) {
      return json({ doctorId: DOCTOR, printedName: "د. هشام محمود الديب", title: "استشاري", syndicateNumber: "12345", hasSignature: false, hasStamp: false });
    }
    if (url.includes("/clinic-identity")) {
      return json({ name: CLINIC_NAME, address: "١٢ شارع النصر، المعادي", phones: ["+20223456789"], hasLogo: false, taxRegistrationNumber: null, commercialRegisterNumber: null, email: null, whatsappNumber: null, workingHours: null, tagline: null });
    }
    if (url.includes("/notifications/count")) return json({ count: 0 });
    // Lists — services, medications, procedures, open visits, notifications.
    return json([]);
  });
}

test.describe("what only a real browser can check", () => {
  test("the print sheet is what prints, and the application is not", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/visits/${APPOINTMENT}`, { waitUntil: "domcontentloaded" });

    const printRoot = page.locator("#print-root");
    await expect(printRoot).toBeAttached({ timeout: 15_000 });

    // Screen media first, so the assertions below are a contrast and not a coincidence.
    //
    // The sheet is **off-screen, not hidden** — `print-styles.ts` parks it at
    // `inset-inline-start: -10000px` on purpose, because a `display: none` subtree is never laid
    // out and the first print of a session would come out unstyled. So the screen-side assertion is
    // that its box does not intersect the viewport, which is what "the doctor cannot see it" means
    // here. `toBeHidden()` is the wrong question and passing it would have meant a real regression.
    await page.emulateMedia({ media: "screen" });
    const parked = await printRoot.boundingBox();
    const screenViewport = page.viewportSize();
    expect(parked).not.toBeNull();
    const offScreen =
      (parked as { x: number; width: number }).x + (parked as { width: number }).width < 0 ||
      (parked as { x: number }).x > (screenViewport as { width: number }).width;
    expect({ offScreenOnDisplay: offScreen }).toEqual({ offScreenOnDisplay: true });
    await expect(page.locator("#root")).toBeVisible();

    await page.emulateMedia({ media: "print" });

    // The bug of 2026-09-09, asserted from the outside: under print media the sheet is what is
    // visible. `#print-root` sat inside `#root`, so `body > *:not(#print-root)` hid its ancestor
    // and took the sheet with it — every structural test passed and the paper came out blank.
    await expect(printRoot).toBeVisible();
    await expect(page.locator("#root")).toBeHidden();

    // And the paper carries the letterhead, not merely a non-empty box.
    await expect(printRoot).toContainText(CLINIC_NAME);
    await expect(printRoot).toContainText("مريم حسن عبد الله");
  });

  test("the visit screen lays out right-to-left, measured rather than declared", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/visits/${APPOINTMENT}`, { waitUntil: "domcontentloaded" });

    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    const field = page.locator("textarea, input[type='text']").first();
    await expect(field).toBeVisible({ timeout: 15_000 });

    /**
     * **The mirroring, measured — and not against the viewport.**
     *
     * "The first field's box is on the right" is the natural way to say this and the wrong thing to
     * measure: in RTL the sidebar takes the right edge, so the main column and every field in it
     * are correctly nearer the *left*. Asserting otherwise would demand a broken layout.
     *
     * What genuinely distinguishes a mirrored layout from an engine that parsed `dir="rtl"` and
     * ignored it is where the chrome sits — so the sidebar must be to the right of the content, and
     * the field must be inside that content. Both are positions, not attributes.
     */
    const sidebar = page.locator("aside").first();
    const sidebarBox = await sidebar.boundingBox();
    const fieldBox = await field.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(fieldBox).not.toBeNull();

    const side = sidebarBox as { x: number; width: number };
    const box = fieldBox as { x: number; width: number };
    expect({
      sidebarOnTheRight: side.x > box.x,
      fieldStartsBeforeTheSidebar: box.x + box.width <= side.x + 1,
    }).toEqual({ sidebarOnTheRight: true, fieldStartsBeforeTheSidebar: true });

    // The field's own inline direction, which is what makes Arabic text land against its right
    // edge. Cheap, and it fails if a wrapper resets `direction` while the shell stays mirrored.
    const direction = await field.evaluate((element) => getComputedStyle(element).direction);
    expect(direction).toBe("rtl");
  });
});
