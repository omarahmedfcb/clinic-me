import { Module } from "@nestjs/common";
import { ThrottlingModule } from "./common/throttling.module.ts";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { ActorContextInterceptor } from "./common/actor-context.interceptor.ts";
import { MembershipFreshnessInterceptor } from "./common/membership-freshness.interceptor.ts";
import { PasswordChangeInterceptor } from "./common/password-change.interceptor.ts";
import { AuditModule } from "./modules/audit/audit.module.ts";
import { AuthModule } from "./modules/auth/auth.module.ts";
import { BillingModule } from "./modules/billing/billing.module.ts";
import { HealthModule } from "./modules/health/health.module.ts";
import { AppointmentsModule } from "./modules/appointments/appointments.module.ts";
import { BotModule } from "./modules/bot/bot.module.ts";
import { AttachmentsModule } from "./modules/attachments/attachments.module.ts";
import { ClinicIdentityModule } from "./modules/clinic-identity/clinic-identity.module.ts";
import { DoctorsModule } from "./modules/doctors/doctors.module.ts";
import { NotificationsModule } from "./modules/notifications/notifications.module.ts";
import { SchedulesModule } from "./modules/schedules/schedules.module.ts";
import { ServicesModule } from "./modules/services/services.module.ts";
import { MembershipsModule } from "./modules/memberships/memberships.module.ts";
import { PatientsModule } from "./modules/patients/patients.module.ts";
import { PlatformModule } from "./modules/platform/platform.module.ts";
import { ClinicalModule } from "./modules/clinical/clinical.module.ts";
import { QueueModule } from "./modules/queue/queue.module.ts";
import { TransfersModule } from "./modules/transfers/transfers.module.ts";
import { InsuranceModule } from "./modules/insurance/insurance.module.ts";
import { WebchatModule } from "./modules/webchat/webchat.module.ts";
import { PrismaModule } from "./prisma/prisma.module.ts";

/**
 * ActorContextInterceptor is registered globally, not per-route.
 *
 * It binds the actor every tenant-scoped write needs (SCHEMA-DECISIONS.md D16), and the failure
 * mode of registering it per-route is that the route which forgot it fails at the database with an
 * opaque "Audit: refusing to write ... with no actor bound" -- correct, but a long way from the
 * missing decorator. Global means a new controller cannot forget. It is a no-op on routes with no
 * authenticated claims, so /health and /auth/login pass straight through.
 */
@Module({
  imports: [
    // Every named throttler, once — see common/throttling.module.ts for why it is a wrapper.
    ThrottlingModule,
    
    PrismaModule,
    BillingModule,
    HealthModule,
    AuthModule,
    PatientsModule,
    MembershipsModule,
    DoctorsModule,
    ServicesModule,
    SchedulesModule,
    AppointmentsModule,
    BotModule,
    QueueModule,
    TransfersModule,
    InsuranceModule,
    ClinicalModule,
    AttachmentsModule,
    ClinicIdentityModule,
    NotificationsModule,
    AuditModule,
    PlatformModule,
    WebchatModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },
    // PR 10. After the guards, so it sees an authenticated request — see the class for why a
    // global guard could not have worked.
    { provide: APP_INTERCEPTOR, useClass: PasswordChangeInterceptor },
    // 2026-09-13. Before the password check would be equally correct; what matters is that it runs
    // on every authenticated request, so a changed role or a suspension takes effect at once.
    { provide: APP_INTERCEPTOR, useClass: MembershipFreshnessInterceptor },
  ],
})
export class AppModule {}
