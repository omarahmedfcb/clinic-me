import { Module } from "@nestjs/common";
import { ThrottlingModule } from "../../common/throttling.module.ts";
import { WRITE_THROTTLERS } from "../../common/write-throttle.ts";
import { BillingController } from "./billing.controller.ts";
import { BillingActionsController } from "./billing-actions.controller.ts";

@Module({
  imports: [ThrottlingModule],
  controllers: [BillingController, BillingActionsController] })
export class BillingModule {}
