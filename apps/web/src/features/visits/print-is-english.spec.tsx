import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { PrintDocuments, type PrintableVisit } from "./PrintDocuments.tsx";
import { translatorFor } from "../../i18n/strings.ts";

/**
 * **Printed documents are English whatever the interface language is** — Q45, and the sick-leave
 * certificate that rides in the same job — Q46.
 *
 * This is the guard the ruling actually needs. Every other print test renders the sheets and reads
 * them; none of them would notice the sheets quietly following the reader's locale, because the
 * suite's default locale is Arabic and an Arabic sheet looks correct in an Arabic project.
 *
 * So the assertions are the *contrast*: the interface catalogue is Arabic, the same words are on
 * the sheet in English, and the Arabic ones are absent from it. Routing a single label back through
 * `t()` fails this and nothing else.
 */

const VISIT: PrintableVisit = {
  patient: {
    patientId: "0192f2c3-4a5b-7c8d-9e0f-112233445566",
    fileNumber: 42,
    fullNameAr: "مريم حسن",
    fullNameEn: "Maryam Hassan",
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
  complaint: "صداع",
  diagnosis: "التهاب الجيوب",
  treatmentPlan: "راحة",
  prescription: {
    notes: null,
    items: [
      {
        medicationName: "Amoxicillin",
        strength: "500 mg",
        form: "Capsule",
        quantity: "21",
        dose: "1 cap",
        frequency: "3x",
        duration: "7 days",
        instructions: null,
      },
    ],
  },
  investigations: { freeText: null, items: [] },
  followUpDate: "2026-09-23",
  sickLeave: { days: null, from: null, note: null },
};

const IDENTITY = {
  name: "عيادة النيل",
  nameEn: "Nile Family Clinic",
  address: "١٢ شارع الجمهورية",
  addressEn: "12 Gomhoreya St, Cairo",
  phone: "+201001234567",
  secondaryPhone: null,
  hasLogo: false,
};

const DOCTOR = {
  doctorId: "doctor-1",
  printedName: "د. سارة منصور",
  printedNameEn: "Dr Sara Mansour",
  title: "استشاري",
  syndicateNumber: "12345",
  licenseNumber: "LIC-1",
  hasSignature: false,
  hasStamp: false,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function renderSheets(visit: PrintableVisit = VISIT) {
  const authFetch = vi.fn(async (path: string) => {
    if (path.includes("/clinic-identity/doctors/")) return json(DOCTOR);
    if (path.includes("/clinic-identity")) return json(IDENTITY);
    return json({});
  });
  render(
    <LocaleProvider>
      <PrintDocuments authFetch={authFetch} visit={visit} />
    </LocaleProvider>,
  );
}

const root = () => screen.getByTestId("print-root");

/** The interface catalogue, asked directly, so the contrast below is against the real thing. */
const ar = translatorFor("ar");

afterEach(cleanup);

describe("the sheets are English while the interface is Arabic", () => {
  test("the interface catalogue really is Arabic, or the contrast below proves nothing", () => {
    // Pinned first: if the default locale ever became English these tests would pass vacuously,
    // asserting that an English application prints in English.
    expect(ar("print.prescription")).toBe("روشتة");
  });

  test("the sheet uses the English word and not the Arabic one", async () => {
    renderSheets();
    await screen.findAllByText("Nile Family Clinic");

    const text = root().textContent ?? "";
    for (const english of ["PRESCRIPTION", "MEDICAL REPORT", "Medication", "Strength", "Qty"]) {
      expect({ english, present: text.includes(english) }).toEqual({ english, present: true });
    }
    // The same words from the interface catalogue must not be there.
    for (const arabic of [ar("print.prescription"), ar("print.report"), ar("prescription.strength")]) {
      expect({ arabic, present: text.includes(arabic) }).toEqual({ arabic, present: false });
    }
  });

  test("the letterhead prefers the English clinic name and address", async () => {
    renderSheets();
    await screen.findAllByText("Nile Family Clinic");
    const text = root().textContent ?? "";
    expect(text).toContain("12 Gomhoreya St, Cairo");
    expect(text).not.toContain("عيادة النيل");
  });

  test("each sheet declares itself English and left-to-right", async () => {
    renderSheets();
    await screen.findAllByText("Nile Family Clinic");
    for (const sheet of document.querySelectorAll(".print-sheet")) {
      // Without this a mirrored table prints with its columns reversed on an English form.
      expect({ dir: sheet.getAttribute("dir"), lang: sheet.getAttribute("lang") }).toEqual({
        dir: "ltr",
        lang: "en",
      });
    }
  });
});

describe("the sick-leave certificate", () => {
  test("is not printed when none was issued", async () => {
    renderSheets();
    await screen.findAllByText("Nile Family Clinic");
    // An unissued certificate is not an empty document — it is not a document. The other three
    // sheets print empty on purpose; this one must not print at all.
    expect(document.querySelectorAll(".print-sheet")).toHaveLength(3);
    expect(root().textContent).not.toContain("SICK LEAVE");
  });

  test("prints as its own page, with an inclusive end date", async () => {
    renderSheets({ ...VISIT, sickLeave: { days: 3, from: "2026-09-09", note: "Bed rest" } });
    await screen.findAllByText("Nile Family Clinic");

    expect(document.querySelectorAll(".print-sheet")).toHaveLength(4);
    const text = root().textContent ?? "";
    expect(text).toContain("SICK LEAVE CERTIFICATE");
    expect(text).toContain("09 Sep 2026");
    // Three days from Wednesday ends on Friday, not Saturday. An off-by-one here is a day of pay.
    expect(text).toContain("11 Sep 2026");
    expect(text).toContain("Bed rest");
  });

  test("carries the letterhead and the signature block, like every other sheet", async () => {
    renderSheets({ ...VISIT, sickLeave: { days: 2, from: "2026-09-09", note: null } });
    await screen.findAllByText("Nile Family Clinic");

    const sheets = [...document.querySelectorAll(".print-sheet")];
    const certificate = sheets.find((sheet) => sheet.textContent?.includes("SICK LEAVE CERTIFICATE"));
    expect(certificate).toBeDefined();
    expect(certificate?.querySelector(".print-letterhead")).not.toBeNull();
    expect(certificate?.querySelector(".print-signature")).not.toBeNull();
  });
});
