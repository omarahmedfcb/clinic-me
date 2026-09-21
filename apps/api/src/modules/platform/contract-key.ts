// Storage keys for contract PDFs. A fourth shape with a fourth validator, for the reason
// `photo-key.ts` gives: widening an existing one makes one guard answer two questions.

/**
 * `platform/` first, not the tenant id — the opposite of every other key here, on purpose.
 *
 * Every other subtree is a clinic's own objects, and "tenant first" is what lets one clinic's data
 * be counted, moved or destroyed as a unit. A contract is the **vendor's** document about a clinic,
 * and it must not leave with them when their subtree does: a terminated customer's export is their
 * records, and our signed agreement is not one of them.
 */
export function contractKeyFor(input: { tenantId: string; contractId: string }): string {
  return `platform/contracts/${input.tenantId}/${input.contractId}.pdf`;
}

/**
 * A key this system could have produced, as an allow-list of the exact shape.
 *
 * `pdf` is spelled here rather than derived from the sniffer's `ACCEPTED`: a contract is a PDF and
 * only a PDF, and deriving the alternation would silently widen this the day an image type is added
 * to that list. The two lists are meant to be different.
 */
const SAFE_CONTRACT_KEY = /^platform\/contracts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.pdf$/;

export function isSafeContractKey(key: string): boolean {
  return SAFE_CONTRACT_KEY.test(key);
}
