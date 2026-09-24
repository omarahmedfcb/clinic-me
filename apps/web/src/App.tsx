import { useCallback, useEffect, useState } from "react";
import { Spinner } from "./design-system/Spinner.tsx";
import { LoginPage } from "./features/auth/LoginPage.tsx";
import { SessionProvider, fetchMe, type CurrentUser } from "./features/auth/session.tsx";
import { ChangePasswordScreen } from "./features/staff/ChangePasswordScreen.tsx";
import { GalleryPage } from "./features/gallery/GalleryPage.tsx";
import { PlatformConsole } from "./features/platform/PlatformConsole.tsx";
import { AppShell } from "./features/shell/AppShell.tsx";
import { WebchatPage } from "./features/webchat/WebchatPage.tsx";

/**
 * Which screen is on: the login page, or the authenticated shell.
 *
 * Deliberately not a router. There are two application screens and a gallery, and `react-router`
 * would be a dependency added to choose between them. The Phase 2 sections are what will actually
 * need routing, and that change should introduce it, with its own review.
 *
 * ## The refresh-on-load attempt
 *
 * The access token lives in memory (see session.tsx), so a page reload loses it — but the refresh
 * token is an httpOnly cookie and survives. So the app asks `/auth/refresh` once on mount: if the
 * cookie is still good the user lands back in the shell, and if it is not they get the login page.
 *
 * Without this, F5 would sign a receptionist out. With it, the fifteen-minute access token is
 * invisible to her, which is the entire point of having a refresh token at all.
 */

/** The operator's console. One definition, because two checks would drift the first time one moved. */
export const isPlatformPath = (): boolean => window.location.pathname.startsWith("/platform");

/** The public booking chat prototype -- no login, reachable by a patient who has never heard of
 *  this page. Same reasoning as isPlatformPath: one definition, checked before the session logic. */
export const isWebchatPath = (): boolean => window.location.pathname.startsWith("/book");

type Screen =
  | { kind: "loading" }
  | { kind: "login" }
  // PR 10: a session that exists and may do nothing until its temporary password is replaced.
  | { kind: "password"; token: string }
  | { kind: "shell"; token: string; me: CurrentUser };

export function App() {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  const signedIn = useCallback((token: string, me: CurrentUser) => {
    setScreen({ kind: "shell", token, me });
  }, []);

  const mustChangePassword = useCallback((token: string) => {
    setScreen({ kind: "password", token });
  }, []);

  const signedOut = useCallback(() => {
    setScreen({ kind: "login" });
  }, []);

  useEffect(() => {
    let cancelled = false;

    // The operator's console is not a clinic session, and asking for one on its behalf produces a
    // 401 in the browser console on every load — noise that reads as a fault during a review. The
    // early return below cannot prevent this: hooks run before it.
    if (isPlatformPath()) return;

    // The web chat has no session at all -- a patient here has never logged in and never will.
    if (isWebchatPath()) return;

    void (async () => {
      try {
        const response = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
        if (!response.ok) throw new Error("no session");
        const { accessToken } = (await response.json()) as { accessToken: string };
        const me = await fetchMe(accessToken);
        if (cancelled) return;
        // A refresh that succeeds but whose /auth/me fails is not a session -- fall to login rather
        // than render a shell with nothing in the header.
        setScreen(me ? { kind: "shell", token: accessToken, me } : { kind: "login" });
      } catch {
        if (!cancelled) setScreen({ kind: "login" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Kept reachable for review; it is not part of the application's own navigation.
  if (window.location.pathname.startsWith("/gallery")) return <GalleryPage />;

  /**
   * **The public booking chat prototype, outside the clinic application entirely.**
   *
   * Checked before the session logic below, same as the platform console: a patient reaching
   * `/book` has no membership, no token and no clinic yet -- the chat itself is how a clinic gets
   * chosen. See docs/ARCHITECTURE.md §12 and apps/api/src/modules/webchat.
   */
  if (isWebchatPath()) return <WebchatPage />;

  /**
   * **The operator's console, outside the clinic application entirely** — pilot-readiness 0b–0f.
   *
   * Checked before the session logic below, and never inside `AppShell`: the shell is built around a
   * membership, and the operator holds none in any clinic. Its own login, its own token, and a
   * sidebar it never appears in — a link to it from a clinic's navigation would be describing a
   * person the product does not have.
   */
  if (isPlatformPath()) return <PlatformConsole />;

  if (screen.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-surface-sunken">
        <Spinner size="lg" />
      </div>
    );
  }

  if (screen.kind === "login") {
    return <LoginPage onSignedIn={signedIn} onMustChangePassword={mustChangePassword} />;
  }

  if (screen.kind === "password") {
    const { token } = screen;
    return (
      <ChangePasswordScreen
        // A one-token fetcher: there is no session to speak of yet, and `SessionProvider` would
        // immediately read `/auth/me`, which this account is refused until the password changes.
        authFetch={(path, init) =>
          fetch(path, {
            ...init,
            credentials: "include",
            headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
          })
        }
        onChanged={(accessToken) => {
          void (async () => {
            const me = await fetchMe(accessToken);
            setScreen(me === null ? { kind: "login" } : { kind: "shell", token: accessToken, me });
          })();
        }}
      />
    );
  }

  return (
    <SessionProvider initialToken={screen.token} initialMe={screen.me} onSignedOut={signedOut}>
      <AppShell />
    </SessionProvider>
  );
}
