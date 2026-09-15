import { Module } from "@nestjs/common";
import { InsuranceController } from "./insurance.controller.ts";
import { InsuranceCompaniesController } from "./insurance-companies.controller.ts";

@Module({ controllers: [InsuranceController, InsuranceCompaniesController] })
export class InsuranceModule {}
