/**
 * The services screen's view of the API. Types only, plus thin fetch wrappers.
 *
 * Mirrors `apps/api/src/modules/services/` — CLAUDE.md's rule that modules mirror between the two
 * trees. Hand-written rather than shared through a package, the same choice the auth and schedules
 * features made.
 *
 * ## `priceMinor` is integer minor units and carries no currency
 *
 * Currency lives in `tenants.currency` and reaches the browser on `/auth/me`, so every amount is
 * formatted with `formatMinor(amount, me.currency)`. Nothing in this file may name a currency: a
 * clinic priced in one currency and formatted in another is a silent, expensive kind of wrong.
 *
 * ## `futureAppointmentCount` is the deactivation warning
 *
 * Appointments still to happen that are booked on this service. Deactivation does **nothing** to
 * them — they keep their quoted price and are honoured (`PHASE-5-DESIGN.md` §2.3) — so the number
 * exists to inform the admin, never to block them.
 */

export type ServiceType = "NEW" | "CONSULTATION" | "FOLLOW_UP" | "PROCEDURE";

export const SERVICE_TYPES: readonly ServiceType[] = ["NEW", "CONSULTATION", "FOLLOW_UP", "PROCEDURE"];

export interface Service {
  id: string;
  nameAr: string;
  nameEn: string;
  type: ServiceType;
  durationMinutes: number;
  bufferMinutes: number;
  priceMinor: number;
  isActive: boolean;
  futureAppointmentCount: number;
}

export interface ServiceInput {
  nameAr: string;
  nameEn: string;
  type: ServiceType;
  durationMinutes: number;
  bufferMinutes: number;
  priceMinor: number;
}

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export async function loadServices(authFetch: AuthFetch): Promise<Service[]> {
  const response = await authFetch("/api/services");
  if (!response.ok) throw new Error(`GET /services -> ${response.status}`);
  return (await response.json()) as Service[];
}

/**
 * A rejection is returned rather than thrown, the same shape the schedule editor uses. The API
 * answers 400 with a message naming what it refused, and that message is more use to an admin than
 * "save failed" — particularly for the bounds, where the useful information is which field.
 */
export type WriteResult = { ok: true; service: Service } | { ok: false; message: string };

async function write(
  authFetch: AuthFetch,
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<WriteResult> {
  const response = await authFetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (response.ok) return { ok: true, service: (await response.json()) as Service };

  const detail = await response
    .json()
    .then((payload: unknown) => {
      const message = (payload as { message?: string | string[] } | null)?.message;
      return Array.isArray(message) ? message.join("، ") : message;
    })
    .catch(() => undefined);

  return { ok: false, message: detail ?? `${method} ${path} -> ${response.status}` };
}

export const createService = (authFetch: AuthFetch, input: ServiceInput): Promise<WriteResult> =>
  write(authFetch, "/api/services", "POST", input);

export const updateService = (
  authFetch: AuthFetch,
  id: string,
  input: Partial<ServiceInput> & { isActive?: boolean },
): Promise<WriteResult> => write(authFetch, `/api/services/${id}`, "PATCH", input);
