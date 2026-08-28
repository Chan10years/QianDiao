import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { RecipeCandidateSchema, RecipeCandidateSetSchema } from "@/src/domain/recipe";

describe("RecipeCandidateSchema", () => {
  it("accepts a candidate with materials, steps, safety, and strategy details", () => {
    const fixture = makeDomainFixtures();

    expect(RecipeCandidateSchema.parse(fixture.recipes[0])).toEqual(fixture.recipes[0]);
  });

  it("rejects more than two missing ingredients", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      RecipeCandidateSchema.parse({
        ...fixture.recipes[0],
        missingIngredients: ["冰块", "柠檬", "苏打水"],
      }),
    ).toThrow();
  });

  it("rejects a non-positive material amount", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      RecipeCandidateSchema.parse({
        ...fixture.recipes[0],
        materials: [{ name: "白酒", amountMl: 0, unit: "ml" }],
      }),
    ).toThrow();
  });
});

describe("RecipeCandidateSetSchema", () => {
  it("accepts exactly one A, B, and C candidate with a valid recommendation", () => {
    const fixture = makeDomainFixtures();

    expect(RecipeCandidateSetSchema.parse(fixture.recipeSet)).toEqual(fixture.recipeSet);
  });

  it("rejects a set with fewer than three candidates", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      RecipeCandidateSetSchema.parse({
        ...fixture.recipeSet,
        recipes: fixture.recipeSet.recipes.slice(0, 2),
      }),
    ).toThrow();
  });

  it("rejects duplicate candidate IDs", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      RecipeCandidateSetSchema.parse({
        ...fixture.recipeSet,
        recipes: [
          fixture.recipeSet.recipes[0],
          { ...fixture.recipeSet.recipes[1], id: fixture.recipeSet.recipes[0].id },
          fixture.recipeSet.recipes[2],
        ],
      }),
    ).toThrow();
  });

  it("rejects a recommendation that is not in the candidate set", () => {
    const fixture = makeDomainFixtures();

    expect(() =>
      RecipeCandidateSetSchema.parse({
        ...fixture.recipeSet,
        recommendedRecipeId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    ).toThrow();
  });
});
