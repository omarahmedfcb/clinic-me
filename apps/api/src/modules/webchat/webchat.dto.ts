import { IsOptional, IsString, IsUUID, Length } from "class-validator";

export class WebchatMessageDto {
  /** Absent on the first message of a conversation; the response then carries a new one. */
  @IsOptional()
  @IsUUID()
  sessionId?: string;

  @IsString()
  @Length(1, 2000)
  message!: string;
}
