import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LocaleProvider } from "../../i18n/locale-context.tsx";
import { AttachmentsSection } from "./AttachmentsSection.tsx";

/**
 * Attachments on the live visit screen — PR 9's client half, the backend having existed since Q10
 * with nothing calling it.
 *
 * The assertions worth having are the ones about the *request*: a multipart body the server can
 * parse, and no hand-set `content-type`. Setting that header by hand overwrites the boundary
 * parameter the browser generates, and the server then parses nothing out of a request that looks
 * perfectly well-formed in a network panel — a failure with no visible cause.
 */

const HEADER = {
  patientId: "22222222-2222-4222-8222-222222222222",
  fullNameAr: "مريم حسن",
  fullNameEn: null,
  dateOfBirth: "1990-04-02",
  gender: "FEMALE",
  phoneE164: "+201000000000",
  allergies: [],
  allergiesReviewedAt: null,
  coverage: { standing: "NONE" as const },
  visitCount: 2,
  lastVisitAt: null,
};

const ATTACHMENT = {
  id: "33333333-3333-4333-8333-333333333333",
  fileName: "أشعة-الركبة.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2048,
  category: "IMAGING",
  description: null,
  createdAt: "2026-09-09T08:00:00.000Z",
  archivedAt: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Answers the header, then whatever the test wants for the attachment routes. */
function renderSection(inner: (path: string, init?: RequestInit) => Promise<Response>) {
  const authFetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.includes("/clinical-summary")) return json(HEADER);
    return inner(path, init);
  });
  render(
    <LocaleProvider>
      <AttachmentsSection authFetch={authFetch} appointmentId="appt-1" visitId="visit-1" />
    </LocaleProvider>,
  );
  return authFetch;
}

afterEach(cleanup);

describe("attachments on the visit screen", () => {
  test("lists what is on file, with its type and date", async () => {
    renderSection(async () => json([ATTACHMENT]));
    await screen.findByText("أشعة-الركبة.pdf");
    // Scoped to the row: the category select offers the same words, so a page-wide match would
    // pass on the dropdown alone and say nothing about what the list renders.
    const row = screen.getByTestId(`attachment-${ATTACHMENT.id}`);
    // The category reaches the screen as a word, never as the stored enum (the 2026-09-09 ruling).
    expect(row.textContent).not.toContain("IMAGING");
    expect(row.textContent).toContain("أشعة");
    expect(row.textContent).toContain("2026");
  });

  test("uploads as multipart, and does not set content-type itself", async () => {
    const authFetch = renderSection(async (_path, init) => {
      if (init?.method === "POST") return json({ ...ATTACHMENT, id: "new" }, 201);
      return json([]);
    });
    await screen.findByTestId("attachment-file-input");

    const input = screen.getByTestId("attachment-file-input") as HTMLInputElement;
    const file = new File(["x"], "lab.pdf", { type: "application/pdf" });
    Object.defineProperty(input, "files", { value: [file] });
    fireEvent.change(input);

    await waitFor(() => {
      const post = authFetch.mock.calls.find(([, init]) => init?.method === "POST");
      expect(post).toBeDefined();
      const [path, init] = post as [string, RequestInit];
      expect(path).toBe("/api/patients/22222222-2222-4222-8222-222222222222/attachments");
      expect(init.body).toBeInstanceOf(FormData);
      // The whole point: the browser writes the boundary, so no header may be set here.
      expect(init.headers).toBeUndefined();
      const body = init.body as FormData;
      expect(body.get("category")).toBe("LAB");
      expect(body.get("visitId")).toBe("visit-1");
    });
  });

  test("the camera input asks for the camera, which is how a lab slip actually arrives", () => {
    renderSection(async () => json([]));
    const camera = screen.getByTestId("attachment-camera-input");
    // `capture` is what makes a phone open the camera rather than the file browser. Without it this
    // is a second file picker, which is the whole feature on a phone quietly not happening.
    expect(camera.getAttribute("capture")).toBe("environment");
    expect(camera.getAttribute("accept")).toBe("image/*");
  });

  test("a refused upload is shown as a sentence, not as a code", async () => {
    renderSection(async (_path, init) => {
      if (init?.method === "POST") return json({ code: "TOO_LARGE", params: {} }, 413);
      return json([]);
    });
    await screen.findByTestId("attachment-file-input");

    const input = screen.getByTestId("attachment-file-input") as HTMLInputElement;
    Object.defineProperty(input, "files", {
      value: [new File(["x"], "huge.pdf", { type: "application/pdf" })],
    });
    fireEvent.change(input);

    const alert = await screen.findByTestId("attachment-failure");
    expect(alert.textContent).not.toContain("TOO_LARGE");
    expect((alert.textContent ?? "").length).toBeGreaterThan(10);
  });

  test("archiving asks the archive route, and archiving is all it asks", async () => {
    // Never a DELETE: medical records are archived, never hard-deleted (CLAUDE.md).
    const authFetch = renderSection(async (path, init) => {
      if (init?.method === "POST" && path.includes("/archive")) return json({ ...ATTACHMENT });
      return json([ATTACHMENT]);
    });
    await screen.findByTestId(`archive-${ATTACHMENT.id}`);
    fireEvent.click(screen.getByTestId(`archive-${ATTACHMENT.id}`));

    await waitFor(() =>
      expect(
        authFetch.mock.calls.some(([path]) => path === `/api/attachments/${ATTACHMENT.id}/archive`),
      ).toBe(true),
    );
    expect(authFetch.mock.calls.every(([, init]) => init?.method !== "DELETE")).toBe(true);
  });
});
