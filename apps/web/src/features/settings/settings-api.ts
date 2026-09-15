// The settings screens' view of the API — Q28's fields, Q36's screens.
// Images are fetched with the caller's token and shown as object URLs; there is no public path.

type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

export interface ClinicIdentity {
  name: string;
  address: string;
  phone: string;
  secondaryPhone: string | null;
  /** Q37. All nullable: the sheet prints what is filled and omits what is not. */
  taxRegistrationNumber: string | null;
  commercialRegisterNumber: string | null;
  email: string | null;
  whatsappPhone: string | null;
  printedWorkingHours: string | null;
  tagline: string | null;
  /** Q45: the English letterhead, which is what printed documents actually use. */
  nameEn: string | null;
  addressEn: string | null;
  hasLogo: boolean;
}

export interface DoctorPrintIdentity {
  doctorId: string;
  printedName: string | null;
  printedNameEn: string | null;
  title: string;
  syndicateNumber: string | null;
  licenseNumber: string;
  hasSignature: boolean;
  hasStamp: boolean;
}

export async function loadClinicIdentity(authFetch: AuthFetch): Promise<ClinicIdentity | null> {
  const response = await authFetch("/api/clinic-identity");
  return response.ok ? ((await response.json()) as ClinicIdentity) : null;
}

export async function saveClinicIdentity(
  authFetch: AuthFetch,
  patch: Partial<Omit<ClinicIdentity, "hasLogo">>,
): Promise<ClinicIdentity | null> {
  const response = await authFetch("/api/clinic-identity", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return response.ok ? ((await response.json()) as ClinicIdentity) : null;
}

export async function loadDoctorPrintIdentity(
  authFetch: AuthFetch,
  doctorId: string,
): Promise<DoctorPrintIdentity | null> {
  const response = await authFetch(`/api/clinic-identity/doctors/${doctorId}`);
  return response.ok ? ((await response.json()) as DoctorPrintIdentity) : null;
}

export async function saveDoctorPrintIdentity(
  authFetch: AuthFetch,
  doctorId: string,
  patch: {
    printedName?: string | null;
    printedNameEn?: string | null;
    title?: string;
    syndicateNumber?: string | null;
  },
): Promise<DoctorPrintIdentity | null> {
  const response = await authFetch(`/api/clinic-identity/doctors/${doctorId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return response.ok ? ((await response.json()) as DoctorPrintIdentity) : null;
}

/**
 * Uploads, as multipart. The route sniffs the bytes and refuses anything that is not an image, so
 * the `accept` attribute on the input is a convenience and never the check.
 */
async function upload(authFetch: AuthFetch, path: string, file: File): Promise<boolean> {
  const form = new FormData();
  form.append("file", file);
  const response = await authFetch(path, { method: "POST", body: form });
  return response.ok;
}

export const uploadLogo = (authFetch: AuthFetch, file: File): Promise<boolean> =>
  upload(authFetch, "/api/clinic-identity/logo", file);

export const uploadSignature = (authFetch: AuthFetch, doctorId: string, file: File): Promise<boolean> =>
  upload(authFetch, `/api/clinic-identity/doctors/${doctorId}/signature`, file);

export const uploadStamp = (authFetch: AuthFetch, doctorId: string, file: File): Promise<boolean> =>
  upload(authFetch, `/api/clinic-identity/doctors/${doctorId}/stamp`, file);

/**
 * "Remove" clears the row's pointer. **The stored file is not destroyed** — `StorageProvider` has no
 * `delete()` by design, and a sheet printed last week was made with that image.
 */
export async function removeLogo(authFetch: AuthFetch): Promise<boolean> {
  return (await authFetch("/api/clinic-identity/logo", { method: "DELETE" })).ok;
}

export async function removeSignature(authFetch: AuthFetch, doctorId: string): Promise<boolean> {
  return (await authFetch(`/api/clinic-identity/doctors/${doctorId}/signature`, { method: "DELETE" })).ok;
}

export async function removeStamp(authFetch: AuthFetch, doctorId: string): Promise<boolean> {
  return (await authFetch(`/api/clinic-identity/doctors/${doctorId}/stamp`, { method: "DELETE" })).ok;
}

async function objectUrl(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

/** Literal paths, one function each: the route manifest reads client call sites as literals. */
export async function loadLogo(authFetch: AuthFetch): Promise<string | null> {
  return objectUrl(await authFetch("/api/clinic-identity/logo"));
}

export async function loadSignature(authFetch: AuthFetch, doctorId: string): Promise<string | null> {
  return objectUrl(await authFetch(`/api/clinic-identity/doctors/${doctorId}/signature`));
}

export async function loadStamp(authFetch: AuthFetch, doctorId: string): Promise<string | null> {
  return objectUrl(await authFetch(`/api/clinic-identity/doctors/${doctorId}/stamp`));
}
