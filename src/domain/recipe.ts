import { z } from "zod";

import { RecipeIdSchema } from "@/src/domain/id";
import { SafetyLevelSchema } from "@/src/domain/safety";

const recipeTextSchema = z.string().trim().min(1).max(500);

export const RecipeStrategySchema = z.enum(["A_CONSERVATIVE", "B_CREATIVE", "C_UPGRADE"]);

export const RecipeMaterialSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    amountMl: z.number().finite().positive().max(2000),
    unit: z.literal("ml"),
  })
  .strict();

export const RecipeStepSchema = z
  .object({
    order: z.number().int().positive(),
    instruction: recipeTextSchema,
    isPhotoCheckpoint: z.boolean().default(false),
  })
  .strict();

export const RecipeCandidateSchema = z
  .object({
    id: RecipeIdSchema,
    strategy: RecipeStrategySchema,
    title: recipeTextSchema,
    fitReason: recipeTextSchema,
    differenceReason: recipeTextSchema,
    materials: z.array(RecipeMaterialSchema).min(1).max(20),
    steps: z.array(RecipeStepSchema).min(1).max(20),
    estimatedAbv: z.number().finite().min(0).max(100).nullable(),
    safetyLevel: SafetyLevelSchema,
    experimental: z.boolean(),
    missingIngredients: z.array(z.string().trim().min(1).max(100)).max(2),
  })
  .strict();

export const RecipeCandidateSetSchema = z
  .object({
    recipes: z.array(RecipeCandidateSchema).length(3),
    recommendedRecipeId: RecipeIdSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.recipes.map((recipe) => recipe.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        path: ["recipes"],
        message: "Recipe IDs must be unique",
      });
    }

    const strategies = new Set(value.recipes.map((recipe) => recipe.strategy));
    if (
      strategies.size !== 3 ||
      !strategies.has("A_CONSERVATIVE") ||
      !strategies.has("B_CREATIVE") ||
      !strategies.has("C_UPGRADE")
    ) {
      context.addIssue({
        code: "custom",
        path: ["recipes"],
        message: "Recipe strategies must be exactly A, B, and C",
      });
    }

    if (!ids.includes(value.recommendedRecipeId)) {
      context.addIssue({
        code: "custom",
        path: ["recommendedRecipeId"],
        message: "Recommended recipe must be included in recipes",
      });
    }
  });

export const RecipeSafetySummarySchema = z
  .object({
    level: SafetyLevelSchema,
    reasons: z.array(recipeTextSchema).max(20),
    alternatives: z.array(recipeTextSchema).max(20),
  })
  .strict();

export const RecipeDisplaySchema = RecipeCandidateSchema.extend({
  safety: RecipeSafetySummarySchema,
}).strict();

export type RecipeStrategy = z.infer<typeof RecipeStrategySchema>;
export type RecipeMaterial = z.infer<typeof RecipeMaterialSchema>;
export type RecipeStep = z.infer<typeof RecipeStepSchema>;
export type RecipeCandidate = z.infer<typeof RecipeCandidateSchema>;
export type RecipeCandidateSet = z.infer<typeof RecipeCandidateSetSchema>;
export type RecipeSafetySummary = z.infer<typeof RecipeSafetySummarySchema>;
export type RecipeDisplay = z.infer<typeof RecipeDisplaySchema>;
