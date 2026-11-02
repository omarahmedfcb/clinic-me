import { Module } from "@nestjs/common";
import { BranchLimitController } from "./branch-limit.controller.ts";
import { BranchRequestsController } from "./branch-requests.controller.ts";
import { ExceptionReviewController } from "./exception-review.controller.ts";

@Module({ controllers: [BranchRequestsController, BranchLimitController, ExceptionReviewController] })
export class BranchesModule {}
