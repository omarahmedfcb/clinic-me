/**
 * Refusal codes — the contract between the API and whatever renders for a human.
 *
 * Ruled 2026-09-06, on `docs/REFUSAL-MESSAGES-PROPOSAL.md`. Three parts:
 *
 * 1. **The API returns `{ code, params }` and no human sentence.** Not a message, not a `detail`,
 *    not an English fallback. The interface is Arabic and right-to-left; a server that ships the
 *    words has already decided the language, and it decided wrong for every screen this clinic
 *    uses.
 * 2. **Codes are split by what the user should DO next, not by the noun that was missing.**
 *    `NOT_FOUND` stays one code carrying a `resource` param, because "no such appointment" and "no
 *    such doctor" ask for the same next action — check what you clicked. A sentence earns its own
 *    code only when it asks for something different: `NO_VISIT_YET` means wait, `NO_CONTACT_RECORD`
 *    means go and add contact details, `SCOPE_TOO_NARROW` means ask an admin.
 * 3. **The client owns rendering**, from `apps/web/src/i18n/refusals.ts`. Arabic now, other locales
 *    later, with no server change.
 *
 * `docs/REFUSAL-CODES.md` is the human-readable source of truth and is generated from this file's
 * `REFUSAL_CODES`; `refusal-codes-conformance.spec.ts` fails when a code here has no Arabic entry
 * there, which is the guard that stops a refusal shipping untranslated.
 */

/**
 * Everything a refusal may carry, as values and never as prose.
 *
 * A phrase cannot be re-ordered for another language's grammar and Arabic re-orders a great deal,
 * so nothing here is a sentence fragment. Numbers, dates, ids and enum members only.
 */
export interface RefusalParams {
  /** Which kind of thing was missing. Rendered from the client's own noun table. */
  resource?: ResourceName;
  /** An appointment or transfer status, rendered from the client's existing status labels. */
  status?: string;
  /** The status the caller believed it had, for a lost race. */
  expected?: string;
  /** A state-machine event name. */
  event?: string;
  /** Statuses an event is legal from. */
  legalFrom?: string[];
  /** A count or a limit — days, bytes, appointments. */
  limit?: number;
  /** The actual value that exceeded a limit. */
  actual?: number;
  /** An ISO date or instant the message needs. */
  at?: string;
  /** A second date, where a message names a range. */
  until?: string;
  /** A declared MIME type, and what the bytes actually were. */
  claimed?: string;
  detected?: string;
  /** The revision a row now carries, so a client that lost a compare-and-set can refetch once. */
  revision?: number;
  /** A name a uniqueness refusal is about -- the client quotes it back so the clash is obvious. */
  name?: string;
  /** ISO weekday, for a schedule refusal that names a day. */
  weekday?: number;
  /**
   * Time windows a refusal is about, as `HH:MM-HH:MM`.
   *
   * A value, not prose: it is not re-ordered by grammar and the client joins the list with its own
   * separator. It replaces two sentences that composed the same facts in English -- an admin
   * editing a week of templates needs to know *which two* clash, and dropping to a bare code would
   * have lost that.
   */
  windows?: string[];
}

/** The nouns `NOT_FOUND` can be about. The client keeps the Arabic for each. */
export const RESOURCE_NAMES = [
  "appointment",
  "attachment",
  // A visit's bill. Distinct from "visit": credit is applied to the charge, and a reader told the
  // visit was not found would look for the wrong thing.
  "charge",
  "coverage",
  "doctor",
  "exception",
  "insuranceCompany",
  "membership",
  "patient",
  "policy",
  "procedure",
  "service",
  "transfer",
  "visit",
] as const;

export type ResourceName = (typeof RESOURCE_NAMES)[number];

/**
 * Every refusal code the API can return.
 *
 * Adding one is not a breaking change; renaming one is, because the client switches on it. The
 * conformance spec fails the build when a code added here has no Arabic entry on the client.
 */
export const REFUSAL_CODES = [
  // ---- booking and the slot engine -------------------------------------------------------
  "SLOT_TAKEN",
  "CONTENDED",
  "INVALID_TOKEN",
  "EXPIRED_TOKEN",
  "OUTSIDE_HORIZON",
  "RANGE_TOO_LONG",
  // ---- the appointment state machine -----------------------------------------------------
  "ILLEGAL_TRANSITION",
  "TERMINAL_STATUS",
  "GRACE_PERIOD_NOT_ELAPSED",
  "REASON_REQUIRED",
  "QUEUE_MOVED_ON",
  "MISSING_CONTEXT",
  // ---- things that were not there --------------------------------------------------------
  "NOT_FOUND",
  "NO_VISIT_YET",
  // The caller saved against a revision the row no longer has: someone else saved first (Q7).
  "STALE_REVISION",
  // The visit is finished. Different action from STALE_REVISION: amend it, do not save into it.
  "ALREADY_COMPLETED",
  // An amendment was sent to a visit still in draft. Different action: just save it.
  "NOT_COMPLETED",
  "NO_CONTACT_RECORD",
  // ---- permission and care relationship --------------------------------------------------
  "NOT_A_DOCTOR",
  "NOT_PERMITTED",
  "NOT_PRESENT",
  "SCOPE_TOO_NARROW",
  // ---- attachments -----------------------------------------------------------------------
  // No file part at all, as opposed to EMPTY_FILE which is a file of zero bytes. Different
  // action: attach one.
  "NO_FILE_UPLOADED",
  "EMPTY_FILE",
  "TOO_LARGE",
  "UNSUPPORTED_TYPE",
  "HEIC_NOT_CONVERTED",
  "TYPE_MISMATCH",
  "VISIT_MISMATCH",
  // ---- transfers -------------------------------------------------------------------------
  "ALREADY_OPEN",
  // Two patients are already linked as kin (Q30). Different action: remove the link or pick another.
  "ALREADY_LINKED",
  // One code for every way a transfer request is no longer answerable, with `status` saying which:
  // ACCEPTED and REJECTED were answered by a person, LAPSED closed itself when the appointment
  // ended. Ruled 2026-09-07, folding in the former NO_LONGER_OPEN.
  //
  // The two codes asked the reader for the same next action -- look at the request again, it is
  // settled -- and by the ruling that governs NOT_FOUND's `resource` param, only a sentence that
  // asks for something *different* earns its own code. The distinction they carried is not lost:
  // it was already in `params.status` on both branches before this merge, and the client renders
  // it, so the sentence still says whether the answer was yes, no, or nobody's.
  "ALREADY_DECIDED",
  "SAME_DOCTOR",
  // ---- clinic management -----------------------------------------------------------------
  "ALREADY_A_DOCTOR",
  // PR 10: that person already has a membership in this clinic. One role per clinic.
  "ALREADY_A_MEMBER",
  // A phone number that is not a phone number. Different action: correct it.
  "INVALID_PHONE",
  // The last active administrator cannot be suspended: nobody would be left to undo it.
  "LAST_ADMIN",
  // Different action from LAST_ADMIN: ask a colleague to do it, rather than appoint someone first.
  "SELF_SUSPEND",
  // That number is already somebody's login. Different action from INVALID_PHONE: it parses fine.
  "DUPLICATE_PHONE",
  // A doctor's record belongs to the Doctors tab. The action is to go there, not to correct input.
  "NOT_EDITABLE_HERE",
  // The slot has already happened. Different action from EXPIRED_TOKEN: no fresh offer would help.
  "PAST_SLOT",
  // Who owns a clinic is not a users-list decision. Transferring ownership needs its own screen.
  "OWNER_ROLE_FIXED",
  // The other half of SELF_SUSPEND: ask a colleague, rather than correct anything.
  "SELF_ROLE_CHANGE",
  "OVERLAPPING_TEMPLATE",
  "INVALID_WINDOW",
  "DUPLICATE_POLICY",
  "DUPLICATE_COMPANY",
  "SPLIT_EXCEEDS_CHARGE",
  "DISCOUNT_ABOVE_CEILING",
  "ALREADY_SETTLED",
  // R1 and R2: both are per-doctor settings an admin turns on, so the next action is to ask an
  // admin -- not the same as SCOPE_TOO_NARROW, which is about a role rather than a person.
  // PR 10: a temporary password is outstanding. Different action from every other refusal here:
  // set a new password, and nothing else will work until you do.
  "PASSWORD_CHANGE_REQUIRED",
  "PRICE_ADJUSTMENT_NOT_ALLOWED",
  // Allowed to adjust, but not by that much. Different action from the one above: adjust by less.
  "PRICE_ADJUSTMENT_ABOVE_CAP",
  "COLLECTION_NOT_ALLOWED",
  // Taking more than is owed. Different action from every other money refusal: collect less.
  // Reachable again from 2026-09-14 (R-A), which reversed ruling 5's desk half — and now from the
  // apply-credit route too, since credit spent past a bill drives the same balance below zero.
  "PAYMENT_EXCEEDS_BALANCE",
  // ---- clinic credit, ruling 5 -------------------------------------------------------------
  // Spending more credit than the patient has. `limit` is the balance, `actual` what was asked.
  "INSUFFICIENT_CREDIT",
  // A refund with no stated reason is the row somebody has to explain a year later.
  "REFUND_REASON_REQUIRED",
  // Zero is not a movement. Money is integer minor units and a movement of nothing is not one.
  "AMOUNT_NOT_POSITIVE",
  // ---- reports, Phase 5 PR 14 --------------------------------------------------------------
  // A day or a month that is neither. Different action from a malformed request: ask for a real
  // period, rather than a shape the server never offered.
  "INVALID_PERIOD",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/**
 * The body every refused request returns. **No `message` field, deliberately.**
 *
 * Nest's exception filter would add one from the status text if the body were a bare string, which
 * is why every controller passes this object: an English sentence appearing on the wire is the
 * thing the ruling removes, and the easiest way for one to come back is a shortcut here.
 */
export interface RefusalBody {
  code: RefusalCode;
  params: RefusalParams;
}

export const refusal = (code: RefusalCode, params: RefusalParams = {}): RefusalBody => ({
  code,
  params,
});

/**
 * Codes that describe a programming error rather than something a user did.
 *
 * Ruled: these never get a specific sentence. The client renders one generic apology for all of
 * them and logs the code, because "MARK_NO_SHOW needs now, scheduledStart and noShowGraceMinutes"
 * is a message for whoever wrote the caller, and translating it into Arabic would dress a bug up as
 * a decision the user could act on.
 */
export const DEVELOPER_FACING: readonly RefusalCode[] = [
  "MISSING_CONTEXT",
  "ILLEGAL_TRANSITION",
  "TERMINAL_STATUS",
];
