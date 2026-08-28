import { describe, expect, it } from "vitest";

import { createRecipeId } from "@/src/domain/id";
import {
  RecipeCandidateSchema,
  RecipeCandidateSetSchema,
  type RecipeCandidate,
} from "@/src/domain/recipe";
import { rankRecommendation } from "@/src/agent/rank-recommendation";

function candidate(
  strategy: RecipeCandidate["strategy"],
  overrides: Partial<RecipeCandidate> = {},
): RecipeCandidate {
  return RecipeCandidateSchema.parse({
    id: createRecipeId(),
    strategy,
    title: `${strategy} 推荐测试`,
    fitReason: "原始模型理由",
    differenceReason: `${strategy} 的差异说明`,
    materials: [{ name: "白酒", amountMl: 30, unit: "ml" }],
    steps: [{ order: 1, instruction: `${strategy} 的调制步骤`, isPhotoCheckpoint: false }],
    estimatedAbv: 42,
    safetyLevel: "ALLOW",
    experimental: false,
    missingIngredients: [],
    ...overrides,
  });
}

describe("rankRecommendation", () => {
  it("returns transparent score components and fit reasons for every candidate", () => {
    const recipes = [
      candidate("A_CONSERVATIVE"),
      candidate("B_CREATIVE", { safetyLevel: "WARN" }),
      candidate("C_UPGRADE", {
        safetyLevel: "BLOCK",
        experimental: true,
        missingIngredients: ["茶", "蜂蜜"],
      }),
    ];
    const input = {
      preferences: {
        sweetness: 3 as const,
        acidity: 3 as const,
        alcoholIntensity: 3 as const,
        body: 3 as const,
      },
      candidateSet: RecipeCandidateSetSchema.parse({
        recipes,
        recommendedRecipeId: recipes[2].id,
      }),
    };

    const result = rankRecommendation(input);

    expect(result.scores).toHaveLength(3);
    for (const score of result.scores) {
      expect(score).toMatchObject({
        recipeId: expect.any(String),
        tasteDistance: expect.any(Number),
        safetyHintPenalty: expect.any(Number),
        missingIngredientPenalty: expect.any(Number),
        experimentalPenalty: expect.any(Number),
        totalScore: expect.any(Number),
      });
      expect(score.fitReason).toContain("口味距离");
      expect(score.fitReason).toContain("安全提示");
      expect(score.fitReason).toContain("最终 Safety 引擎裁决");
    }
    expect(
      result.candidateSet.recipes.every((recipe) => recipe.fitReason.includes("缺失材料")),
    ).toBe(true);
    expect(result.candidateSet.recipes.map((recipe) => recipe.id)).toContain(
      result.candidateSet.recommendedRecipeId,
    );
  });

  it("prefers lower transparent risk penalties when taste distance ties", () => {
    const conservative = candidate("A_CONSERVATIVE");
    const creative = candidate("B_CREATIVE", {
      safetyLevel: "WARN",
    });

    const result = rankRecommendation({
      preferences: {
        sweetness: 3,
        acidity: 3,
        alcoholIntensity: 3,
        body: 3,
      },
      candidateSet: RecipeCandidateSetSchema.parse({
        recipes: [
          conservative,
          creative,
          candidate("C_UPGRADE", { materials: [{ name: "白酒", amountMl: 45, unit: "ml" }] }),
        ],
        recommendedRecipeId: creative.id,
      }),
    });

    expect(result.candidateSet.recommendedRecipeId).toBe(conservative.id);
    expect(
      result.scores.find((score) => score.recipeId === creative.id)?.totalScore,
    ).toBeGreaterThan(
      result.scores.find((score) => score.recipeId === conservative.id)?.totalScore ?? 0,
    );
  });
});
