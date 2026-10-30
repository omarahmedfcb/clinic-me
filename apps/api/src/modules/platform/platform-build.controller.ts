// Which commit this server runs, for the operator console only. Never on the public /health: a public
// build identifier tells anyone outside which version to look up against known vulnerabilities.
import { Controller, Get, UseGuards } from "@nestjs/common";
import { deployedCommit } from "../../config/deployed-commit.ts";
import { PlatformAuthGuard } from "./platform.guard.ts";

@Controller("platform/build")
export class PlatformBuildController {
  @Get()
  @UseGuards(PlatformAuthGuard)
  build(): { commit: string | null } {
    return { commit: deployedCommit() };
  }
}
