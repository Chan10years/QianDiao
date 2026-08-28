import { describe, expect, it } from "vitest";

import { SafetyLevelSchema } from "@/src/domain/safety";

describe("SafetyLevelSchema", () => {
  it("accepts the three safety outcomes", () => {
    expect(SafetyLevelSchema.parse("ALLOW")).toBe("ALLOW");
    expect(SafetyLevelSchema.parse("WARN")).toBe("WARN");
    expect(SafetyLevelSchema.parse("BLOCK")).toBe("BLOCK");
  });

  it("rejects an unknown safety outcome", () => {
    expect(() => SafetyLevelSchema.parse("REVIEW")).toThrow();
  });

  it("rejects empty and non-string safety outcomes", () => {
    expect(() => SafetyLevelSchema.parse("")).toThrow();
    expect(() => SafetyLevelSchema.parse(null)).toThrow();
  });
});
