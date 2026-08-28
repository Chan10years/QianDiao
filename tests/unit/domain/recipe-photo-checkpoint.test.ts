import { describe, expect, it } from "vitest";

import { RecipeStepSchema } from "@/src/domain/recipe";
import { FallbackRecipeProvider } from "@/src/infrastructure/providers/fallback-recipe-provider";
import { makeDomainFixtures } from "@/tests/fixtures/domain";

describe("recipe photo checkpoints", () => {
  it("defaults the checkpoint marker for legacy recipe steps", () => {
    const step = RecipeStepSchema.parse({
      order: 1,
      instruction: "加入材料并轻轻搅拌。",
    });

    expect(step.isPhotoCheckpoint).toBe(false);
  });

  it("marks at least one fallback step as a photo checkpoint", async () => {
    const fixtures = makeDomainFixtures();
    const recipes = await new FallbackRecipeProvider().generate({
      preferences: fixtures.tasteProfile,
      ingredients: [{ ...fixtures.ingredient, confirmed: true, abv: 42 }],
    });

    expect(
      recipes.recipes.some((recipe) => recipe.steps.some((step) => step.isPhotoCheckpoint)),
    ).toBe(true);
  });
});
