import type { AppointmentStatus } from "../../domain/appointment-status.ts";

/**
 * Real rows, copied out of a seeded `clinic_os_dev` on 2026-08-23 — not invented, and not lorem
 * ipsum.
 *
 * This matters more than it looks. Latin placeholder text hides precisely the problems this page
 * exists to find: Arabic glyphs sit on a different baseline and need more line-height, a name like
 * "مصطفى محمد عبد العزيز" is twice the width of "John Smith" and will overflow a column sized by
 * eye, and a phone number beside an Arabic name is a bidirectional boundary where the "+" ends up
 * on the wrong side unless the digits are explicitly isolated.
 *
 * `مصطفى محمد عبد العزيز` and `خديجة صلاح عبد الحميد` are the two longest patient names the seed
 * generated. They are here deliberately, as the column-width stress case.
 *
 * Regenerate with:
 *   SELECT p.full_name, p.phone_e164, p.address, a.status, s.name_ar, s.price_minor
 *   FROM appointments a JOIN patients p ON p.id = a.patient_id
 *   JOIN services s ON s.id = a.service_id ...
 */

export interface PatientRow {
  id: string;
  fullName: string;
  phoneE164: string;
  address: string;
  status: AppointmentStatus;
  serviceAr: string;
  priceMinor: number;
  time: string;
}

export const SEEDED_PATIENTS: readonly PatientRow[] = [
  {
    id: "p1",
    fullName: "مصطفى محمد عبد العزيز",
    phoneE164: "+201060000093",
    address: "المعادي، القاهرة",
    status: "IN_CONSULTATION",
    serviceAr: "متابعة ضغط وسكر",
    priceMinor: 18000,
    time: "09:50",
  },
  {
    id: "p2",
    fullName: "خديجة صلاح عبد الحميد",
    phoneE164: "+201060000025",
    address: "بورسعيد",
    status: "WAITING",
    serviceAr: "إعادة كشف",
    priceMinor: 15000,
    time: "13:55",
  },
  {
    id: "p3",
    fullName: "أميرة عصام الجندي",
    phoneE164: "+201060000005",
    address: "سموحة، الإسكندرية",
    status: "COMPLETED",
    serviceAr: "كشف جديد",
    priceMinor: 30000,
    time: "06:50",
  },
  {
    id: "p4",
    fullName: "نهى أيمن صبري",
    phoneE164: "+201060000006",
    address: "شبرا الخيمة، القليوبية",
    status: "CANCELLED",
    serviceAr: "كشف جديد",
    priceMinor: 30000,
    time: "15:50",
  },
  {
    id: "p5",
    fullName: "ولاء سيد حسن",
    phoneE164: "+201060000003",
    address: "سموحة، الإسكندرية",
    status: "NO_SHOW",
    serviceAr: "كشف جديد",
    priceMinor: 30000,
    time: "15:30",
  },
  {
    id: "p6",
    fullName: "عمرو حمدي",
    phoneE164: "+201060000000",
    address: "المهندسين، الجيزة",
    status: "CONFIRMED",
    serviceAr: "متابعة ضغط وسكر",
    priceMinor: 18000,
    time: "06:00",
  },
  {
    id: "p7",
    fullName: "محمد سيد إبراهيم",
    phoneE164: "+201060000007",
    address: "شبرا الخيمة، القليوبية",
    status: "BOOKED",
    serviceAr: "تطعيم",
    priceMinor: 12000,
    time: "09:40",
  },
  {
    id: "p8",
    fullName: "رانيا سيد حسن",
    phoneE164: "+201060000004",
    address: "أسيوط",
    status: "ARRIVED",
    serviceAr: "متابعة ضغط وسكر",
    priceMinor: 18000,
    time: "14:30",
  },
];

/** Clinic and staff names, from `apps/api/prisma/seed/blueprint.ts`. */
export const CLINIC_NAME = "عيادة النيل لطب الأسرة";
export const CLINIC_ADDRESS = "12 شارع النصر، المعادي، القاهرة";
export const DOCTOR_NAME = "هشام محمود الديب";
export const DOCTOR_TITLE = "استشاري";
export const DOCTOR_SPECIALTY = "طب الأسرة";
export const DOCTOR_PHONE = "+201005551004";
export const RECEPTIONIST_NAME = "شيماء طارق بدوي";

/** Free-text clinical strings, from `apps/api/prisma/seed/arabic-names.ts`. */
export const COMPLAINTS = [
  "صداع مستمر منذ أسبوع",
  "ألم في المعدة بعد الأكل",
  "متابعة نتائج التحاليل",
  "ألم في الركبة عند المشي",
] as const;

export const DIAGNOSES = [
  "التهاب الجيوب الأنفية",
  "أنيميا نقص الحديد",
  "ارتفاع ضغط الدم — تحت السيطرة",
  "التهاب الشعب الهوائية",
] as const;

export const TREATMENT_PLAN =
  "مضاد حيوي لمدة خمسة أيام مع خافض حرارة عند اللزوم، وراحة وسوائل دافئة، ومتابعة بعد أسبوع.";

export const SERVICE_OPTIONS = [
  { value: "new", label: "كشف جديد — 30 دقيقة" },
  { value: "follow-up", label: "إعادة كشف — 20 دقيقة" },
  { value: "chronic", label: "متابعة ضغط وسكر — 20 دقيقة" },
  { value: "vaccine", label: "تطعيم — 15 دقيقة" },
] as const;

export const CURRENCY = "EGP";
