import { z } from "zod";

import { SessionIdSchema } from "@/src/domain/id";
import { RecipeCandidateSchema, RecipeDisplaySchema } from "@/src/domain/recipe";
import { evaluateRecipeCandidateSafety } from "@/src/application/repair-blocked-recipe";
import { evaluateSafety } from "@/src/safety/evaluate-safety";
import type { IngredientRepository } from "@/src/repositories/ingredient-repository";
import { RecipeProvenanceSchema, RecipeSourceModeSchema } from "@/src/providers/recipe-provider";
import {
  RecipeDataIntegrityError,
  type RecipeRepository,
  type SafetyRuleHitRecord,
} from "@/src/repositories/recipe-repository";
import type { SafetyHit } from "@/src/safety/types";
import {
  SessionNotFoundError,
  type SessionRepository,
} from "@/src/repositories/session-repository";

const GetRecipeSetInputSchema = z
  .object({
    sessionId: SessionIdSchema,
  })
  .strict();

const CURRENT_SAFETY_ENGINE_VERSION = "1.0.0";

export type GetRecipeSetInput = z.input<typeof GetRecipeSetInputSchema>;

export type GetRecipeSetReadRepository = Pick<SessionRepository, "findById"> &
  Pick<IngredientRepository, "listBySession"> &
  Pick<
    RecipeRepository,
    "findSetBySession" | "listBySet" | "listSafetyDecisionsBySet" | "listDecisionEvents"
  > &
  Partial<Pick<RecipeRepository, "findInitialRecipeSetBySession">>;

export interface GetRecipeSetDependencies {
  read(): GetRecipeSetReadRepository;
}

export class RecipeSetNotFoundError extends Error {
  readonly code = "RECIPE_SET_NOT_FOUND";

  constructor() {
    super("RECIPE_SET_NOT_FOUND");
    this.name = "RecipeSetNotFoundError";
  }
}

export class RecipeSetInvariantError extends Error {
  readonly code = "RECIPE_SET_INVARIANT";

  constructor() {
    super("RECIPE_SET_INVARIANT");
    this.name = "RecipeSetInvariantError";
  }
}

function isPersistedDataIntegrityError(error: unknown): boolean {
  return error instanceof RecipeDataIntegrityError || error instanceof z.ZodError;
}

function safetyHitsMatch(
  persisted: readonly SafetyRuleHitRecord[],
  current: readonly SafetyHit[],
): boolean {
  return (
    persisted.length === current.length &&
    persisted.every((hit, index) => {
      const expected = current[index];
      return (
        expected !== undefined &&
        hit.ruleId === expected.ruleId &&
        hit.ruleVersion === expected.ruleVersion &&
        hit.level === expected.level &&
        hit.reason === expected.reason &&
        (hit.alternative ?? null) === (expected.alternative ?? null)
      );
    })
  );
}

function toSafetySummary(decision: {
  level: SafetyHit["level"];
  ruleHits: readonly SafetyRuleHitRecord[];
}) {
  const reasons = decision.ruleHits.map((hit) => hit.reason).filter((reason) => reason.length > 0);
  const alternatives = [
    ...new Set(
      decision.ruleHits
        .map((hit) => hit.alternative)
        .filter((alternative): alternative is string => alternative !== undefined),
    ),
  ];

  return {
    level: decision.level,
    reasons: reasons.length > 0 ? reasons : ["未命中已知安全规则。"],
    alternatives,
  };
}

export function getRecipeSet(dependencies: GetRecipeSetDependencies, input: GetRecipeSetInput) {
  const parsed = GetRecipeSetInputSchema.parse(input);
  const repository = dependencies.read();
  const session = repository.findById(parsed.sessionId);

  if (session === null) {
    throw new SessionNotFoundError();
  }

  let recipeSet;
  try {
    recipeSet = repository.findSetBySession(parsed.sessionId);
  } catch (error) {
    if (isPersistedDataIntegrityError(error)) {
      throw new RecipeSetInvariantError();
    }
    throw error;
  }
  if (recipeSet === null) {
    throw new RecipeSetNotFoundError();
  }

  let recipes;
  try {
    const initialRecipes =
      repository.findInitialRecipeSetBySession?.(parsed.sessionId) ??
      repository.listBySet(recipeSet.id);
    if (
      initialRecipes.length === 0 ||
      initialRecipes.some((recipe) => recipe.recipeSetId !== recipeSet.id)
    ) {
      throw new RecipeSetInvariantError();
    }
    recipes = initialRecipes.map((recipe) =>
      RecipeCandidateSchema.parse({
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
      }),
    );
  } catch (error) {
    if (isPersistedDataIntegrityError(error)) {
      throw new RecipeSetInvariantError();
    }
    throw error;
  }

  const recipeIds = new Set<string>(recipes.map((recipe) => recipe.id));
  const expectedStrategies = ["A_CONSERVATIVE", "B_CREATIVE", "C_UPGRADE"];
  if (
    recipes.length !== 3 ||
    recipeIds.size !== 3 ||
    [...new Set(recipes.map((recipe) => recipe.strategy))].sort().join(",") !==
      expectedStrategies.join(",")
  ) {
    throw new RecipeSetInvariantError();
  }

  let persistedSafetyDecisions;
  try {
    persistedSafetyDecisions = repository.listSafetyDecisionsBySet(recipeSet.id);
  } catch (error) {
    if (isPersistedDataIntegrityError(error)) {
      throw new RecipeSetInvariantError();
    }
    throw error;
  }
  const decisionsByRecipeId = new Map<string, (typeof persistedSafetyDecisions)[number]>(
    persistedSafetyDecisions.map((decision) => [decision.recipeId, decision]),
  );
  if (
    persistedSafetyDecisions.length !== recipes.length ||
    decisionsByRecipeId.size !== persistedSafetyDecisions.length ||
    persistedSafetyDecisions.some((decision) => !recipeIds.has(decision.recipeId))
  ) {
    throw new RecipeSetInvariantError();
  }

  let confirmedIngredients;
  try {
    confirmedIngredients = repository.listBySession(parsed.sessionId);
  } catch (error) {
    if (isPersistedDataIntegrityError(error)) {
      throw new RecipeSetInvariantError();
    }
    throw error;
  }
  for (const recipe of recipes) {
    const persistedDecision = decisionsByRecipeId.get(recipe.id);
    if (persistedDecision === undefined) {
      throw new RecipeSetInvariantError();
    }
    let currentDecision;
    try {
      currentDecision = evaluateRecipeCandidateSafety(
        recipe,
        confirmedIngredients,
        evaluateSafety,
      ).safetyDecision;
    } catch {
      throw new RecipeSetInvariantError();
    }
    if (
      persistedDecision.level !== currentDecision.level ||
      recipe.safetyLevel !== currentDecision.level ||
      persistedDecision.engineVersion !== CURRENT_SAFETY_ENGINE_VERSION ||
      !safetyHitsMatch(persistedDecision.ruleHits, currentDecision.hits)
    ) {
      throw new RecipeSetInvariantError();
    }
  }

  if (
    recipeSet.recommendedRecipeId === null ||
    !recipes.some((recipe) => recipe.id === recipeSet.recommendedRecipeId)
  ) {
    throw new RecipeSetInvariantError();
  }

  let decisionEvents;
  try {
    decisionEvents = repository.listDecisionEvents(parsed.sessionId);
  } catch (error) {
    if (isPersistedDataIntegrityError(error)) {
      throw new RecipeSetInvariantError();
    }
    throw error;
  }
  const latestGenerationEvent = [...decisionEvents]
    .reverse()
    .find((event) => event.type === "recipe_set_generated");
  if (latestGenerationEvent === undefined) {
    throw new RecipeSetInvariantError();
  }

  const provenanceResult = RecipeProvenanceSchema.safeParse(
    latestGenerationEvent.metadata.provenance,
  );
  const sourceModeResult = RecipeSourceModeSchema.safeParse(
    latestGenerationEvent.metadata.sourceMode,
  );
  const degraded = latestGenerationEvent.metadata.degraded;
  if (
    !provenanceResult.success ||
    !sourceModeResult.success ||
    typeof degraded !== "boolean" ||
    provenanceResult.data.recipeSetId !== recipeSet.id ||
    provenanceResult.data.sourceMode !== recipeSet.sourceMode ||
    sourceModeResult.data !== recipeSet.sourceMode ||
    provenanceResult.data.degraded !== degraded ||
    provenanceResult.data.sourceMode !==
      (provenanceResult.data.stages.some((stage) => stage.sourceMode === "fallback")
        ? "fallback"
        : "qwen") ||
    provenanceResult.data.degraded !== provenanceResult.data.stages.some((stage) => stage.degraded)
  ) {
    throw new RecipeSetInvariantError();
  }

  return {
    data: {
      recipeSet: {
        id: recipeSet.id,
        sourceMode: recipeSet.sourceMode,
        degraded: provenanceResult.data.degraded,
        provenance: provenanceResult.data,
        recommendedRecipeId: recipeSet.recommendedRecipeId,
        recipes: recipes.map((recipe) => {
          const decision = decisionsByRecipeId.get(recipe.id);
          if (decision === undefined) {
            throw new RecipeSetInvariantError();
          }
          return RecipeDisplaySchema.parse({
            ...recipe,
            safety: toSafetySummary(decision),
          });
        }),
      },
    },
    session: {
      id: session.id,
      state: session.state,
      version: session.version,
    },
  };
}
