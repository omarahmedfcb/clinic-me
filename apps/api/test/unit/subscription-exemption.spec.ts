import { isSubscriptionExempt } from "../../src/modules/platform/subscription-exemption.ts";

describe("subscription exemption", () => {
  const original = process.env["SUBSCRIPTION_EXEMPT_PHONE_NUMBER_IDS"];
  afterEach(() => {
    if (original === undefined) delete process.env["SUBSCRIPTION_EXEMPT_PHONE_NUMBER_IDS"];
    else process.env["SUBSCRIPTION_EXEMPT_PHONE_NUMBER_IDS"] = original;
  });

  test("nothing is exempt when the variable is unset", () => {
    delete process.env["SUBSCRIPTION_EXEMPT_PHONE_NUMBER_IDS"];
    expect(isSubscriptionExempt("1277538882116957")).toBe(false);
  });

  test("a listed id is exempt, with spaces and other ids around it", () => {
    process.env["SUBSCRIPTION_EXEMPT_PHONE_NUMBER_IDS"] = "111, 1277538882116957 ,222";
    expect(isSubscriptionExempt("1277538882116957")).toBe(true);
    expect(isSubscriptionExempt("333")).toBe(false);
    expect(isSubscriptionExempt(null)).toBe(false);
  });
});
