// The only place the web app names a time zone. Two constants, equal today, because they mean
// different things: where times are shown, and what a new clinic starts with. Neither is final.

/** The zone the app displays times in. */
export const DISPLAY_TIME_ZONE = "Africa/Cairo";

/** The zone the operator's new-clinic form proposes; a Gulf clinic changes it there. */
export const NEW_CLINIC_TIME_ZONE = "Africa/Cairo";
