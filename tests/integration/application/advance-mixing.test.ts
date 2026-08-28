import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createSession } from "@/src/application/create-session";
import { advanceMixing } from "@/src/application/advance-mixing";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import { SessionEvent } from "@/src/workflow/session-machine";
import { sessions } from "@/src/infrastructure/db/schema";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { withTransaction } from "@/src/infrastructure/db/transaction";
import type { AdvanceMixingDependencies } from "@/src/application/advance-mixing";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";

function createDependencies(database: TestDatabase): AdvanceMixingDependencies {
  return {
    read: () => {
      const sessionsRepository = new DrizzleSessionRepository(database.db);
      const recipesRepository = new DrizzleRecipeRepository(database.db);
      return {
        findById: (id) => sessionsRepository.findById(id),
        findIdempotencyRecordByRequestId: (requestId) =>
          sessionsRepository.findIdempotencyRecordByRequestId(requestId),
        findRecipeById: (id) => recipesRepository.findById(id),
      };
    },
    transaction: (operation) =>
      withTransaction(database.db, (transaction) => {
        const sessionsRepository = new DrizzleSessionRepository(transaction);
        const recipesRepository = new DrizzleRecipeRepository(transaction);
        return operation({
          findById: (id) => sessionsRepository.findById(id),
          findIdempotencyRecordByRequestId: (requestId) =>
            sessionsRepository.findIdempotencyRecordByRequestId(requestId),
          findRecipeById: (id) => recipesRepository.findById(id),
          updateVersion: (input) => sessionsRepository.updateVersion(input),
          saveIdempotencyRecord: (input) => sessionsRepository.saveIdempotencyRecord(input),
          acquireSessionMutationLease: (input) =>
            sessionsRepository.acquireSessionMutationLease(input),
          assertSessionMutationLease: (input) =>
            sessionsRepository.assertSessionMutationLease(input),
          renewSessionMutationLease: (input) => sessionsRepository.renewSessionMutationLease(input),
          releaseSessionMutationLease: (input) =>
            sessionsRepository.releaseSessionMutationLease(input),
        });
      }),
  };
}

function seedMixingSession(database: TestDatabase, step: number, version: number) {
  const fixtures = makeDomainFixtures();
  const session = createSession(createSessionUnitOfWork(database.db), {
    requestId: fixtures.ids.requestId,
  });
  const recipes = fixtures.recipes.map((candidate, index) =>
    index === 0
      ? {
          ...candidate,
          steps: [...candidate.steps, { order: 2, instruction: "最后轻轻搅拌并观察香气。" }],
        }
      : candidate,
  );
  const recipe = recipes[0];
  withTransaction(database.db, (transaction) => {
    new DrizzleRecipeRepository(transaction).createBatch({
      sessionId: session.response.session.id,
      requestId: crypto.randomUUID(),
      expectedVersion: 0,
      recipeSetId: crypto.randomUUID(),
      sourceMode: "fallback",
      recipes: recipes.map((candidate) => ({ candidate })),
      recommendedRecipeId: recipe.id,
      safetyDecisions: recipes.map((candidate) => ({
        recipeId: candidate.id,
        level: "ALLOW" as const,
        ruleHits: [],
        engineVersion: "1.0.0",
      })),
      event: {
        type: "recipe_set_generated",
        summary: "seed",
        metadata: {},
      },
    });
  });
  database.db
    .update(sessions)
    .set({
      state: "MIXING",
      version,
      preferencesJson: JSON.stringify(fixtures.tasteProfile),
      selectedRecipeId: recipe.id,
      currentStep: step,
    })
    .where(eq(sessions.id, session.response.session.id))
    .run();
  return { sessionId: session.response.session.id, recipe, version };
}

describe("advanceMixing", () => {
  it("advances, persists currentStep, replays one requestId, and rejects stale versions", () => {
    const database = createTestDatabase();
    const seeded = seedMixingSession(database, 0, 5);
    const dependencies = createDependencies(database);
    const requestId = crypto.randomUUID();

    try {
      const first = advanceMixing(dependencies, {
        sessionId: seeded.sessionId,
        requestId,
        expectedVersion: 5,
        action: "ADVANCE_MIXING",
      });
      const replay = advanceMixing(dependencies, {
        sessionId: seeded.sessionId,
        requestId,
        expectedVersion: 5,
        action: "ADVANCE_MIXING",
      });

      expect(first.response.data).toMatchObject({
        action: "ADVANCE_MIXING",
        currentStep: 1,
        totalSteps: seeded.recipe.steps.length,
      });
      expect(first.response.session).toMatchObject({ state: "MIXING", version: 6 });
      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);
      expect(database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "MIXING",
        version: 6,
        currentStep: 1,
      });

      expect(() =>
        advanceMixing(dependencies, {
          sessionId: seeded.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 5,
          action: "BACK_MIXING",
        }),
      ).toThrowError(/VERSION_CONFLICT/);
      expect(database.db.select().from(sessions).all()[0]?.currentStep).toBe(1);
    } finally {
      database.cleanup();
    }
  });

  it("uses workflow boundaries for back, first-step rejection, and final-step FEEDBACK", () => {
    const database = createTestDatabase();
    const seeded = seedMixingSession(database, 0, 5);
    const dependencies = createDependencies(database);

    try {
      expect(() =>
        advanceMixing(dependencies, {
          sessionId: seeded.sessionId,
          requestId: crypto.randomUUID(),
          expectedVersion: 5,
          action: "BACK_MIXING",
        }),
      ).toThrowError(new RegExp(`${SessionEvent.BACK_MIXING}`));

      database.db
        .update(sessions)
        .set({ currentStep: seeded.recipe.steps.length - 1, version: 8 })
        .where(eq(sessions.id, seeded.sessionId))
        .run();

      const result = advanceMixing(dependencies, {
        sessionId: seeded.sessionId,
        requestId: crypto.randomUUID(),
        expectedVersion: 8,
        action: "ADVANCE_MIXING",
      });
      expect(result.response.session).toMatchObject({ state: "FEEDBACK", version: 9 });
      expect(result.response.data.currentStep).toBeNull();
    } finally {
      database.cleanup();
    }
  });

  it("allows only one concurrent mutation for the same expectedVersion", async () => {
    const database = createTestDatabase();
    const seeded = seedMixingSession(database, 0, 5);

    try {
      const dependencies = createDependencies(database);
      const outcomes = await Promise.allSettled([
        Promise.resolve().then(() =>
          advanceMixing(dependencies, {
            sessionId: seeded.sessionId,
            requestId: crypto.randomUUID(),
            expectedVersion: 5,
            action: "ADVANCE_MIXING",
          }),
        ),
        Promise.resolve().then(() =>
          advanceMixing(dependencies, {
            sessionId: seeded.sessionId,
            requestId: crypto.randomUUID(),
            expectedVersion: 5,
            action: "ADVANCE_MIXING",
          }),
        ),
      ]);

      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
      const rejected = outcomes.find((outcome) => outcome.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: { code: "VERSION_CONFLICT" },
      });
      expect(database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "MIXING",
        version: 6,
        currentStep: 1,
      });
    } finally {
      database.cleanup();
    }
  });
});
