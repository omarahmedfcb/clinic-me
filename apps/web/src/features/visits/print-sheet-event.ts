// The four printable sheets, and how a button anywhere on the visit screen asks for one.
// The sheets live in PrintSection; the buttons live beside the data each sheet prints.

export const SHEET_KINDS = ["prescription", "report", "investigations", "sickLeave"] as const;
export type SheetKind = (typeof SHEET_KINDS)[number];

export const PRINT_SHEET_EVENT = "clinic-os:print-sheet";

export function requestPrint(kind: SheetKind): void {
  window.dispatchEvent(new CustomEvent<SheetKind>(PRINT_SHEET_EVENT, { detail: kind }));
}
