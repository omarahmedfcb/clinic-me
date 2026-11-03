import { pickHumanSupport } from "./human-support.ts";

/**
 * Who a patient is sent to when they ask for a person on WhatsApp. Pure, so the rule is pinned here
 * without a database; the Users tab and the bot both read it through `pickHumanSupport`.
 */

const mona = { membershipId: "m-mona" };
const yasmin = { membershipId: "m-yasmin" };

describe("pickHumanSupport", () => {
  test("the chosen receptionist, when they are still an active one", () => {
    expect(pickHumanSupport("m-yasmin", [mona, yasmin])).toBe(yasmin);
  });

  test("a clinic's only receptionist is its human support when nobody was chosen", () => {
    expect(pickHumanSupport(null, [mona])).toBe(mona);
  });

  test("two receptionists and nobody chosen is nobody, not the first one found", () => {
    expect(pickHumanSupport(null, [mona, yasmin])).toBeNull();
  });

  test("no receptionist at all is nobody", () => {
    expect(pickHumanSupport(null, [])).toBeNull();
    expect(pickHumanSupport("m-mona", [])).toBeNull();
  });

  test("a chosen receptionist who is no longer active falls back to the only one left, else nobody", () => {
    expect(pickHumanSupport("m-gone", [mona])).toBe(mona);
    expect(pickHumanSupport("m-gone", [mona, yasmin])).toBeNull();
  });
});
