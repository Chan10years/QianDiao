import { describe, expect, it } from "vitest";

import { SAFETY_RULES } from "@/src/safety/rules/catalog";

describe("safety rule catalog", () => {
  it("contains unique versioned rules with evidence", () => {
    const ids = SAFETY_RULES.map((rule) => rule.ruleId);

    expect(new Set(ids).size).toBe(ids.length);
    for (const rule of SAFETY_RULES) {
      expect(rule.ruleVersion).toEqual(expect.any(Number));
      expect(Number.isInteger(rule.ruleVersion)).toBe(true);
      expect(rule.ruleVersion).toBeGreaterThan(0);
      expect(rule.evidence.length).toBeGreaterThan(0);
      if (rule.severity === "BLOCK") {
        expect(rule.alternative).toBeTruthy();
      }
    }
  });
});
