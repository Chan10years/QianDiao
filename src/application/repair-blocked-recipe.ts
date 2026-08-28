import type { DetectedIngredient, IngredientCategory } from "@/src/domain/ingredient";
import { RecipeCandidateSchema, type RecipeCandidate } from "@/src/domain/recipe";
import {
  isOutcomeAwareRecipeProvider,
  type RecipeProvider,
  type RecipeProvenanceStage,
  type RecipeSourceMode,
} from "@/src/providers/recipe-provider";
import { IdempotencyLeaseLostError } from "@/src/repositories/idempotency-reservation-repository";
import {
  SessionMutationLeaseLostError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";
import { VersionConflictError } from "@/src/application/save-preferences";
import type { SafetyDecision, SafetyInput } from "@/src/safety/types";
import {
  validateAdjustedCandidate,
  validateCandidateSet,
} from "@/src/agent/validate-candidate-set";
import type { AdjustmentConstraints } from "@/src/agent/build-adjustment-constraints";

const EXTRA_INGREDIENT_CATEGORIES: Record<string, IngredientCategory> = {
  冰块: "ice",
  柠檬: "fruit",
  青柠: "fruit",
  苏打水: "mixer",
  可乐: "mixer",
  柠檬汽水: "mixer",
  茶: "tea",
  果汁: "fruit",
  糖浆: "sweetener",
  蜂蜜: "sweetener",
  薄荷: "herb",
  能量饮料: "energy_drink",
};

export interface EvaluatedRecipeCandidate {
  candidate: RecipeCandidate;
  safetyDecision: SafetyDecision;
}

export interface RepairBlockedRecipeInput {
  preferences: {
    sweetness: 1 | 2 | 3 | 4 | 5;
    acidity: 1 | 2 | 3 | 4 | 5;
    alcoholIntensity: 1 | 2 | 3 | 4 | 5;
    body: 1 | 2 | 3 | 4 | 5;
  };
  candidate: RecipeCandidate;
  confirmedIngredients: readonly DetectedIngredient[];
  confirmedMaterialNames: readonly string[];
  primaryProvider: RecipeProvider;
  fallbackProvider: RecipeProvider;
  primarySourceMode?: RecipeSourceMode;
  experimentMemories?: readonly {
    recipeId: string;
    feedbackId: string;
    summary: string;
    tags: readonly string[];
  }[];
  evaluateSafety: (input: SafetyInput) => SafetyDecision;
  initialEvaluation: EvaluatedRecipeCandidate;
  constraints?: AdjustmentConstraints;
  beforeExternalCall?: (kind: "adjust" | "fallback-generate") => Promise<void>;
}

export interface RepairBlockedRecipeResult extends EvaluatedRecipeCandidate {
  repaired: boolean;
  repairAttempts: number;
  fallbackUsed: boolean;
  sourceMode: RecipeSourceMode;
  degraded: boolean;
  provenanceStages: readonly RecipeProvenanceStage[];
}

export class BlockedRecipeFallbackExhaustedError extends Error {
  readonly code = "BLOCKED_RECIPE_FALLBACK_EXHAUSTED";

  constructor(message = "BLOCKED_RECIPE_FALLBACK_EXHAUSTED") {
    super(message);
    this.name = "BlockedRecipeFallbackExhaustedError";
  }
}

export class SafetyEvaluationFailedError extends Error {
  readonly code = "SAFETY_EVALUATION_FAILED";

  constructor() {
    super("SAFETY_EVALUATION_FAILED");
    this.name = "SafetyEvaluationFailedError";
  }
}

function shouldRethrowRepairError(error: unknown): boolean {
  return (
    error instanceof IdempotencyLeaseLostError ||
    error instanceof SessionMutationLeaseLostError ||
    error instanceof SessionVersionConflictError ||
    error instanceof VersionConflictError
  );
}

function inferCategory(
  materialName: string,
  confirmedIngredients: readonly DetectedIngredient[],
): IngredientCategory {
  const matchedConfirmed = confirmedIngredients.find(
    (ingredient) => ingredient.canonicalName === materialName,
  );
  if (matchedConfirmed !== undefined) {
    return matchedConfirmed.category;
  }

  return EXTRA_INGREDIENT_CATEGORIES[materialName] ?? "unknown";
}

function inferAbv(
  materialName: string,
  confirmedIngredients: readonly DetectedIngredient[],
): number | null {
  return (
    confirmedIngredients.find((ingredient) => ingredient.canonicalName === materialName)?.abv ??
    null
  );
}

function toRecipeProviderIngredient(ingredient: DetectedIngredient): DetectedIngredient {
  return {
    rawName: ingredient.rawName,
    canonicalName: ingredient.canonicalName,
    category: ingredient.category,
    brand: ingredient.brand,
    abv: ingredient.abv,
    confidence: ingredient.confidence,
    confirmed: ingredient.confirmed,
  };
}

export function evaluateRecipeCandidateSafety(
  candidate: RecipeCandidate,
  confirmedIngredients: readonly DetectedIngredient[],
  evaluateSafety: (input: SafetyInput) => SafetyDecision,
): EvaluatedRecipeCandidate {
  const safetyDecision = evaluateSafety({
    experimental: candidate.experimental,
    ingredients: candidate.materials.map((material) => ({
      name: material.name,
      canonicalName: material.name,
      category: inferCategory(material.name, confirmedIngredients),
      volumeMl: material.amountMl,
      abv: inferAbv(material.name, confirmedIngredients),
      confirmed: confirmedIngredients.some(
        (ingredient) => ingredient.canonicalName === material.name && ingredient.confirmed,
      ),
      experimental: candidate.experimental,
    })),
  });

  return {
    candidate: RecipeCandidateSchema.parse({
      ...candidate,
      estimatedAbv: safetyDecision.estimatedFinalAbv,
      safetyLevel: safetyDecision.level,
    }),
    safetyDecision,
  };
}

function buildRepairFeedback(blockReasons: readonly string[]) {
  return {
    rating: 2,
    accepted: false,
    deltas: {
      sweetness: 0,
      acidity: 0,
      alcoholIntensity: -2,
      body: -1,
    },
    notes: `确定性 Safety 阻止了该方案：${blockReasons.join("；")}。请保持原策略，但移除或替换被阻止的材料。`,
    finalImageId: null,
  } as const;
}

function pickFallbackReplacement(
  candidate: RecipeCandidate,
  fallbackSet: unknown,
  confirmedMaterialNames: readonly string[],
): RecipeCandidate {
  const validated = validateCandidateSet(fallbackSet, {
    allowedMaterialNames: confirmedMaterialNames,
  });
  const replacement = validated.recipes.find((item) => item.strategy === candidate.strategy);
  if (replacement === undefined) {
    throw new Error(`FALLBACK_RECIPE_MISSING:${candidate.strategy}`);
  }
  return replacement;
}

export async function repairBlockedRecipe(
  input: RepairBlockedRecipeInput,
): Promise<RepairBlockedRecipeResult> {
  let current = input.initialEvaluation;
  const provenanceStages: RecipeProvenanceStage[] = [];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let adjustedCandidate: unknown;
    let sourceMode = input.primarySourceMode ?? "qwen";
    let degraded = false;
    try {
      await input.beforeExternalCall?.("adjust");
      if (isOutcomeAwareRecipeProvider(input.primaryProvider)) {
        const outcome = await input.primaryProvider.adjustWithOutcome(
          {
            preferences: input.preferences,
            currentRecipe: current.candidate,
            confirmedMaterialNames: [...input.confirmedMaterialNames],
            feedback: buildRepairFeedback(current.safetyDecision.hits.map((hit) => hit.reason)),
            experimentMemories: input.experimentMemories?.map((memory) => ({
              ...memory,
              tags: [...memory.tags],
            })),
            constraints: input.constraints,
          },
          { beforeExternalCall: () => input.beforeExternalCall?.("adjust") ?? Promise.resolve() },
        );
        adjustedCandidate = outcome.value;
        sourceMode = outcome.sourceMode;
        degraded = outcome.degraded;
        provenanceStages.push(
          ...(
            outcome.provenanceStages ?? [
              {
                phase: "repair" as const,
                attempt,
                strategy: current.candidate.strategy,
                sourceMode,
                degraded,
                outcome:
                  sourceMode === "fallback" && degraded
                    ? ("fallback" as const)
                    : ("accepted" as const),
              },
            ]
          ).map((stage) => ({
            ...stage,
            strategy: stage.strategy ?? current.candidate.strategy,
          })),
        );
      } else {
        adjustedCandidate = await input.primaryProvider.adjust({
          preferences: input.preferences,
          currentRecipe: current.candidate,
          confirmedMaterialNames: [...input.confirmedMaterialNames],
          feedback: buildRepairFeedback(current.safetyDecision.hits.map((hit) => hit.reason)),
          experimentMemories: input.experimentMemories?.map((memory) => ({
            ...memory,
            tags: [...memory.tags],
          })),
          constraints: input.constraints,
        });
        provenanceStages.push({
          phase: "repair",
          attempt,
          strategy: current.candidate.strategy,
          sourceMode,
          degraded,
          outcome: "accepted",
        });
      }
    } catch (error) {
      if (shouldRethrowRepairError(error)) {
        throw error;
      }
      break;
    }

    let adjusted: RecipeCandidate;
    try {
      adjusted = validateAdjustedCandidate(adjustedCandidate, current.candidate, [
        ...input.confirmedMaterialNames,
      ]);
    } catch {
      break;
    }

    try {
      current = evaluateRecipeCandidateSafety(
        adjusted,
        input.confirmedIngredients,
        input.evaluateSafety,
      );
    } catch {
      throw new SafetyEvaluationFailedError();
    }

    if (current.safetyDecision.level !== "BLOCK") {
      const finalSourceMode = provenanceStages.some((stage) => stage.sourceMode === "fallback")
        ? "fallback"
        : "qwen";
      return {
        ...current,
        repaired: true,
        repairAttempts: attempt,
        fallbackUsed: false,
        sourceMode: finalSourceMode,
        degraded: provenanceStages.some((stage) => stage.degraded),
        provenanceStages,
      };
    }
  }

  await input.beforeExternalCall?.("fallback-generate");
  let fallbackSet: unknown;
  try {
    fallbackSet = await input.fallbackProvider.generate({
      preferences: input.preferences,
      ingredients: input.confirmedIngredients.map(toRecipeProviderIngredient),
    });
  } catch (error) {
    if (shouldRethrowRepairError(error)) {
      throw error;
    }
    throw new BlockedRecipeFallbackExhaustedError();
  }

  let replacement: RecipeCandidate;
  try {
    replacement = pickFallbackReplacement(
      current.candidate,
      fallbackSet,
      input.confirmedMaterialNames,
    );
  } catch (error) {
    if (shouldRethrowRepairError(error)) {
      throw error;
    }
    throw new BlockedRecipeFallbackExhaustedError();
  }
  let evaluatedReplacement: EvaluatedRecipeCandidate;
  try {
    evaluatedReplacement = evaluateRecipeCandidateSafety(
      replacement,
      input.confirmedIngredients,
      input.evaluateSafety,
    );
  } catch {
    throw new SafetyEvaluationFailedError();
  }

  if (evaluatedReplacement.safetyDecision.level === "BLOCK") {
    throw new BlockedRecipeFallbackExhaustedError("FALLBACK_REPLACEMENT_BLOCKED");
  }

  return {
    ...evaluatedReplacement,
    repaired: false,
    repairAttempts: 2,
    fallbackUsed: true,
    sourceMode: "fallback",
    degraded: true,
    provenanceStages: [
      ...provenanceStages,
      {
        phase: "fallback",
        attempt: 0,
        strategy: input.candidate.strategy,
        sourceMode: "fallback",
        degraded: true,
        outcome: "fallback",
      },
    ],
  };
}
