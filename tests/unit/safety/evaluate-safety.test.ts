import { describe, expect, it } from "vitest";

import { evaluateSafety } from "@/src/safety/evaluate-safety";
import type { SafetyIngredient, SafetyInput } from "@/src/safety/types";

function ingredient(overrides: Partial<SafetyIngredient> = {}): SafetyIngredient {
  return {
    name: "白酒",
    category: "spirit",
    volumeMl: 30,
    abv: 42,
    confirmed: true,
    ...overrides,
  };
}

function input(ingredients: SafetyIngredient[]): SafetyInput {
  return { ingredients, totalDrinkMl: ingredients.reduce((sum, item) => sum + item.volumeMl, 0) };
}

describe("evaluateSafety", () => {
  it("blocks alcohol combined with an energy drink", () => {
    const result = evaluateSafety(
      input([
        ingredient(),
        ingredient({ name: "能量饮料", category: "energy_drink", volumeMl: 100, abv: null }),
      ]),
    );

    expect(result.level).toBe("BLOCK");
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "SAFETY_ALCOHOL_ENERGY",
          ruleVersion: 1,
          level: "BLOCK",
        }),
      ]),
    );
  });

  it.each([
    { name: "药物", category: "medicine" as const },
    { name: "清洁剂", category: "non_food" as const },
    { name: "未知化学品", category: "unknown" as const },
  ])("blocks %s", ({ name, category }) => {
    const result = evaluateSafety(input([ingredient({ name, category, abv: null })]));

    expect(result.level).toBe("BLOCK");
    expect(result.hits[0]).toMatchObject({ level: "BLOCK" });
    expect(result.hits[0].alternative).toBeTruthy();
  });

  it("blocks a spirit whose ABV is not confirmed", () => {
    const result = evaluateSafety(input([ingredient({ abv: null, confirmed: false })]));

    expect(result).toMatchObject({
      level: "BLOCK",
      estimatedFinalAbv: null,
      pureAlcoholMl: null,
    });
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "SAFETY_UNKNOWN_ABV", level: "BLOCK" }),
      ]),
    );
  });

  it("blocks a spirit whose confirmation is missing", () => {
    const result = evaluateSafety(
      input([
        {
          name: "白酒",
          category: "spirit",
          volumeMl: 30,
          abv: 42,
        },
      ]),
    );

    expect(result).toMatchObject({
      level: "BLOCK",
      estimatedFinalAbv: null,
      pureAlcoholMl: null,
    });
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "SAFETY_UNKNOWN_ABV", level: "BLOCK" }),
      ]),
    );
  });

  it("warns when a confirmed ingredient is marked as an allergen", () => {
    const result = evaluateSafety(input([ingredient({ allergen: true })]));

    expect(result.level).toBe("WARN");
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "SAFETY_ALLERGEN", level: "WARN" }),
      ]),
    );
  });

  it("warns and marks an unusual food combination as experimental", () => {
    const result = evaluateSafety({
      ...input([
        ingredient(),
        ingredient({ name: "榴莲", category: "fruit", volumeMl: 20, abv: null }),
      ]),
      experimental: true,
    });

    expect(result.level).toBe("WARN");
    expect(result.hits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: "SAFETY_EXPERIMENTAL", level: "WARN" }),
      ]),
    );
  });

  it("allows an ordinary known combination", () => {
    const result = evaluateSafety(
      input([
        ingredient(),
        ingredient({ name: "苏打水", category: "mixer", volumeMl: 100, abv: null }),
      ]),
    );

    expect(result).toMatchObject({ level: "ALLOW", pureAlcoholMl: 12.6 });
    expect(result.hits).toEqual([]);
  });

  it("recomputes safety instead of trusting a candidate safety level", () => {
    const safeResult = evaluateSafety({
      ...input([ingredient(), ingredient({ name: "苏打水", category: "mixer", abv: null })]),
      safetyLevel: "BLOCK",
    });
    const blockedResult = evaluateSafety({
      ...input([
        ingredient(),
        ingredient({ name: "能量饮料", category: "energy_drink", volumeMl: 100, abv: null }),
      ]),
      safetyLevel: "ALLOW",
    });

    expect(safeResult.level).toBe("ALLOW");
    expect(blockedResult.level).toBe("BLOCK");
  });

  it("keeps hit ordering deterministic with BLOCK ahead of WARN", () => {
    const safetyInput = {
      ...input([
        ingredient({ abv: null, confirmed: false, allergen: true }),
        ingredient({ name: "能量饮料", category: "energy_drink", volumeMl: 100, abv: null }),
      ]),
      experimental: true,
    };

    const first = evaluateSafety(safetyInput);
    const second = evaluateSafety(safetyInput);

    expect(first).toEqual(second);
    expect(first.level).toBe("BLOCK");
    expect(first.hits.map((hit) => hit.level)).toEqual(["BLOCK", "BLOCK", "WARN", "WARN"]);
  });
});
