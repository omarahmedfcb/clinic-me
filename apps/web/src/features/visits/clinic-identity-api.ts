// What a printed sheet needs to name the clinic and the doctor. Q28.
// Images are fetched with the caller's token and turned into object URLs — they are not public paths.

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
  /** Q45: the English letterhead; the sheet falls back to the Arabic value when null. */
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

export async function loadDoctorPrintIdentity(
  authFetch: AuthFetch,
  doctorId: string,
): Promise<DoctorPrintIdentity | null> {
  const response = await authFetch(`/api/clinic-identity/doctors/${doctorId}`);
  return response.ok ? ((await response.json()) as DoctorPrintIdentity) : null;
}

/**
 * The bytes of a branding image, as an object URL, or null when there is none.
 *
 * **Not an `<img src>` pointing at the API.** These routes are behind a bearer token, which an
 * `<img>` element cannot send, and the alternative — serving them from a public path — is the thing
 * `StorageProvider`'s missing `url()` exists to prevent. The caller revokes the URL when it is done.
 *
 * Three functions rather than one taking a path, because `route-capability-manifest.spec.ts` reads
 * the client's call sites as literals: a path passed in as a variable is a call it cannot check
 * against the API, and it reports that rather than skipping it.
 */
async function objectUrl(response: Response): Promise<string | null> {
  if (!response.ok) return null;
  return URL.createObjectURL(await response.blob());
}

export async function loadLogo(authFetch: AuthFetch): Promise<string | null> {
  return objectUrl(await authFetch("/api/clinic-identity/logo"));
}

export async function loadSignature(
  authFetch: AuthFetch,
  doctorId: string,
): Promise<string | null> {
  return objectUrl(await authFetch(`/api/clinic-identity/doctors/${doctorId}/signature`));
}

export async function loadStamp(authFetch: AuthFetch, doctorId: string): Promise<string | null> {
  return objectUrl(await authFetch(`/api/clinic-identity/doctors/${doctorId}/stamp`));
}

/** Q9's `printed_count`, and the only trace printing leaves. */
export async function recordPrescriptionPrinted(
  authFetch: AuthFetch,
  appointmentId: string,
  visitId: string,
): Promise<number | null> {
  const response = await authFetch(
    `/api/appointments/${appointmentId}/visit/${visitId}/prescription/printed`,
    { method: "POST" },
  );
  if (!response.ok) return null;
  return ((await response.json()) as { printedCount: number }).printedCount;
}
