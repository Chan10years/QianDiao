import { z } from "zod";

import { DetectedIngredientSchema } from "@/src/domain/ingredient";
import { FeedbackSchema } from "@/src/domain/feedback";
import { RecipeCandidateSchema, RecipeCandidateSetSchema } from "@/src/domain/recipe";
import { TasteProfileSchema } from "@/src/domain/preferences";
import { AdjustmentConstraintsSchema } from "@/src/agent/build-adjustment-constraints";

export const RecipeGenerationInputSchema = z
  .object({
    preferences: TasteProfileSchema,
    ingredients: z.array(DetectedIngredientSchema).min(1).max(50),
  })
  .strict();

export const RecipeAdjustmentInputSchema = z
  .object({
    preferences: TasteProfileSchema,
    currentRecipe: RecipeCandidateSchema,
    confirmedMaterialNames: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    feedback: FeedbackSchema,
    experimentMemories: z
      .array(
        z
          .object({
            recipeId: z.string().uuid(),
            feedbackId: z.string().uuid(),
            summary: z.string().trim().min(1).max(1000),
            tags: z.array(z.string().trim().min(1).max(100)).max(50),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    constraints: AdjustmentConstraintsSchema.optional(),
  })
  .strict();

export type RecipeGenerationInput = z.infer<typeof RecipeGenerationInputSchema>;
export type RecipeAdjustmentInput = z.infer<typeof RecipeAdjustmentInputSchema>;
export type RecipeCandidate = z.infer<typeof RecipeCandidateSchema>;
export type RecipeCandidateSet = z.infer<typeof RecipeCandidateSetSchema>;
export const RecipeSourceModeSchema = z.enum(["fallback", "qwen"]);
export type RecipeSourceMode = z.infer<typeof RecipeSourceModeSchema>;

export const RecipeProvenanceStageSchema = z
  .object({
    phase: z.enum(["generate", "repair", "fallback"]),
    attempt: z.number().int().nonnegative(),
    strategy: z.enum(["A_CONSERVATIVE", "B_CREATIVE", "C_UPGRADE"]).optional(),
    sourceMode: RecipeSourceModeSchema,
    degraded: z.boolean(),
    outcome: z.enum([
      "accepted",
      "invalid_output",
      "repair_accepted",
      "repair_failed",
      "fallback",
      "timeout",
    ]),
  })
  .strict();

export const RecipeProvenanceSchema = z
  .object({
    recipeSetId: z.string().uuid(),
    sourceMode: RecipeSourceModeSchema,
    degraded: z.boolean(),
    stages: z.array(RecipeProvenanceStageSchema).min(1).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    const firstStage = value.stages[0];
    if (firstStage?.phase !== "generate" || firstStage.attempt !== 0) {
      context.addIssue({
        code: "custom",
        path: ["stages", 0],
        message: "INITIAL_GENERATE_STAGE_REQUIRED",
      });
    }
  });

export type RecipeProvenanceStage = z.infer<typeof RecipeProvenanceStageSchema>;
export type RecipeProvenance = z.infer<typeof RecipeProvenanceSchema>;

export interface RecipeProviderCallOptions {
  beforeExternalCall?: () => Promise<void>;
}

export interface RecipeProviderOutcome<TValue> {
  value: TValue;
  sourceMode: RecipeSourceMode;
  degraded: boolean;
  provenanceStages?: readonly RecipeProvenanceStage[];
}

export interface RecipeProvider {
  generate(input: RecipeGenerationInput): Promise<RecipeCandidateSet>;
  adjust(input: RecipeAdjustmentInput): Promise<RecipeCandidate>;
}

export interface OutcomeAwareRecipeProvider extends RecipeProvider {
  generateWithOutcome(
    input: RecipeGenerationInput,
    options?: RecipeProviderCallOptions,
  ): Promise<RecipeProviderOutcome<RecipeCandidateSet>>;
  adjustWithOutcome(
    input: RecipeAdjustmentInput,
    options?: RecipeProviderCallOptions,
  ): Promise<RecipeProviderOutcome<RecipeCandidate>>;
}

export function isOutcomeAwareRecipeProvider(
  provider: RecipeProvider,
): provider is OutcomeAwareRecipeProvider {
  return (
    "generateWithOutcome" in provider &&
    typeof provider.generateWithOutcome === "function" &&
    "adjustWithOutcome" in provider &&
    typeof provider.adjustWithOutcome === "function"
  );
}

export type QwenOperation = "generate" | "adjust";

export interface QwenCompletionRequest {
  operation: QwenOperation;
  model: string;
  prompt: string;
  timeoutMs: number;
  jsonSchema: unknown;
  signal?: AbortSignal;
}

export interface QwenCompletionClient {
  complete(request: QwenCompletionRequest): Promise<string>;
}
