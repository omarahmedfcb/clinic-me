// The print stylesheet, as a value so a test can assert it rather than eyeball a sheet. Q9, Q29.
// Everything outside the sheet is hidden by ONE rule, so a new panel cannot leak onto the paper.

/**
 * Why the hiding rule is an allow-list.
 *
 * `body > *:not(#print-root) { display: none }` hides everything the app renders and shows only the
 * sheet, so a section added to the visit screen later is hidden by default. The alternative — a list
 * of selectors to hide — is a deny-list that has to be updated every time a panel is added, and the
 * failure when somebody forgets is a patient's diagnosis on a prescription handed across a counter.
 *
 * `PRINT_MARKERS` are the ids the sheet's own structure depends on. `PrintDocuments.spec.tsx`
 * asserts both that each marker is present in the rendered output and that this stylesheet still
 * names it, so a CSS rename that silently stops applying fails a test instead of a print run.
 */
export const PRINT_MARKERS = ["print-root", "print-sheet", "print-letterhead", "print-signature"] as const;

export const PRINT_STYLESHEET = `
@media print {
  @page { size: A4; margin: 12mm; }

  /* An allow-list: everything the application renders is hidden, and only the sheet is shown. */
  body > *:not(#print-root) { display: none !important; }

  #print-root { display: block !important; }

  /* One document per sheet. A prescription continuing onto the back of a report is not a document. */
  .print-sheet { page-break-after: always; break-after: page; }
  .print-sheet:last-child { page-break-after: auto; break-after: auto; }

  /* A letterhead that splits across a page break is a sheet with no clinic on it. */
  .print-letterhead, .print-signature { page-break-inside: avoid; break-inside: avoid; }

  /* Table rows stay whole: half a dose on one page and half on the next is a dispensing error. */
  .print-line { page-break-inside: avoid; break-inside: avoid; }

  /* Ink, not screen colour: a soft grey background prints as a grey smear on a laser printer. */
  .print-sheet, .print-sheet * { background: transparent !important; color: #000 !important; }
}

/* Off-screen rather than hidden: a display:none subtree is not measured, and the sheet has to be
   laid out before the print dialog opens or the first print of a session comes out unstyled. */
@media screen {
  #print-root { position: absolute; inset-inline-start: -10000px; top: 0; width: 210mm; }
}
`;
