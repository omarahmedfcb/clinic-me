import { readFileSync } from "node:fs";
import path from "node:path";
import { stripComments } from "../../scripts/route-capabilities.ts";

/**
 * Q32 — the booking dialog fetches a newly registered patient by id, and never searches for one.
 *
 * The defect PR 7a shipped: it searched by the patient's id. Search matches name, phone and national
 * ID, so a UUID matched nothing, the selection stayed null, and the receptionist had to find the
 * patient they had just created.
 *
 * A source check, in the shape `web-visit-entry-points.spec.ts` already uses, and it lives here
 * rather than beside the component for a concrete reason: `apps/web` has no `@types/node`, so a spec
 * there that reads a file typechecks in vitest and **fails `npm run build`** — which is how this
 * check first broke the frontend build.
 *
 * Driving the flow through both nested dialogs was tried and abandoned: it depends on two Radix
 * modals and the intake form's own validation, and failed for reasons unrelated to the selection.
 * The client half of this — that `loadPatientById` calls `/patients/:id` — is tested in
 * `apps/web/src/features/booking/select-created-patient.spec.ts`.
 */

const DIALOG = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "web",
  "src",
  "features",
  "booking",
  "BookAppointmentDialog.tsx",
);

describe("booking selects the patient it just created", () => {
  const source = stripComments(readFileSync(DIALOG, "utf8"));

  test("onCreated fetches by id", () => {
    expect(source).toMatch(/onCreated=\{[\s\S]{0,600}?loadPatientById\(/);
  });

  test("onCreated does not search by id, which is what shipped", () => {
    expect(source).not.toMatch(/onCreated=\{[\s\S]{0,600}?searchPatients\(\s*authFetch\s*,\s*id\s*\)/);
  });
});
