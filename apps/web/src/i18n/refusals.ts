import type { TranslationKey } from "./strings.ts";

/**
 * Refusals, rendered in Arabic by the client — ruled 2026-09-06.
 *
 * The API returns `{ code, params }` and no sentence. Every word a user reads about a refusal is
 * chosen here, which is what makes another locale a client change rather than an API one.
 *
 * ## Why the table lives beside the catalogue and not inside it
 *
 * `strings.ts` is a flat map of key to string. A refusal needs two things a flat map cannot express:
 * which of its params are substituted, and a per-code decision about whether a user should see it at
 * all. So the Arabic lives in `strings.ts` under `refusal.*` like everything else, and this file
 * holds the small amount of logic — substitution, the resource nouns, and the three codes that are
 * bugs rather than outcomes.
 */

export interface Refusal {
  code: string;
  params?: Record<string, unknown>;
}

/**
 * The nouns `NOT_FOUND` can be about.
 *
 * Ruled: `NOT_FOUND` stays one code with a `resource` param rather than splitting into a dozen
 * codes, because "no such appointment" and "no such doctor" ask the user for the same next action —
 * look again at what you clicked. Only a sentence that asks for something *different* earns its own
 * code, which is why `NO_VISIT_YET`, `NO_CONTACT_RECORD` and `SCOPE_TOO_NARROW` are separate.
 *
 * An unknown resource falls back to a generic noun rather than to a blank, so a resource the server
 * adds before the client knows about it reads as "that item" and not as a hole in the sentence.
 */
const RESOURCE_KEY: Record<string, TranslationKey> = {
  appointment: "resource.appointment",
  attachment: "resource.attachment",
  coverage: "resource.coverage",
  doctor: "resource.doctor",
  exception: "resource.exception",
  membership: "resource.membership",
  patient: "resource.patient",
  policy: "resource.policy",
  service: "resource.service",
  transfer: "resource.transfer",
  visit: "resource.visit",
};

/**
 * The ways a transfer request can already be settled.
 *
 * Substituted into `ALREADY_DECIDED`, which since the 2026-09-07 merge is the only code for all
 * three — `NO_LONGER_OPEN` was folded into it. That makes this table load-bearing in a way the
 * `resource` nouns are not: it carries the entire distinction the second code used to carry, so a
 * status missing from here turns three different sentences into one with a hole in it.
 *
 * Translated rather than inserted raw for the same reason `resource` is: `LAPSED` is a wire
 * vocabulary term, and dropping it into an Arabic sentence would put a Latin enum in front of a
 * receptionist.
 */
const STATUS_KEY: Record<string, TranslationKey> = {
  ACCEPTED: "transfer.status.ACCEPTED",
  REJECTED: "transfer.status.REJECTED",
  LAPSED: "transfer.status.LAPSED",
};

/**
 * Codes that describe a programming error rather than something the user did.
 *
 * Ruled: they get one generic apology, not a translated explanation of an internal edge. Rendering
 * *"MARK_NO_SHOW needs now, scheduledStart and noShowGraceMinutes"* in Arabic would dress a bug up
 * as a decision somebody could act on, and the person who needs those words is not at the desk.
 */
const DEVELOPER_FACING = new Set(["MISSING_CONTEXT", "ILLEGAL_TRANSITION", "TERMINAL_STATUS"]);

/**
 * The Arabic sentence for a refusal.
 *
 * `t` is passed in rather than imported so this stays a pure function of its inputs — the same
 * reason `roleLabel` takes it, and what lets the conformance spec check every code without a React
 * tree.
 *
 * A code with no entry renders its own key, visibly, exactly as `t()` does for a missing string. An
 * untranslated refusal must read as "nobody has written this yet" and never as a blank, which would
 * look like the server sent nothing.
 */
export function refusalText(
  refusal: Refusal,
  t: (key: TranslationKey) => string,
): string {
  if (DEVELOPER_FACING.has(refusal.code)) return t("refusal.INTERNAL");

  const key = `refusal.${refusal.code}` as TranslationKey;
  const template = t(key);
  return substitute(template, refusal.params ?? {}, t);
}

/**
 * `{name}` substitution, using the convention `strings.ts` already follows for `doctors.upcoming`
 * and `shell.support.message`.
 *
 * `resource` and `status` are special-cased: their values are vocabulary terms off the wire, not
 * display values, so each is translated through its own table before substitution. Everything else
 * is a number or a date and is inserted as written.
 *
 * An unknown value falls back differently for the two, on purpose. `resource` has a generic noun
 * ("that item") that keeps its sentence grammatical. `status` has none that would be honest — a
 * transfer state this client has never heard of is not something to paper over with a vague word,
 * so it renders the raw term, visibly, the same way `t()` renders a missing key.
 */
function substitute(
  template: string,
  params: Record<string, unknown>,
  t: (key: TranslationKey) => string,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    if (value === undefined) return whole;
    if (name === "resource") {
      const nounKey = RESOURCE_KEY[String(value)];
      return nounKey === undefined ? t("resource.unknown") : t(nounKey);
    }
    if (name === "status") {
      const statusKey = STATUS_KEY[String(value)];
      return statusKey === undefined ? String(value) : t(statusKey);
    }
    return Array.isArray(value) ? value.join("، ") : String(value);
  });
}
