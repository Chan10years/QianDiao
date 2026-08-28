import { describe, expect, it } from "vitest";

import { createRecipeId } from "@/src/domain/id";
import {
  RecipeCandidateSchema,
  RecipeCandidateSetSchema,
  type RecipeCandidate,
} from "@/src/domain/recipe";
import { validateCandidateSet } from "@/src/agent/validate-candidate-set";

function candidate(
  strategy: RecipeCandidate["strategy"],
  overrides: Partial<RecipeCandidate> = {},
): RecipeCandidate {
  return RecipeCandidateSchema.parse({
    id: createRecipeId(),
    strategy,
    title: `${strategy} 测试方案`,
    fitReason: "适合当前口味",
    differenceReason: "通过比例变化形成可解释差异",
    materials: [
      { name: "白酒", amountMl: 30, unit: "ml" },
      { name: "苏打水", amountMl: 90, unit: "ml" },
    ],
    steps: [{ order: 1, instruction: "加入材料并轻轻搅拌。", isPhotoCheckpoint: false }],
    estimatedAbv: 10,
    safetyLevel: "ALLOW",
    experimental: false,
    missingIngredients: [],
    ...overrides,
  });
}

function candidateSet(
  overrides: Partial<Record<RecipeCandidate["strategy"], Partial<RecipeCandidate>>> = {},
) {
  const recipes = [
    candidate("A_CONSERVATIVE", overrides.A_CONSERVATIVE),
    candidate("B_CREATIVE", overrides.B_CREATIVE),
    candidate("C_UPGRADE", {
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 80, unit: "ml" },
        { name: "柠檬", amountMl: 10, unit: "ml" },
      ],
      missingIngredients: ["柠檬"],
      steps: [{ order: 1, instruction: "加入柠檬后轻轻搅拌。", isPhotoCheckpoint: false }],
      ...overrides.C_UPGRADE,
    }),
  ];

  return RecipeCandidateSetSchema.parse({ recipes, recommendedRecipeId: recipes[0].id });
}

describe("validateCandidateSet", () => {
  it("rejects candidates whose same materials and steps differ only by 1 ml", () => {
    const set = candidateSet({
      B_CREATIVE: {
        materials: [
          { name: "白酒", amountMl: 31, unit: "ml" },
          { name: "苏打水", amountMl: 90, unit: "ml" },
        ],
      },
    });

    expect(() => validateCandidateSet(set)).toThrow(/DUPLICATE/);
  });

  it("accepts a meaningful ratio change with a reason", () => {
    const set = candidateSet({
      B_CREATIVE: {
        materials: [
          { name: "白酒", amountMl: 40, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
        ],
        differenceReason: "提高酒液比例，强化酒香并保持苏打水的收口。",
      },
    });

    expect(validateCandidateSet(set)).toEqual(set);
  });

  it("rejects more than two missing ingredients for the upgrade strategy", () => {
    const validSet = candidateSet();
    const set = {
      ...validSet,
      recipes: validSet.recipes.map((recipe) =>
        recipe.strategy === "C_UPGRADE"
          ? { ...recipe, missingIngredients: ["冰块", "柠檬", "苏打水"] }
          : recipe,
      ),
    };

    expect(() => validateCandidateSet(set)).toThrow();
  });

  it("rejects an upgrade ingredient outside the frozen allowlist", () => {
    const set = candidateSet({
      C_UPGRADE: {
        missingIngredients: ["咖啡"],
      },
    });

    expect(() => validateCandidateSet(set)).toThrow(/allowlist/);
  });

  it("rejects an unallowlisted material on C even when missingIngredients is empty", () => {
    const set = candidateSet({
      B_CREATIVE: {
        materials: [
          { name: "白酒", amountMl: 40, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
        ],
      },
      C_UPGRADE: {
        materials: [
          { name: "白酒", amountMl: 30, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
          { name: "咖啡", amountMl: 20, unit: "ml" },
        ],
        missingIngredients: [],
      },
    });

    expect(() => validateCandidateSet(set)).toThrow(/C_UPGRADE materials/);
  });

  it("rejects A and B materials outside the confirmed material names", () => {
    const set = candidateSet({
      A_CONSERVATIVE: {
        materials: [
          { name: "咖啡", amountMl: 30, unit: "ml" },
          { name: "苏打水", amountMl: 90, unit: "ml" },
        ],
      },
      B_CREATIVE: {
        materials: [
          { name: "白酒", amountMl: 40, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
        ],
      },
    });

    expect(() => validateCandidateSet(set, { allowedMaterialNames: ["白酒", "苏打水"] })).toThrow(
      /A_CONSERVATIVE materials/,
    );
  });

  it("rejects C when actual materials add more than two controlled names", () => {
    const set = candidateSet({
      B_CREATIVE: {
        materials: [
          { name: "白酒", amountMl: 40, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
        ],
      },
      C_UPGRADE: {
        materials: [
          { name: "白酒", amountMl: 30, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
          { name: "冰块", amountMl: 60, unit: "ml" },
          { name: "柠檬", amountMl: 10, unit: "ml" },
          { name: "蜂蜜", amountMl: 5, unit: "ml" },
        ],
        missingIngredients: [],
        steps: [
          { order: 1, instruction: "加入三种升级材料后轻轻搅拌。", isPhotoCheckpoint: false },
        ],
      },
    });

    expect(() => validateCandidateSet(set, { allowedMaterialNames: ["白酒", "苏打水"] })).toThrow(
      /at most two/,
    );
  });

  it("counts duplicate C material names once when enforcing the added-material limit", () => {
    const set = candidateSet({
      B_CREATIVE: {
        materials: [
          { name: "白酒", amountMl: 40, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
        ],
      },
      C_UPGRADE: {
        materials: [
          { name: "白酒", amountMl: 30, unit: "ml" },
          { name: "苏打水", amountMl: 80, unit: "ml" },
          { name: "柠檬", amountMl: 10, unit: "ml" },
          { name: "柠檬", amountMl: 5, unit: "ml" },
        ],
        missingIngredients: [],
      },
    });

    expect(validateCandidateSet(set, { allowedMaterialNames: ["白酒", "苏打水"] })).toEqual(set);
  });

  it("rejects missing ingredients on conservative and creative strategies", () => {
    const set = candidateSet({
      A_CONSERVATIVE: { missingIngredients: ["冰块"] },
    });

    expect(() => validateCandidateSet(set)).toThrow();
  });
});
