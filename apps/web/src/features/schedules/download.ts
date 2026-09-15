/**
 * Handing a generated file to the browser.
 *
 * Split from `export-spreadsheet.ts` because that file is pure and this one is not. The API's test
 * project runs the CSV tests, and its tsconfig has no DOM lib — so a single module mixing string
 * building with `document` and `Blob` fails `npm run typecheck` on the API side while passing on
 * the web side. That is the same seam `domain/` keeps for the same reason: the part worth testing
 * should not drag a browser in with it.
 */

/**
 * Hand the file to the browser.
 *
 * A blob URL and a synthetic click — no dependency, and no server round trip for data the page
 * already holds. The object URL is revoked immediately after; leaving it alive pins the blob in
 * memory for the life of the document, which on a screen a receptionist keeps open all day is a
 * slow leak rather than a harmless one.
 */
export function downloadFile(filename: string, contents: string, mime: string): void {
  const blob = new Blob([contents], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The spreadsheet's mime type, kept at the call site's convenience. */
export const downloadCsv = (filename: string, csv: string): void =>
  downloadFile(filename, csv, "text/csv;charset=utf-8");
