import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";
import { DrizzleFeedbackRepository } from "@/src/infrastructure/repositories/drizzle-feedback-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";

describe("DrizzleFeedbackRepository", () => {
  let database: TestDatabase;

  it("round-trips feedback deltas through FeedbackSchema validation", () => {
    database = createTestDatabase();
    const fixtures = makeDomainFixtures();

    try {
      new DrizzleSessionRepository(database.db).create({ id: fixtures.ids.sessionId });
      const recipeRepository = new DrizzleRecipeRepository(database.db);
      const recipeSetId = recipeRepository.createRecipeSet({
        id: randomUUID(),
        sessionId: fixtures.ids.sessionId,
        sourceMode: "fallback",
      });
      const recipe = recipeRepository.createRecipe({
        recipeSetId,
        sessionId: fixtures.ids.sessionId,
        candidate: fixtures.recipes[0],
        version: 1,
        parentRecipeId: null,
      });
      const feedbackRepository = new DrizzleFeedbackRepository(database.db);
      const created = feedbackRepository.create({
        id: randomUUID(),
        sessionId: fixtures.ids.sessionId,
        recipeId: recipe.id,
        feedback: fixtures.feedback,
      });

      expect(feedbackRepository.findById(created.id)).toMatchObject({
        rating: 4,
        accepted: false,
        deltas: fixtures.feedback.deltas,
        notes: fixtures.feedback.notes,
        finalImageId: null,
      });
    } finally {
      database.cleanup();
    }
  });

  it("enforces recipe and session foreign keys", () => {
    database = createTestDatabase();
    const fixtures = makeDomainFixtures();

    try {
      const feedbackRepository = new DrizzleFeedbackRepository(database.db);

      expect(() =>
        feedbackRepository.create({
          id: randomUUID(),
          sessionId: fixtures.ids.sessionId,
          recipeId: fixtures.ids.recipeIds[0],
          feedback: fixtures.feedback,
        }),
      ).toThrow();
    } finally {
      database.cleanup();
    }
  });
});
