// Validation of the subscription range typed into the console when a clinic is created. Shared by the
// two creation routes (plain and through Meta's Embedded Signup) so both refuse the same way, and
// both refuse BEFORE anything is created -- a refusal afterwards would leave a clinic with no range.

import { UnprocessableEntityException } from "@nestjs/common";
import { refusal } from "../../common/refusals.ts";
import { planSubscription } from "./subscription-dates.ts";

/**
 * The range a new clinic starts with, or null when the request carries none (the API tolerates that;
 * the console's form does not, and a clinic without a range has a silent bot until one is set).
 * Throws the 422 refusal when only one day is given, or the range is not acceptable.
 */
export function validateNewSubscription(
  body: { timezone: string; subscriptionStartsOn?: string; renewalOn?: string },
  now: Date = new Date(),
): { startsOn: string; endsOn: string } | null {
  const { subscriptionStartsOn: startsOn, renewalOn: endsOn } = body;
  if (startsOn === undefined && endsOn === undefined) return null;
  if (startsOn === undefined || endsOn === undefined) {
    throw new UnprocessableEntityException(
      refusal("INVALID_DATE_RANGE", { field: startsOn === undefined ? "subscriptionStartsOn" : "renewalOn" }),
    );
  }
  const plan = planSubscription({ startsOn: null, endsOn: null }, { startsOn, endsOn }, now, body.timezone);
  if (!plan.ok) throw new UnprocessableEntityException(refusal(plan.code, { field: plan.field }));
  return { startsOn: plan.startsOn, endsOn: plan.endsOn };
}
