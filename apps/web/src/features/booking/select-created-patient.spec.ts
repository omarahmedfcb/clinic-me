import { describe, expect, test, vi } from "vitest";
import { loadPatientById, searchPatients } from "./booking-api.ts";

/**
 * Q32 — the defect PR 7a shipped: a newly registered patient was not selected.
 *
 * The dialog fetched them by *searching for their id*. Search matches name, phone and national ID,
 * so a UUID matched nothing, the selection stayed `null`, and the receptionist had to go and find
 * the patient they had just created. The comment beside it described the right intent while the code
 * did the wrong thing.
 *
 * Tested as the request rather than the rendering, deliberately. A render assertion — "the search box
 * disappeared" — is satisfied just as well by the dialog unmounting, and a selection that silently
 * did not happen is exactly what is being guarded.
 */

const ID = "01a07b2b-1f85-7a54-a358-8889172b99ad";

describe("fetching the created patient", () => {
  test("goes to /patients/:id, and returns the row the server wrote", async () => {
    const authFetch = vi.fn(async (_path: string) =>
      new Response(
        JSON.stringify({ id: ID, fullNameAr: "مريض جديد", fullNameEn: null, phoneE164: "+201005559999" }),
        { headers: { "content-type": "application/json" } },
      ),
    );

    const patient = await loadPatientById(authFetch, ID);

    expect(String(authFetch.mock.calls.at(0)?.[0] ?? "")).toBe(`/api/patients/${ID}`);
    expect(patient?.id).toBe(ID);
    expect(patient?.fullNameAr).toBe("مريض جديد");
  });

  test("a failure is null, not a half-built patient", async () => {
    const authFetch = vi.fn(async (_path: string) => new Response("", { status: 404 }));
    expect(await loadPatientById(authFetch, ID)).toBeNull();
  });

  test("searching by that id finds nobody — the bug, demonstrated", async () => {
    // The server is not consulted here: `?q=<uuid>` is answered with an empty list, which is what
    // the real search does, because a UUID is not a name, a phone or a national ID.
    const authFetch = vi.fn(async (_path: string) =>
      new Response("[]", { headers: { "content-type": "application/json" } }),
    );

    expect(await searchPatients(authFetch, ID)).toEqual([]);
    expect(String(authFetch.mock.calls.at(0)?.[0] ?? "")).toContain("q=");
  });
});

