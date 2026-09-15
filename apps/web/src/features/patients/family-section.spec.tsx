import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";

/**
 * The family section renders for a patient with no contact row.
 *
 * Every patient recorded before PR 7a has `contact_id = NULL` — intake never attached one. The
 * household lookup then finds nothing, and a section that assumed a household would crash the whole
 * detail screen for the majority of existing records rather than for an edge case.
 */

const LEGACY = {
  id: "p1",
  fullNameAr: "مريض قديم",
  fullNameEn: null,
  phoneE164: "+201000000000",
  dateOfBirth: null,
  status: "ACTIVE",
  secondaryPhone: null,
  gender: null,
  nationalId: null,
  nationality: null,
  passportNumber: null,
  governorate: null,
  referralSource: null,
  email: null,
  address: null,
  notes: null,
  relationshipToContact: "SELF",
  mergedIntoPatientId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  missingIntakeFields: ["dateOfBirth", "gender", "nationality"],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers as the API does for a legacy row: the patient exists, the household does not. */
const authFetch = async (path: string): Promise<Response> => {
  if (path.includes("/household")) return json({ household: null });
  if (path.includes("/balance")) return json({ outstandingMinor: 0, paymentCount: 0 });
  // Bare arrays, which is what these endpoints actually return.
  if (path.includes("/appointments")) return json([]);
  if (path.includes("/visits")) return json([]);
  // 403 is the ordinary answer for a role without `patients.write`; the block just does not render.
  if (path.includes("/insurance")) return json({}, 403);
  return json(LEGACY);
};

vi.mock("../auth/session.tsx", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../auth/session.tsx");
  return { ...actual, useSession: () => ({ me: { permissions: {} }, authFetch }) };
});

const { PatientDetailPage } = await import("./PatientDetailPage.tsx");

afterEach(cleanup);

describe("a patient recorded before households existed", () => {
  test("renders the family section instead of crashing", async () => {
    render(
      <LocaleProvider>
        <PatientDetailPage patientId="p1" onBack={() => {}} />
      </LocaleProvider>,
    );

    // The screen itself came up -- the assertion that matters, since the failure being guarded is
    // the whole page going down rather than one section looking wrong.
    await screen.findByText("مريض قديم");
    await waitFor(() => expect(screen.getByTestId("family-empty")).toBeTruthy());
    expect(screen.queryByTestId("family-list")).toBeNull();
  });
});
