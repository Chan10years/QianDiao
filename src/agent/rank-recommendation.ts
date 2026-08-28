import type { TasteProfile } from "@/src/domain/preferences";
import {
  RecipeCandidateSetSchema,
  type RecipeCandidate,
  type RecipeCandidateSet,
  type RecipeStrategy,
} from "@/src/domain/recipe";
import { validateCandidateSet } from "@/src/agent/validate-candidate-set";

const TASTE_DIMENSIONS = ["sweetness", "acidity", "alcoholIntensity", "body"] as const;
type TasteDimension = (typeof TASTE_DIMENSIONS)[number];

const STRATEGY_TARGETS: Record<RecipeStrategy, TasteProfile> = {
  A_CONSERVATIVE: { sweetness: 3, acidity: 3, alcoholIntensity: 3, body: 3 },
  B_CREATIVE: { sweetness: 4, acidity: 4, alcoholIntensity: 3, body: 4 },
  C_UPGRADE: { sweetness: 3, acidity: 3, alcoholIntensity: 2, body: 2 },
};

const SAFETY_HINT_PENALTIES: Record<RecipeCandidate["safetyLevel"], number> = {
  ALLOW: 0,
  WARN: 20,
  BLOCK: 100,
};

export interface RecommendationScore {
  recipeId: RecipeCandidate["id"];
  tasteDistance: number;
  safetyHintPenalty: number;
  missingIngredientPenalty: number;
  experimentalPenalty: number;
  totalScore: number;
  fitReason: string;
}

export interface RecommendationResult {
  candidateSet: RecipeCandidateSet;
  scores: readonly RecommendationScore[];
}

function calculateTasteDistance(preferences: TasteProfile, strategy: RecipeStrategy): number {
  const target = STRATEGY_TARGETS[strategy];
  return TASTE_DIMENSIONS.reduce(
    (total, dimension: TasteDimension) =>
      total + Math.abs(preferences[dimension] - target[dimension]),
    0,
  );
}

function scoreCandidate(
  preferences: TasteProfile,
  candidate: RecipeCandidate,
): RecommendationScore {
  const tasteDistance = calculateTasteDistance(preferences, candidate.strategy);
  const safetyHintPenalty = SAFETY_HINT_PENALTIES[candidate.safetyLevel];
  const missingIngredientPenalty = candidate.missingIngredients.length * 10;
  const experimentalPenalty = candidate.experimental ? 8 : 0;
  const totalScore =
    tasteDistance + safetyHintPenalty + missingIngredientPenalty + experimentalPenalty;
  const experimentalReason = candidate.experimental ? "实验性方案" : "非实验性方案";

  return {
    recipeId: candidate.id,
    tasteDistance,
    safetyHintPenalty,
    missingIngredientPenalty,
    experimentalPenalty,
    totalScore,
    fitReason: `口味距离 ${tasteDistance}；安全提示 ${candidate.safetyLevel} 扣分 ${safetyHintPenalty}；缺失材料 ${candidate.missingIngredients.length} 项（扣分 ${missingIngredientPenalty}）；${experimentalReason}（扣分 ${experimentalPenalty}）；总分 ${totalScore}。安全字段仅供排序参考，最终 Safety 引擎裁决（由 Task 4/10 的确定性引擎负责）。`,
  };
}

export function rankRecommendation(input: {
  preferences: TasteProfile;
  candidateSet: RecipeCandidateSet;
  allowedMaterialNames?: readonly string[];
}): RecommendationResult {
  const candidateSet = validateCandidateSet(input.candidateSet, {
    allowedMaterialNames: input.allowedMaterialNames,
  });
  const scores = candidateSet.recipes.map((candidate) =>
    scoreCandidate(input.preferences, candidate),
  );
  const strategyOrder: Record<RecipeStrategy, number> = {
    A_CONSERVATIVE: 0,
    B_CREATIVE: 1,
    C_UPGRADE: 2,
  };
  const sortedScores = [...scores].sort(
    (left, right) =>
      left.totalScore - right.totalScore ||
      strategyOrder[
        candidateSet.recipes.find((candidate) => candidate.id === left.recipeId)?.strategy ??
          "C_UPGRADE"
      ] -
        strategyOrder[
          candidateSet.recipes.find((candidate) => candidate.id === right.recipeId)?.strategy ??
            "C_UPGRADE"
        ] ||
      left.recipeId.localeCompare(right.recipeId),
  );
  const scoreById = new Map(scores.map((score) => [score.recipeId, score]));
  const rankedRecipes = candidateSet.recipes.map((candidate) => ({
    ...candidate,
    fitReason: scoreById.get(candidate.id)?.fitReason ?? candidate.fitReason,
  }));
  const rankedCandidateSet = RecipeCandidateSetSchema.parse({
    recipes: rankedRecipes,
    recommendedRecipeId: sortedScores[0].recipeId,
  });

  return {
    candidateSet: rankedCandidateSet,
    scores,
  };
}
