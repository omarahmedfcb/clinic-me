let pending: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
    pending ??= (async () => {
        try {
            const response = await fetch("/api/auth/refresh", { method: "POST", credentials: "include" });
            if (!response.ok) return null;
            return ((await response.json()) as { accessToken: string }).accessToken;
        } catch {
            return null;
        } finally {
            pending = null;
        }
    })();
    return pending;
}