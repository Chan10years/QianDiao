import { z } from "zod";

import {
  RecipeCandidateSchema,
  RecipeSafetySummarySchema,
  type RecipeCandidate,
  type RecipeSafetySummary,
} from "@/src/domain/recipe";
import { SessionIdSchema } from "@/src/domain/id";
import type {
  RecipeDataIntegrityError,
  RecipeRecord,
  RecipeRepository,
  SafetyDecisionRecord,
} from "@/src/repositories/recipe-repository";
import {
  SessionNotFoundError,
  type SessionRepository,
} from "@/src/repositories/session-repository";

const GetCurrentRecipeInputSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

export type GetCurrentRecipeInput = z.input<typeof GetCurrentRecipeInputSchema>;

export interface VersionedRecipeReadModel {
  recipeId: string;
  recipeSetId: string;
  candidate: RecipeCandidate;
  version: number;
  parentRecipeId: string | null;
  feedbackId: string | null;
  safety: RecipeSafetySummary;
  isSelected: boolean;
}

export type GetCurrentRecipeReadRepository = Pick<SessionRepository, "findById"> &
  Pick<RecipeRepository, "findCurrentRecipeBySession" | "listSafetyDecisionsBySet">;

export interface GetCurrentRecipeDependencies {
  read(): GetCurrentRecipeReadRepository;
}

export class CurrentRecipeNotFoundError extends Error {
  readonly code = "CURRENT_RECIPE_NOT_FOUND";

  constructor() {
    super("CURRENT_RECIPE_NOT_FOUND");
    this.name = "CurrentRecipeNotFoundError";
  }
}

export class VersionedRecipeReadModelInvariantError extends Error {
  readonly code = "VERSIONED_RECIPE_READ_MODEL_INVARIANT";

  constructor() {
    super("VERSIONED_RECIPE_READ_MODEL_INVARIANT");
    this.name = "VersionedRecipeReadModelInvariantError";
  }
}

function toSafetySummary(decision: SafetyDecisionRecord): RecipeSafetySummary {
  return RecipeSafetySummarySchema.parse({
    level: decision.level,
    reasons:
      decision.ruleHits.map((hit) => hit.reason).filter((reason) => reason.length > 0).length > 0
        ? decision.ruleHits.map((hit) => hit.reason).filter((reason) => reason.length > 0)
        : ["未命中已知安全规则。"],
    alternatives: [
      ...new Set(
        decision.ruleHits
          .map((hit) => hit.alternative)
          .filter((alternative): alternative is string => alternative !== undefined),
      ),
    ],
  });
}

export function toVersionedRecipeReadModel(
  recipe: RecipeRecord,
  persistedSafetyDecisions: readonly SafetyDecisionRecord[],
  selectedRecipeId: string | null,
): VersionedRecipeReadModel {
  try {
    const candidate = RecipeCandidateSchema.parse({
      id: recipe.id,
      strategy: recipe.strategy,
      title: recipe.title,
      fitReason: recipe.fitReason,
      differenceReason: recipe.differenceReason,
      materials: recipe.materials,
      steps: recipe.steps,
      estimatedAbv: recipe.estimatedAbv,
      safetyLevel: recipe.safetyLevel,
      experimental: recipe.experimental,
      missingIngredients: recipe.missingIngredients,
    });
    const matchingDecisions = persistedSafetyDecisions.filter(
      (decision) => decision.recipeId === recipe.id,
    );
    if (matchingDecisions.length !== 1 || matchingDecisions[0]?.level !== recipe.safetyLevel) {
      throw new VersionedRecipeReadModelInvariantError();
    }

    return {
      recipeId: recipe.id,
      recipeSetId: recipe.recipeSetId,
      candidate,
      version: recipe.version,
      parentRecipeId: recipe.parentRecipeId,
      feedbackId: recipe.feedbackId,
      safety: toSafetySummary(matchingDecisions[0]),
      isSelected: selectedRecipeId === recipe.id,
    };
  } catch (error) {
    if (error instanceof VersionedRecipeReadModelInvariantError) {
      throw error;
    }
    throw new VersionedRecipeReadModelInvariantError();
  }
}

export function getCurrentRecipe(
  dependencies: GetCurrentRecipeDependencies,
  input: GetCurrentRecipeInput,
): VersionedRecipeReadModel {
  const parsed = GetCurrentRecipeInputSchema.parse(input);
  const repository = dependencies.read();
  const session = repository.findById(parsed.sessionId);
  if (session === null) {
    throw new SessionNotFoundError();
  }

  let recipe: RecipeRecord | null;
  try {
    recipe = repository.findCurrentRecipeBySession(parsed.sessionId);
  } catch (error) {
    if (isRecipeDataIntegrityError(error)) {
      throw new VersionedRecipeReadModelInvariantError();
    }
    throw error;
  }
  if (recipe === null) {
    throw new CurrentRecipeNotFoundError();
  }

  try {
    return toVersionedRecipeReadModel(
      recipe,
      repository.listSafetyDecisionsBySet(recipe.recipeSetId),
      session.selectedRecipeId,
    );
  } catch (error) {
    if (
      error instanceof VersionedRecipeReadModelInvariantError ||
      isRecipeDataIntegrityError(error)
    ) {
      throw new VersionedRecipeReadModelInvariantError();
    }
    throw error;
  }
}

function isRecipeDataIntegrityError(error: unknown): error is RecipeDataIntegrityError {
  return (
    error instanceof Error &&
    error.name === "RecipeDataIntegrityError" &&
    error.message === "RECIPE_DATA_INTEGRITY"
  );
}
