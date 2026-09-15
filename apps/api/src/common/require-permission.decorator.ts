import { SetMetadata } from "@nestjs/common";
import type { Capability, PermissionLevel } from "./permissions.ts";

export const PERMISSION_METADATA_KEY = "requiredPermission";

export interface RequiredPermission {
  capability: Capability;
  /** The minimum level this route needs. */
  level: Exclude<PermissionLevel, "none">;
}

/**
 * Marks a route as requiring at least `level` access to `capability`.
 *
 * The level is explicit because §8 has three of them and the middle one is real: a doctor's access
 * to schedules is `own`-scoped, not `full`. `@RequirePermission("schedules", "own")` says a doctor
 * may reach this route; `@RequirePermission("schedules", "full")` says only someone who may touch
 * *anyone's* schedule may.
 *
 * The level defaults to `"own"`, which is the weaker of the two -- "any access at all". A route
 * that needs more must say so, because the failure of defaulting the other way is a route that
 * quietly demands more than it needs and locks out the role it was written for.
 *
 * **`own` is an authorisation floor, not a row filter.** This decorator decides whether the request
 * may proceed; it cannot know which rows belong to the caller. A route granted at `own` must still
 * scope its own query -- by `doctorId`, by `createdBy`, by whatever "own" means for that resource.
 */
export const RequirePermission = (capability: Capability, level: Exclude<PermissionLevel, "none"> = "own") =>
  SetMetadata(PERMISSION_METADATA_KEY, { capability, level } satisfies RequiredPermission);
