// A clinic wired by hand to a Meta test number (tokens and ids in .env) has no subscription range and
// must never be paused or suspended for lacking one. Listed by phone_number_id, comma separated.

export function isSubscriptionExempt(phoneNumberId: string | null | undefined): boolean {
  if (phoneNumberId === null || phoneNumberId === undefined || phoneNumberId === "") return false;
  const listed = (process.env["SUBSCRIPTION_EXEMPT_PHONE_NUMBER_IDS"] ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  return listed.includes(phoneNumberId);
}
