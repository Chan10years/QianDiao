import { z } from "zod";

import {
  toVersionedRecipeReadModel,
  type VersionedRecipeReadModel,
} from "@/src/application/get-current-recipe";
import { RecipeIdSchema } from "@/src/domain/id";
import type { RecipeRepository } from "@/src/repositories/recipe-repository";
import {
  SessionNotFoundError,
  type SessionRepository,
} from "@/src/repositories/session-repository";

const GetRecipeVersionChainInputSchema = z
  .object({
    recipeId: RecipeIdSchema,
  })
  .strict();

export type GetRecipeVersionChainInput = z.input<typeof GetRecipeVersionChainInputSchema>;

export type GetRecipeVersionChainReadRepository = Pick<SessionRepository, "findById"> &
  Pick<RecipeRepository, "listRecipeVersionChain" | "listSafetyDecisionsBySet">;

export interface GetRecipeVersionChainDependencies {
  read(): GetRecipeVersionChainReadRepository;
}

export class RecipeVersionChainNotFoundError extends Error {
  readonly code = "RECIPE_VERSION_CHAIN_NOT_FOUND";

  constructor() {
    super("RECIPE_VERSION_CHAIN_NOT_FOUND");
    this.name = "RecipeVersionChainNotFoundError";
  }
}

export { type VersionedRecipeReadModel };

export function getRecipeVersionChain(
  dependencies: GetRecipeVersionChainDependencies,
  input: GetRecipeVersionChainInput,
): VersionedRecipeReadModel[] {
  const parsed = GetRecipeVersionChainInputSchema.parse(input);
  const repository = dependencies.read();
  const recipes = repository.listRecipeVersionChain(parsed.recipeId);
  if (recipes.length === 0) {
    throw new RecipeVersionChainNotFoundError();
  }

  const root = recipes[0];
  if (root === undefined) {
    throw new RecipeVersionChainNotFoundError();
  }
  const session = repository.findById(root.sessionId);
  if (session === null) {
    throw new SessionNotFoundError();
  }

  return recipes.map((recipe) => {
    if (recipe.sessionId !== root.sessionId) {
      throw new Error("VERSIONED_RECIPE_READ_MODEL_INVARIANT");
    }
    return toVersionedRecipeReadModel(
      recipe,
      repository.listSafetyDecisionsBySet(recipe.recipeSetId),
      session.selectedRecipeId,
    );
  });
}
