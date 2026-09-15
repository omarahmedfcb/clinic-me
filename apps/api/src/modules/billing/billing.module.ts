import { Module } from "@nestjs/common";
import { BillingController } from "./billing.controller.ts";
import { BillingActionsController } from "./billing-actions.controller.ts";

@Module({ controllers: [BillingController, BillingActionsController] })
export class BillingModule {}
