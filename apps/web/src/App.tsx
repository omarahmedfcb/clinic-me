import { useCallback, useEffect, useState } from "react";
import { Spinner } from "./design-system/Spinner.tsx";
import { LoginPage } from "./features/auth/LoginPage.tsx";
import { SessionProvider, fetchMe, type CurrentUser } from "./features/auth/session.tsx";
import { ChangePasswordScreen } from "./features/staff/ChangePasswordScreen.tsx";
import { GalleryPage } from "./features/gallery/GalleryPage.tsx";
import { AppShell } from "./features/shell/AppShell.tsx";

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
