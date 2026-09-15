// Request shape for a draft autosave. Clinical free text is never normalised or trimmed here.
// `expectedRevision` is required, not optional: an absent value would silently mean last-write-wins.

import { Type } from "class-transformer";
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  registerDecorator,
} from "class-validator";

/** Every value in the object is a finite number. `@IsObject` alone would accept any shape. */
function NumericValues() {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: "numericValues",
      target: object.constructor,
      propertyName,
      validator: {
        validate: (value: unknown) =>
          typeof value === "object" &&
          value !== null &&
          Object.values(value).every((v) => typeof v === "number" && Number.isFinite(v)),
        defaultMessage: () => "vitals must map each measurement to a finite number",
      },
    });
  };
}

const FIELD_MAX = 20_000;

export class SaveVisitDraftDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @IsOptional() @IsString() @MaxLength(FIELD_MAX) complaint?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) medicalHistory?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) examination?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) diagnosis?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) treatmentPlan?: string;
  @IsOptional() @IsString() @MaxLength(FIELD_MAX) doctorNotes?: string;

  /**
   * Measurements, numbers only. `whitelist` cannot police the inside of a plain object, so the
   * values are checked here — a string reaching the Json column would be stored and then compared
   * against a number on the next visit's trend.
   */
  @IsOptional()
  @IsObject()
  @NumericValues()
  vitals?: Record<string, number>;
}
