// Fetches the clinic's own logo as an object URL and revokes it on unmount.
// A hook rather than part of <ClinicBadge>, so that component stays presentational and session-free.

import { useEffect, useState } from "react";
import { useSession } from "../auth/session.tsx";
import { loadLogo } from "../visits/clinic-identity-api.ts";

/**
 * The signed-in clinic's logo, or null.
 *
 * `GET /clinic-identity/logo` is guarded by `appointments.read`, which every clinic role holds — so
 * a doctor and a receptionist see the same mark an admin does. A clinic that has uploaded none
 * answers 404, and `loadLogo` turns that into null: an ordinary answer here, not an error, exactly
 * as `useUserPhoto` treats a missing photo.
 *
 * Re-fetched when `tenantId` changes, which is what makes the switcher actually switch the mark. An
 * object URL is revoked on unmount and on every switch: a leaked one holds the bytes for the life of
 * the tab.
 */
export function useClinicLogo(tenantId: string): string | null {
  const { authFetch } = useSession();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;

    // Cleared first, so switching from a clinic with a logo to one without does not leave the
    // previous clinic's mark on screen while the request is in flight.
    setUrl(null);

    void loadLogo(authFetch).then((value) => {
      created = value;
      if (cancelled) {
        if (value !== null) URL.revokeObjectURL(value);
        return;
      }
      setUrl(value);
    });

    return () => {
      cancelled = true;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [authFetch, tenantId]);

  return url;
}
