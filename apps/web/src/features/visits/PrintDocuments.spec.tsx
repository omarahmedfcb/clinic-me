import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { PrintDocuments, type PrintableVisit } from "./PrintDocuments.tsx";
import { PRINT_MARKERS, PRINT_STYLESHEET } from "./print-styles.ts";

/**
 * The printed sheet, asserted as rendered output rather than eyeballed — `PHASE-4-PLAN.md` PR 8.
 *
 * The screen still needs the founder's eyes. **A layout regression does not**, and that is what this
 * file is for: a CSS change that stops hiding the application, or an element the stylesheet targets
 * that the markup no longer emits, fails here instead of on paper handed across a counter.
 *
 * The pairing is the point. Asserting the DOM alone would pass while the stylesheet named selectors
 * nothing emits; asserting the stylesheet alone would pass while the markup dropped them.
 */

const VISIT: PrintableVisit = {
  patient: {
    patientId: "patient-1",
    fileNumber: 42,
    fullNameAr: "مريم حسن",
    fullNameEn: null,
    nameSearchLatin: "maryam hassan",
    dateOfBirth: "1990-04-02",
    gender: "FEMALE",
    phoneE164: "+201000000000",
    missingIntakeFields: [],
    allergies: [],
    allergiesReviewedAt: null,
    coverage: { standing: "NONE" },
    visitCount: 3,
    lastVisitAt: null,
  },
  doctorId: "doctor-1",
  visitDate: "2026-09-09T09:00:00.000Z",
  complaint: "صداع منذ أسبوع",
  diagnosis: "التهاب الجيوب الأنفية",
  treatmentPlan: "راحة ومضاد حيوي",
  prescription: {
    notes: null,
    items: [
      {
        medicationName: "Amoxicillin",
        strength: "500 mg",
        form: "F.C. tablet",
        quantity: "21",
        dose: "1 tab",
        frequency: "3x",
        duration: "7 days",
        instructions: "بعد الأكل",
      },
    ],
  },
  investigations: { freeText: "صائم من 12 ساعة", items: [{ name: "صورة دم كاملة", notes: null }] },
  followUpDate: "2026-09-23",
  sickLeave: { days: null, from: null, note: null },
};

const IDENTITY = {
  name: "عيادة النيل",
  address: "١٢ شارع الجمهورية، القاهرة",
  phone: "+201001234567",
  secondaryPhone: "+20227351234",
  hasLogo: false,
};

const DOCTOR = {
  doctorId: "doctor-1",
  printedName: "د. سارة منصور",
  title: "استشاري",
  syndicateNumber: "12345",
  licenseNumber: "LIC-1",
  hasSignature: false,
  hasStamp: false,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function renderSheets() {
  const authFetch = vi.fn(async (path: string) => {
    if (path.includes("/clinic-identity/doctors/")) return jsonResponse(DOCTOR);
    if (path.includes("/clinic-identity")) return jsonResponse(IDENTITY);
    return jsonResponse({});
  });
  render(
    <LocaleProvider>
      <PrintDocuments authFetch={authFetch} visit={VISIT} />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(cleanup);

describe("the printed sheets", () => {
  test("three documents print, and each carries the letterhead and a signature block (Q29)", async () => {
    renderSheets();
    await screen.findAllByText("عيادة النيل");

    const sheets = document.querySelectorAll(".print-sheet");
    // Prescription, medical report, investigations request. Q29 names three, so three print.
    expect(sheets).toHaveLength(3);
    for (const sheet of sheets) {
      expect(sheet.querySelector(".print-letterhead")).not.toBeNull();
      expect(sheet.querySelector(".print-signature")).not.toBeNull();
    }
  });

  test("a prescription row carries every column Q45 names", async () => {
    renderSheets();
    const line = await screen.findByText("Amoxicillin");
    const row = line.closest(".print-line");
    expect(row).not.toBeNull();
    // A dose that reached the paper without its frequency is a dispensing error, not a layout nit,
    // and strength and quantity are what the pharmacist reads to dispense the right box.
    for (const cell of ["500 mg", "F.C. tablet", "1 tab", "3x", "7 days", "21", "بعد الأكل"]) {
      expect({ cell, present: row?.textContent?.includes(cell) }).toEqual({ cell, present: true });
    }
  });

  test("the patient, the clinic and the doctor are named on the sheet", async () => {
    renderSheets();
    await screen.findAllByText("عيادة النيل");
    const root = screen.getByTestId("print-root");
    // Q45: the patient has no English name, so the sheet prints the transliteration search already
    // maintains -- upper-cased, because it is a search key rather than a display name.
    expect(root.textContent).toContain("MARYAM HASSAN");
    expect(root.textContent).toContain("+201000000000");
    expect(root.textContent).toContain("د. سارة منصور");
    expect(root.textContent).toContain("12345");
    // Both clinic numbers, because a letterhead with one of them is missing the other.
    expect(root.textContent).toContain("+201001234567");
    expect(root.textContent).toContain("+20227351234");
  });

  test("every element the stylesheet targets is actually emitted, and the reverse", async () => {
    renderSheets();
    await screen.findAllByText("عيادة النيل");

    // The pairing: a selector the markup stopped emitting, or markup the stylesheet stopped naming,
    // is the silent half of a print regression. Neither assertion catches it alone.
    for (const marker of PRINT_MARKERS) {
      expect(PRINT_STYLESHEET).toContain(marker);
      expect(document.querySelector(`#${marker}, .${marker}`)).not.toBeNull();
    }
  });

  /**
   * **The blank-print bug, as a structural assertion.**
   *
   * The stylesheet hides everything that is not a direct child of `body`. The sheet used to render
   * inside `#root`, where React mounts, so the rule hid `#root` and the sheet inside it — and no
   * `!important` on a descendant can survive a `display: none` ancestor. Every element the guard
   * checked was present in the DOM, and the paper came out blank.
   *
   * So this asserts the two halves **agree**: the selector says "direct child of body", and the
   * markup is one. Either half changing alone fails here rather than at a printer.
   */
  test("the print root is a direct child of body, which is what the stylesheet requires", async () => {
    renderSheets();
    await screen.findAllByText("عيادة النيل");

    const root = document.getElementById("print-root");
    expect(root).not.toBeNull();
    // The selector's own shape, read out of the stylesheet rather than restated here.
    expect(PRINT_STYLESHEET).toContain("body > *:not(#print-root)");
    expect(root?.parentElement).toBe(document.body);
    // And nothing between it and body that a `display: none` could hide it behind.
    expect(root?.closest("#root")).toBeNull();
  });

  test("exactly one print root exists, so nothing prints twice", async () => {
    // Two hosts would both satisfy the allow-list and print every sheet twice. The host is created
    // in an effect and removed on unmount for this reason.
    renderSheets();
    await screen.findAllByText("عيادة النيل");
    expect(document.querySelectorAll("#print-root")).toHaveLength(1);
    cleanup();
    expect(document.querySelectorAll("#print-root")).toHaveLength(0);
    expect(document.querySelectorAll("[data-testid=print-root]")).toHaveLength(0);
  });

  test("the stylesheet hides the application by allow-list, not by naming panels", async () => {
    renderSheets();
    // A deny-list of panels to hide has to be updated whenever a panel is added, and what escapes
    // when somebody forgets is a diagnosis on a sheet handed across a counter.
    expect(PRINT_STYLESHEET).toContain("body > *:not(#print-root)");
    expect(PRINT_STYLESHEET).toContain("display: none !important");
    // One document per sheet, and rows that do not split across a page break.
    expect(PRINT_STYLESHEET).toContain("page-break-after: always");
    expect(PRINT_STYLESHEET).toContain("page-break-inside: avoid");
  });

  test("an uploaded logo and signature reach the sheet as images (Q36)", async () => {
    // The point of PR 7h: before its screens existed the fields were reachable only with curl, so
    // every sheet printed bare. Asserted as rendered output — `<img>` elements on the sheet — rather
    // than by checking that a fetch happened.
    const created: string[] = [];
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation(() => {
        const url = `blob:stub-${created.length}`;
        created.push(url);
        return url;
      });
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);

    const authFetch = vi.fn(async (path: string) => {
      if (path.endsWith("/logo") || path.endsWith("/signature") || path.endsWith("/stamp")) {
        return new Response(new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), { status: 200 });
      }
      if (path.includes("/clinic-identity/doctors/")) {
        return jsonResponse({ ...DOCTOR, hasSignature: true, hasStamp: true });
      }
      if (path.includes("/clinic-identity")) return jsonResponse({ ...IDENTITY, hasLogo: true });
      return jsonResponse({});
    });

    render(
      <LocaleProvider>
        <PrintDocuments authFetch={authFetch} visit={VISIT} />
      </LocaleProvider>,
    );
    await screen.findAllByText("عيادة النيل");

    await waitFor(() => {
      // One logo per sheet's letterhead, and a signature and a stamp in each signature block.
      const letterheads = document.querySelectorAll(".print-letterhead img");
      const signatures = document.querySelectorAll(".print-signature img");
      expect(letterheads.length).toBe(3);
      expect(signatures.length).toBe(6);
      for (const image of [...letterheads, ...signatures]) {
        expect(image.getAttribute("src")).toMatch(/^blob:/);
      }
    });

    createObjectURL.mockRestore();
    revokeObjectURL.mockRestore();
  });

  test("a visit with nothing prescribed still prints a prescription sheet that says so", async () => {
    const authFetch = vi.fn(async (path: string) => {
      if (path.includes("/clinic-identity/doctors/")) return jsonResponse(DOCTOR);
      if (path.includes("/clinic-identity")) return jsonResponse(IDENTITY);
      return jsonResponse({});
    });
    render(
      <LocaleProvider>
        <PrintDocuments
          authFetch={authFetch}
          visit={{
            ...VISIT,
            prescription: { notes: null, items: [] },
            investigations: { freeText: null, items: [] },
          }}
        />
      </LocaleProvider>,
    );
    await screen.findAllByText("عيادة النيل");

    // Dropped sheets are discovered missing at the counter. An empty one says what happened.
    expect(document.querySelectorAll(".print-sheet")).toHaveLength(3);
    expect(screen.getByText("No medication prescribed.")).toBeTruthy();
    expect(screen.getByText("No investigations requested.")).toBeTruthy();
  });
});
