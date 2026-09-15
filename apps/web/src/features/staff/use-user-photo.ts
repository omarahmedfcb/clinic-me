// Fetches one person's photo as an object URL and revokes it on unmount.
// A hook rather than part of <Avatar>, so the design system stays presentational and session-free.

import { useEffect, useState } from "react";
import { useSession } from "../auth/session.tsx";
import { loadUserPhoto } from "./staff-api.ts";

/**
 * The photo for a membership, or null.
 *
 * `hasPhoto` is a hint, not a gate: pass it where the server already said (the users list) to avoid a
 * request that can only 404, and leave it undefined where nothing has said yet — the top bar knows a
 * membership id and nothing else, and a 404 there is an ordinary answer rather than an error.
 *
 * The object URL is revoked on unmount: a leaked one holds the bytes for the life of the tab, and
 * these remount on every list refresh.
 */
export function useUserPhoto(membershipId: string, hasPhoto?: boolean): string | null {
  const { authFetch } = useSession();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (hasPhoto === false) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    let created: string | null = null;

    void loadUserPhoto(authFetch, membershipId).then((value) => {
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
  }, [authFetch, membershipId, hasPhoto]);

  return url;
}
