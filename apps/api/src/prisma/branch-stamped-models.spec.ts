// The registry against the schema: "stamped" must mean a branchId field exists, and "derived" must
// name a stamped parent and carry no branchId of its own. Read from schema.prisma, not restated.
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma } from "../generated/prisma/client.ts";
import { branchPolicyOf } from "./branch-stamped-models.ts";

const schema = readFileSync(path.resolve(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");

function fieldsOf(model: string): string[] {
  const block = new RegExp(`^model ${model} \\{([\\s\\S]*?)^\\}`, "m").exec(schema);
  if (block === null) throw new Error(`model ${model} not found in schema.prisma`);
  return (block[1] ?? "")
    .split("\n")
    .map((line) => /^\s{2}(\w+)\s/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

describe("branch-stamped-models registry", () => {
  const models = Object.values(Prisma.ModelName);

  test("a model is stamped exactly when it has a branchId field", () => {
    const wrong = models.filter((model) => (branchPolicyOf(model) === "stamped") !== fieldsOf(model).includes("branchId"));
    expect(wrong).toEqual([]);
  });

  test("a derived model names a stamped parent", () => {
    for (const model of models) {
      const policy = branchPolicyOf(model);
      if (typeof policy !== "object") continue;
      expect({ model, parent: branchPolicyOf(policy.derivedFrom) }).toEqual({ model, parent: "stamped" });
    }
  });

  test("the six operational tables of the design are stamped, and the patient's file is not", () => {
    for (const model of ["ScheduleTemplate", "ScheduleException", "Appointment", "Visit", "VisitCharge", "Payment"] as const) {
      expect(branchPolicyOf(model)).toBe("stamped");
    }
    for (const model of ["Patient", "PatientAllergy", "Prescription", "Attachment", "PatientCredit"] as const) {
      expect(branchPolicyOf(model)).toBe("clinic-level");
    }
  });
});
