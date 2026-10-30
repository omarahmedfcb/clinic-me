// Where each model's branch comes from: its own branch_id, its parent's, the clinic, or no clinic at all
// (docs/BRANCHES-DESIGN.md §1.5). A new model does not compile until it is classified.
import type { Prisma } from "../generated/prisma/client.ts";

export type BranchPolicy = "stamped" | { derivedFrom: Prisma.ModelName } | "clinic-level" | "not-clinic";

const BRANCH_POLICY = {
  ScheduleTemplate: "stamped",
  ScheduleException: "stamped",
  Appointment: "stamped",
  Visit: "stamped",
  VisitCharge: "stamped",
  Payment: "stamped",
  MembershipBranch: "stamped",
  AuditLog: "stamped",

  ScheduleBreak: { derivedFrom: "ScheduleTemplate" },
  AppointmentEvent: { derivedFrom: "Appointment" },
  VisitRevision: { derivedFrom: "Visit" },
  VisitProcedure: { derivedFrom: "Visit" },
  VisitInvestigation: { derivedFrom: "Visit" },
  VisitChargeLine: { derivedFrom: "VisitCharge" },
  PaymentAdjustment: { derivedFrom: "Payment" },

  Branch: "clinic-level",
  BranchRequest: "clinic-level",
  Membership: "clinic-level",
  Doctor: "clinic-level",
  Service: "clinic-level",
  ChargeableMaterial: "clinic-level",
  InsuranceCompany: "clinic-level",
  Contact: "clinic-level",
  Patient: "clinic-level",
  PatientAllergy: "clinic-level",
  PatientClinicalProfileEntry: "clinic-level",
  PatientRelation: "clinic-level",
  PatientInsurance: "clinic-level",
  InsurancePolicy: "clinic-level",
  PatientTransfer: "clinic-level",
  PatientCredit: "clinic-level",
  Prescription: "clinic-level",
  PrescriptionItem: "clinic-level",
  PrescriptionAccessToken: "clinic-level",
  Attachment: "clinic-level",
  Consent: "clinic-level",
  TreatmentPlan: "clinic-level",
  TreatmentPlanSession: "clinic-level",
  AccessGrant: "clinic-level",
  Notification: "clinic-level",
  NotificationRead: "clinic-level",
  Conversation: "clinic-level",
  Message: "clinic-level",
  Complaint: "clinic-level",
  FollowupTask: "clinic-level",
  BotCredential: "clinic-level",
  WhatsAppConnection: "clinic-level",
  WebhookDelivery: "clinic-level",
  OutboundMessageIntent: "clinic-level",
  VisitDocumentLink: "clinic-level",
  Subscription: "clinic-level",
  UsageRecord: "clinic-level",
  UsageAlert: "clinic-level",
  Invoice: "clinic-level",
  MessageTemplate: "clinic-level",

  Tenant: "not-clinic",
  User: "not-clinic",
  RefreshToken: "not-clinic",
  OperatorRecoveryCode: "not-clinic",
  PlatformClinicFile: "not-clinic",
  PlatformClinicContact: "not-clinic",
  PlatformClinicContract: "not-clinic",
} satisfies Record<Prisma.ModelName, BranchPolicy>;

export function branchPolicyOf(model: Prisma.ModelName): BranchPolicy {
  return BRANCH_POLICY[model];
}
