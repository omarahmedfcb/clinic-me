import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Spinner } from "../../design-system/Spinner.tsx";
import { PrintSheets, usePrintHost, type Branding } from "../visits/PrintDocuments.tsx";
import { PRINT_STYLESHEET } from "../visits/print-styles.ts";
import type { SheetKind } from "../visits/print-sheet-event.ts";
import {
  loadDocuments,
  pdfUrl,
  toPrintable,
  type DocumentKind,
  type PublicVisitDocuments,
} from "./documents-api.ts";

declare global {
  interface Window {
    /** Set when the sheet is laid out, so the server's browser knows when to print. */
    __DOCUMENT_READY__?: boolean;
  }
}

const KINDS: DocumentKind[] = ["prescription", "investigations", "sickLeave"];

const TITLES: Record<DocumentKind, string> = {
  prescription: "الروشتة",
  investigations: "طلب الفحوصات",
  sickLeave: "الإجازة المرضية",
};

const COPY = {
  loading: "جارٍ تحميل المستندات",
  unavailable:
    "هذا الرابط غير صالح أو انتهت صلاحيته. يرجى التواصل مع العيادة للحصول على نسخة من مستنداتك.",
  heading: "مستندات زيارتك",
  private: "هذه المستندات خاصة بك. لا تشارك هذا الرابط مع أحد.",
  download: "تحميل PDF",
  downloadHint: "قد يستغرق التحميل بضع ثوانٍ.",
  preview: "عرض",
} as const;

/** `/d/<token>` -> `<token>`. */
const tokenFromPath = (): string => window.location.pathname.split("/")[2] ?? "";

export const isDocumentsPath = (): boolean => window.location.pathname.startsWith("/d/");

const brandingOf = (documents: PublicVisitDocuments): Branding => ({
  clinic: documents.clinic,
  doctor: documents.doctor,
  logo: documents.images.logo,
  signature: documents.images.signature,
  stamp: documents.images.stamp,
});

const hasSickLeave = (documents: PublicVisitDocuments): boolean =>
  documents.sickLeave.days !== null && documents.sickLeave.from !== null;

const available = (documents: PublicVisitDocuments, kind: DocumentKind): boolean => {
  if (kind === "sickLeave") return hasSickLeave(documents);
  return true;
};

/**
 * What a patient opens from the WhatsApp message. No login: the address is the credential.
 *
 * The page is also what the server's browser prints to make a PDF (`?print=<kind>`), so the PDF the patient
 * downloads is the same document the doctor prints, built from the same components. In that mode nothing but
 * the one sheet is rendered, and the page says when it is ready.
 */
export function VisitDocumentsPage() {
  const token = tokenFromPath();
  const printKind = new URLSearchParams(window.location.search).get("print");
  const renderMode = new URLSearchParams(window.location.search).get("render") === "1";

  const [state, setState] = useState<{ kind: "loading" } | { kind: "gone" } | { kind: "ready"; documents: PublicVisitDocuments }>({
    kind: "loading",
  });

  useEffect(() => {
    // The address holds the token, and a patient's browser would send it onward in a Referer.
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex, nofollow";
    document.head.append(meta, robots);
    return () => {
      meta.remove();
      robots.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadDocuments(token, renderMode || printKind !== null).then((result) => {
      if (cancelled) return;
      setState(result.ok ? { kind: "ready", documents: result.documents } : { kind: "gone" });
    });
    return () => {
      cancelled = true;
    };
  }, [token, renderMode, printKind]);

  if (state.kind === "loading") {
    return (
      <main dir="rtl" lang="ar" className="flex min-h-screen items-center justify-center gap-3 bg-neutral-50 p-6 text-neutral-700">
        <Spinner />
        <span>{COPY.loading}</span>
      </main>
    );
  }

  if (state.kind === "gone") {
    return (
      <main dir="rtl" lang="ar" className="flex min-h-screen items-center justify-center bg-neutral-50 p-6">
        <p className="max-w-md text-center text-neutral-800">{COPY.unavailable}</p>
      </main>
    );
  }

  const kind = KINDS.find((candidate) => candidate === printKind);
  if (printKind !== null) {
    // An unknown or empty kind is not printed: a blank sheet is worse than a failed render.
    return kind !== undefined && available(state.documents, kind) ? (
      <PrintMode documents={state.documents} kind={kind} />
    ) : null;
  }

  return <Documents token={token} documents={state.documents} />;
}

function Documents({ token, documents }: { token: string; documents: PublicVisitDocuments }) {
  const branding = brandingOf(documents);
  const printable = toPrintable(documents);

  return (
    <main dir="rtl" lang="ar" className="min-h-screen bg-neutral-50 px-4 py-6 text-neutral-900">
      <div className="mx-auto max-w-3xl">
        <header className="mb-4 text-center">
          <h1 className="text-xl font-bold">{documents.clinic.name}</h1>
          <p className="mt-1 text-neutral-700">{`${COPY.heading} — ${documents.visitDate}`}</p>
          <p className="mt-2 text-sm text-neutral-600">{COPY.private}</p>
        </header>

        <div className="grid gap-3">
          {KINDS.filter((kind) => available(documents, kind)).map((kind) => (
            <section key={kind} className="rounded-lg border border-neutral-300 bg-white p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{TITLES[kind]}</h2>
                <a
                  href={pdfUrl(token, kind)}
                  rel="noreferrer"
                  className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white"
                >
                  {COPY.download}
                </a>
              </div>

              <details className="mt-3">
                <summary className="cursor-pointer text-sm text-neutral-700">{COPY.preview}</summary>
                {/* The sheets are laid out for A4; on a phone they scroll sideways rather than reflow. */}
                <div className="mt-3 overflow-x-auto">
                  <div className="min-w-[640px]">
                    <PrintSheets visit={printable} branding={branding} only={kind as SheetKind} />
                  </div>
                </div>
              </details>
            </section>
          ))}
        </div>

        <p className="mt-4 text-center text-xs text-neutral-500">{COPY.downloadHint}</p>
      </div>
    </main>
  );
}

/** One sheet in the print root, and a flag for the server's browser once it is on the page. */
function PrintMode({ documents, kind }: { documents: PublicVisitDocuments; kind: DocumentKind }) {
  const host = usePrintHost();

  useEffect(() => {
    if (host === null) return;
    let cancelled = false;
    const images = Array.from(host.querySelectorAll("img"));
    void Promise.all([
      document.fonts?.ready,
      ...images.map((image) => (image.complete ? Promise.resolve() : image.decode().catch(() => undefined))),
    ]).then(() => {
      // Two frames: the sheet has to be laid out before it is printed.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!cancelled) window.__DOCUMENT_READY__ = true;
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [host]);

  if (host === null) return null;

  return createPortal(
    <>
      <style>{PRINT_STYLESHEET}</style>
      <PrintSheets visit={toPrintable(documents)} branding={brandingOf(documents)} only={kind as SheetKind} />
    </>,
    host,
  );
}
