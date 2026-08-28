import { describe, expect, it } from "vitest";

import { createFeedbackRouteHandlers } from "@/app/api/sessions/[sessionId]/feedback/route";
import { createAdjustmentRouteHandlers } from "@/app/api/sessions/[sessionId]/adjustments/route";
import { createAcceptAdjustmentRouteHandlers } from "@/app/api/sessions/[sessionId]/accept-adjustment/route";
import { createCompleteSessionRouteHandlers } from "@/app/api/sessions/[sessionId]/complete/route";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase } from "@/tests/helpers/test-database";
import {
  createAdjustmentUnitOfWork,
  createFeedbackUnitOfWork,
} from "@/src/application/unit-of-work";
import { DrizzleIngredientRepository } from "@/src/infrastructure/repositories/drizzle-ingredient-repository";
import { DrizzleFeedbackRepository } from "@/src/infrastructure/repositories/drizzle-feedback-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { RecipeCandidateSchema, type RecipeCandidate } from "@/src/domain/recipe";
import type { RecipeAdjustmentInput, RecipeProvider } from "@/src/providers/recipe-provider";
import { FallbackRecipeProvider } from "@/src/infrastructure/providers/fallback-recipe-provider";
import { randomUUID } from "node:crypto";

const context = { params: Promise.resolve({ sessionId: "not-a-uuid" }) };

describe("Task 13 feedback routes", () => {
  it("maps malformed feedback requests to INVALID_REQUEST", async () => {
    const response = await createFeedbackRouteHandlers({} as never).POST(
      new Request("http://localhost/api/sessions/not-a-uuid/feedback", {
        method: "POST",
        body: "{}",
      }),
      context,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("maps malformed adjustment requests to INVALID_REQUEST", async () => {
    const response = await createAdjustmentRouteHandlers({} as never).POST(
      new Request("http://localhost/api/sessions/not-a-uuid/adjustments", {
        method: "POST",
        body: "{}",
      }),
      context,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("maps malformed acceptance requests to INVALID_REQUEST", async () => {
    const response = await createAcceptAdjustmentRouteHandlers({} as never).POST(
      new Request("http://localhost/api/sessions/not-a-uuid/accept-adjustment", {
        method: "POST",
        body: "{}",
      }),
      context,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("maps malformed completion requests to INVALID_REQUEST", async () => {
    const response = await createCompleteSessionRouteHandlers({} as never).POST(
      new Request("http://localhost/api/sessions/not-a-uuid/complete", {
        method: "POST",
        body: "{}",
      }),
      context,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("returns a persisted feedback result and a proposed adjustment through the routes", async () => {
    const database = createTestDatabase();
    const fixtures = makeDomainFixtures();
    const sessionRepository = new DrizzleSessionRepository(database.db);
    const recipeRepository = new DrizzleRecipeRepository(database.db);
    sessionRepository.create({ id: fixtures.ids.sessionId });
    const recipeSetId = recipeRepository.createRecipeSet({
      id: randomUUID(),
      sessionId: fixtures.ids.sessionId,
      sourceMode: "fallback",
    });
    const recipes = fixtures.recipes.map((candidate) =>
      recipeRepository.createRecipe({
        recipeSetId,
        sessionId: fixtures.ids.sessionId,
        candidate,
      }),
    );
    for (const recipe of recipes) {
      recipeRepository.createSafetyDecision({
        recipeId: recipe.id,
        level: recipe.safetyLevel,
        ruleHits: [],
        engineVersion: "1.0.0",
      });
    }
    const selectedRecipe = recipes[0];
    if (selectedRecipe === undefined) {
      throw new Error("TEST_SELECTED_RECIPE_MISSING");
    }
    new DrizzleIngredientRepository(database.db).replaceForSession({
      sessionId: fixtures.ids.sessionId,
      ingredients: [{ ...fixtures.ingredient, confirmed: true, abv: 52 }],
    });
    database.sqlite
      .prepare("UPDATE sessions SET state = 'FEEDBACK', selected_recipe_id = ? WHERE id = ?")
      .run(selectedRecipe.id, fixtures.ids.sessionId);

    try {
      const feedbackResponse = await createFeedbackRouteHandlers(
        createFeedbackUnitOfWork(database.db),
      ).POST(
        new Request("http://localhost/api/sessions/test/feedback", {
          method: "POST",
          body: JSON.stringify({
            requestId: randomUUID(),
            expectedVersion: 0,
            recipeId: selectedRecipe.id,
            feedback: fixtures.feedback,
          }),
        }),
        { params: Promise.resolve({ sessionId: fixtures.ids.sessionId }) },
      );
      const feedbackBody = await feedbackResponse.json();
      expect(feedbackResponse.status).toBe(200);
      expect(feedbackBody.data.state).toBe("ADJUSTMENT");

      const provider: RecipeProvider = {
        async generate() {
          throw new Error("TEST_GENERATE_NOT_USED");
        },
        async adjust(input: RecipeAdjustmentInput): Promise<RecipeCandidate> {
          return RecipeCandidateSchema.parse({
            ...input.currentRecipe,
            id: randomUUID(),
            title: `${input.currentRecipe.title}·路由调整`,
            materials: [{ name: "白酒", amountMl: 20, unit: "ml" }],
            estimatedAbv: 0,
            safetyLevel: "BLOCK",
          });
        },
      };
      const adjustmentResponse = await createAdjustmentRouteHandlers({
        ...createAdjustmentUnitOfWork(database.db),
        primaryProvider: provider,
        fallbackProvider: new FallbackRecipeProvider(),
      }).POST(
        new Request("http://localhost/api/sessions/test/adjustments", {
          method: "POST",
          body: JSON.stringify({
            requestId: randomUUID(),
            expectedVersion: feedbackBody.data.sessionVersion,
            feedbackId: feedbackBody.data.feedbackId,
          }),
        }),
        { params: Promise.resolve({ sessionId: fixtures.ids.sessionId }) },
      );
      const adjustmentBody = await adjustmentResponse.json();
      expect(adjustmentResponse.status).toBe(200);
      expect(adjustmentBody.data.proposedRecipe.version).toBe(2);
      expect(adjustmentBody.data.proposedRecipe.candidate.safetyLevel).toBe("ALLOW");

      const acceptResponse = await createAcceptAdjustmentRouteHandlers(
        createAdjustmentUnitOfWork(database.db),
      ).POST(
        new Request("http://localhost/api/sessions/test/accept-adjustment", {
          method: "POST",
          body: JSON.stringify({
            requestId: randomUUID(),
            expectedVersion: adjustmentBody.data.sessionVersion,
            proposedRecipeId: adjustmentBody.data.proposedRecipe.recipeId,
          }),
        }),
        { params: Promise.resolve({ sessionId: fixtures.ids.sessionId }) },
      );
      const acceptBody = await acceptResponse.json();
      expect(acceptResponse.status).toBe(200);
      expect(acceptBody.data).toMatchObject({
        state: "MIXING",
        currentRecipeId: adjustmentBody.data.proposedRecipe.recipeId,
      });

      const completionFeedbackId = randomUUID();
      new DrizzleFeedbackRepository(database.db).create({
        id: completionFeedbackId,
        sessionId: fixtures.ids.sessionId,
        recipeId: adjustmentBody.data.proposedRecipe.recipeId,
        feedback: {
          rating: 5,
          accepted: true,
          deltas: { sweetness: 0, acidity: 0, alcoholIntensity: 0, body: 0 },
          finalImageId: null,
        },
      });
      database.sqlite
        .prepare("UPDATE sessions SET state = 'FEEDBACK', current_step = NULL WHERE id = ?")
        .run(fixtures.ids.sessionId);
      const completeResponse = await createCompleteSessionRouteHandlers(
        createAdjustmentUnitOfWork(database.db),
      ).POST(
        new Request("http://localhost/api/sessions/test/complete", {
          method: "POST",
          body: JSON.stringify({
            requestId: randomUUID(),
            expectedVersion: acceptBody.data.sessionVersion,
            feedbackId: completionFeedbackId,
          }),
        }),
        { params: Promise.resolve({ sessionId: fixtures.ids.sessionId }) },
      );
      const completeBody = await completeResponse.json();
      expect(completeResponse.status).toBe(200);
      expect(completeBody.data.state).toBe("COMPLETED");
    } finally {
      database.cleanup();
    }
  });
});
