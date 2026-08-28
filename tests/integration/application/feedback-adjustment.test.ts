import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { saveFeedback } from "@/src/application/save-feedback";
import {
  AdjustmentSafetyBlockedError,
  generateAdjustment,
} from "@/src/application/generate-adjustment";
import {
  acceptAdjustment,
  AdjustmentProposalInvalidError,
} from "@/src/application/accept-adjustment";
import { completeSession } from "@/src/application/complete-session";
import { RecipeCandidateSchema, type RecipeCandidate } from "@/src/domain/recipe";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";
import { DrizzleDecisionEventRepository } from "@/src/infrastructure/repositories/drizzle-decision-event-repository";
import { DrizzleFeedbackRepository } from "@/src/infrastructure/repositories/drizzle-feedback-repository";
import { DrizzleImageUploadRepository } from "@/src/infrastructure/repositories/drizzle-image-upload-repository";
import { DrizzleIngredientRepository } from "@/src/infrastructure/repositories/drizzle-ingredient-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { withTransaction } from "@/src/infrastructure/db/transaction";
import {
  createAdjustmentUnitOfWork,
  type FeedbackTransactionRepository,
} from "@/src/application/unit-of-work";
import type { RecipeProvider, RecipeAdjustmentInput } from "@/src/providers/recipe-provider";
import { FallbackRecipeProvider } from "@/src/infrastructure/providers/fallback-recipe-provider";
import { SessionMutationInProgressError } from "@/src/repositories/session-repository";

interface FeedbackContext {
  database: TestDatabase;
  sessionId: string;
  recipeId: string;
  finalImageId: string;
}

function adjustmentCandidate(
  currentRecipe: ReturnType<typeof makeDomainFixtures>["recipes"][number],
): RecipeCandidate {
  return RecipeCandidateSchema.parse({
    ...currentRecipe,
    id: randomUUID(),
    title: `${currentRecipe.title}·调整`,
    materials: [{ name: "白酒", amountMl: 20, unit: "ml" as const }],
    estimatedAbv: 99,
    safetyLevel: "BLOCK" as const,
  });
}

function makeAdjustmentProvider(
  transform: (input: RecipeAdjustmentInput) => RecipeCandidate,
  calls: { count: number },
): RecipeProvider {
  return {
    async generate() {
      throw new Error("TEST_GENERATE_NOT_USED");
    },
    async adjust(input) {
      calls.count += 1;
      return transform(input);
    },
  };
}

function createRealAdjustmentDependencies(
  database: TestDatabase,
  provider: RecipeProvider,
  evaluateSafety?: Parameters<typeof generateAdjustment>[0]["evaluateSafety"],
) {
  return {
    ...createAdjustmentUnitOfWork(database.db),
    primaryProvider: provider,
    fallbackProvider: new FallbackRecipeProvider(),
    ...(evaluateSafety === undefined ? {} : { evaluateSafety }),
  };
}

function createFeedbackContext(): FeedbackContext {
  const database = createTestDatabase();
  const fixtures = makeDomainFixtures();
  const sessionId = fixtures.ids.sessionId;
  const sessionRepository = new DrizzleSessionRepository(database.db);
  sessionRepository.create({ id: sessionId });

  const recipeRepository = new DrizzleRecipeRepository(database.db);
  const recipeSetId = recipeRepository.createRecipeSet({
    id: randomUUID(),
    sessionId,
    sourceMode: "fallback",
  });
  const createdRecipes = fixtures.recipes.map((candidate) =>
    recipeRepository.createRecipe({
      recipeSetId,
      sessionId,
      candidate,
    }),
  );
  const selectedRecipe = createdRecipes.find((recipe) => recipe.strategy === "A_CONSERVATIVE");
  if (selectedRecipe === undefined) {
    throw new Error("TEST_SELECTED_RECIPE_MISSING");
  }
  for (const recipe of createdRecipes) {
    recipeRepository.createSafetyDecision({
      recipeId: recipe.id,
      level: recipe.safetyLevel,
      ruleHits: [],
      engineVersion: "1.0.0",
    });
  }

  new DrizzleIngredientRepository(database.db).replaceForSession({
    sessionId,
    ingredients: [{ ...fixtures.ingredient, confirmed: true, abv: 52 }],
  });

  database.sqlite
    .prepare(
      "UPDATE sessions SET state = 'FEEDBACK', selected_recipe_id = ?, current_step = NULL WHERE id = ?",
    )
    .run(selectedRecipe.id, sessionId);

  const finalImageId = randomUUID();
  new DrizzleImageUploadRepository(database.db).createImage({
    id: finalImageId,
    sessionId,
    role: "final_drink",
    objectKey: `sessions/${sessionId}/final/${finalImageId}.jpg`,
    mime: "image/jpeg",
    width: 100,
    height: 100,
  });

  return { database, sessionId, recipeId: selectedRecipe.id, finalImageId };
}

function createDependencies(database: TestDatabase, options: { failMemory?: boolean } = {}) {
  return {
    read: () => {
      const sessionRepository = new DrizzleSessionRepository(database.db);
      const feedbackRepository = new DrizzleFeedbackRepository(database.db);
      const recipeRepository = new DrizzleRecipeRepository(database.db);
      const imageRepository = new DrizzleImageUploadRepository(database.db);
      return {
        findSessionById: (id: string) => sessionRepository.findById(id),
        findIdempotencyRecordByRequestId: (requestId: string) =>
          sessionRepository.findIdempotencyRecordByRequestId(requestId),
        findFeedbackById: (id: string) => feedbackRepository.findById(id),
        findRecipeById: (id: string) => recipeRepository.findById(id),
        findImageById: (id: string) => imageRepository.findImageById(id),
        listFeedbackByRecipe: (recipeId: string) => feedbackRepository.listByRecipe(recipeId),
      };
    },
    transaction: <T>(operation: (repository: FeedbackTransactionRepository) => T): T =>
      withTransaction(database.db, (transaction) => {
        const sessionRepository = new DrizzleSessionRepository(transaction);
        const feedbackRepository = new DrizzleFeedbackRepository(transaction);
        const recipeRepository = new DrizzleRecipeRepository(transaction);
        const imageRepository = new DrizzleImageUploadRepository(transaction);
        const eventRepository = new DrizzleDecisionEventRepository(transaction);
        return operation({
          findSessionById: (id: string) => sessionRepository.findById(id),
          findIdempotencyRecordByRequestId: (requestId: string) =>
            sessionRepository.findIdempotencyRecordByRequestId(requestId),
          acquireSessionMutationLease: (
            input: Parameters<DrizzleSessionRepository["acquireSessionMutationLease"]>[0],
          ) => sessionRepository.acquireSessionMutationLease(input),
          assertSessionMutationLease: (
            input: Parameters<DrizzleSessionRepository["assertSessionMutationLease"]>[0],
          ) => sessionRepository.assertSessionMutationLease(input),
          renewSessionMutationLease: (
            input: Parameters<DrizzleSessionRepository["renewSessionMutationLease"]>[0],
          ) => sessionRepository.renewSessionMutationLease(input),
          releaseSessionMutationLease: (
            input: Parameters<DrizzleSessionRepository["releaseSessionMutationLease"]>[0],
          ) => sessionRepository.releaseSessionMutationLease(input),
          updateVersion: (input: Parameters<DrizzleSessionRepository["updateVersion"]>[0]) =>
            sessionRepository.updateVersion(input),
          saveIdempotencyRecord: (
            input: Parameters<DrizzleSessionRepository["saveIdempotencyRecord"]>[0],
          ) => sessionRepository.saveIdempotencyRecord(input),
          findRecipeById: (id: string) => recipeRepository.findById(id),
          findFeedbackById: (id: string) => feedbackRepository.findById(id),
          listFeedbackByRecipe: (recipeId: string) => feedbackRepository.listByRecipe(recipeId),
          findImageById: (id: string) => imageRepository.findImageById(id),
          create: (input: Parameters<DrizzleFeedbackRepository["create"]>[0]) =>
            feedbackRepository.create(input),
          createExperimentMemory: (
            input: Parameters<DrizzleRecipeRepository["createExperimentMemory"]>[0],
          ) => {
            if (options.failMemory === true) {
              throw new Error("TEST_MEMORY_WRITE_FAILED");
            }
            return recipeRepository.createExperimentMemory(input);
          },
          createDecisionEvent: (
            input: Parameters<DrizzleDecisionEventRepository["createDecisionEvent"]>[0],
          ) => eventRepository.createDecisionEvent(input),
        });
      }),
  };
}

describe("save-feedback application", () => {
  it("persists an unsatisfied feedback, memory, event, and ADJUSTMENT state atomically", async () => {
    const context = createFeedbackContext();

    try {
      const fixtures = makeDomainFixtures();
      const result = await saveFeedback(createDependencies(context.database), {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: 0,
        recipeId: context.recipeId,
        feedback: {
          ...fixtures.feedback,
          finalImageId: context.finalImageId,
          accepted: false,
        },
      });

      expect(result).toMatchObject({
        sessionId: context.sessionId,
        state: "ADJUSTMENT",
        sessionVersion: 1,
        finalImageId: context.finalImageId,
      });
      expect(
        new DrizzleFeedbackRepository(context.database.db).listByRecipe(context.recipeId),
      ).toHaveLength(1);
      expect(
        new DrizzleRecipeRepository(context.database.db).listExperimentMemories(context.recipeId),
      ).toHaveLength(1);
      expect(
        new DrizzleRecipeRepository(context.database.db).listDecisionEvents(context.sessionId),
      ).toEqual([expect.objectContaining({ type: "feedback_saved" })]);
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "ADJUSTMENT",
        version: 1,
        selectedRecipeId: context.recipeId,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("persists an accepted feedback and completes the session without a provider", async () => {
    const context = createFeedbackContext();

    try {
      const result = await saveFeedback(createDependencies(context.database), {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: 0,
        recipeId: context.recipeId,
        feedback: {
          rating: 5,
          accepted: true,
          deltas: { sweetness: 0, acidity: 0, alcoholIntensity: 0, body: 0 },
          finalImageId: null,
        },
      });

      expect(result).toMatchObject({
        sessionId: context.sessionId,
        state: "COMPLETED",
        sessionVersion: 1,
        finalImageId: null,
      });
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "COMPLETED",
        version: 1,
      });
      expect(
        new DrizzleFeedbackRepository(context.database.db).listByRecipe(context.recipeId),
      ).toHaveLength(1);
      expect(
        new DrizzleRecipeRepository(context.database.db).listExperimentMemories(context.recipeId),
      ).toHaveLength(1);
    } finally {
      context.database.cleanup();
    }
  });

  it("replays the same save-feedback request without duplicating any record", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const requestId = randomUUID();
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: 0,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    };

    try {
      const first = await saveFeedback(createDependencies(context.database), input);
      const replay = await saveFeedback(createDependencies(context.database), input);

      expect(replay).toEqual(first);
      expect(
        new DrizzleFeedbackRepository(context.database.db).listByRecipe(context.recipeId),
      ).toHaveLength(1);
      expect(
        new DrizzleRecipeRepository(context.database.db).listExperimentMemories(context.recipeId),
      ).toHaveLength(1);
      expect(
        new DrizzleRecipeRepository(context.database.db).listDecisionEvents(context.sessionId),
      ).toHaveLength(1);
    } finally {
      context.database.cleanup();
    }
  });

  it("rolls back feedback, memory, event, and session state when a transaction write fails", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();

    try {
      await expect(
        saveFeedback(createDependencies(context.database, { failMemory: true }), {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: 0,
          recipeId: context.recipeId,
          feedback: fixtures.feedback,
        }),
      ).rejects.toThrow("TEST_MEMORY_WRITE_FAILED");

      expect(
        new DrizzleFeedbackRepository(context.database.db).listByRecipe(context.recipeId),
      ).toHaveLength(0);
      expect(
        new DrizzleRecipeRepository(context.database.db).listExperimentMemories(context.recipeId),
      ).toHaveLength(0);
      expect(
        new DrizzleRecipeRepository(context.database.db).listDecisionEvents(context.sessionId),
      ).toHaveLength(0);
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "FEEDBACK",
        version: 0,
        selectedRecipeId: context.recipeId,
      });
    } finally {
      context.database.cleanup();
    }
  });
});

describe("generate-adjustment application", () => {
  it("creates a proposed V2 while retaining the accepted V1 as current in ADJUSTMENT", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackResult = await saveFeedback(createDependencies(context.database), {
      sessionId: context.sessionId,
      requestId: randomUUID(),
      expectedVersion: 0,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    const providerCalls: unknown[] = [];
    const proposed = adjustmentCandidate(fixtures.recipes[0]);

    try {
      const result = await generateAdjustment(
        {
          read: () => ({
            findSessionById: (id: string) =>
              new DrizzleSessionRepository(context.database.db).findById(id),
            findIdempotencyRecordByRequestId: (requestId: string) =>
              new DrizzleSessionRepository(context.database.db).findIdempotencyRecordByRequestId(
                requestId,
              ),
            findRecipeById: (id: string) =>
              new DrizzleRecipeRepository(context.database.db).findById(id),
            listRecipesBySession: (sessionId: string) =>
              new DrizzleRecipeRepository(context.database.db).listBySession(sessionId),
            findRecipeSetById: (id: string) =>
              new DrizzleRecipeRepository(context.database.db).findSetById(id),
            listRecipesBySet: (recipeSetId: string) =>
              new DrizzleRecipeRepository(context.database.db).listBySet(recipeSetId),
            listRecipeVersionChain: (recipeId: string) =>
              new DrizzleRecipeRepository(context.database.db).listRecipeVersionChain(recipeId),
            findFeedbackById: (id: string) =>
              new DrizzleFeedbackRepository(context.database.db).findById(id),
            listFeedbackByRecipe: (recipeId: string) =>
              new DrizzleFeedbackRepository(context.database.db).listByRecipe(recipeId),
            listIngredientsBySession: (sessionId: string) =>
              new DrizzleIngredientRepository(context.database.db).listBySession(sessionId),
            listSafetyDecisionsBySet: (recipeSetId: string) =>
              new DrizzleRecipeRepository(context.database.db).listSafetyDecisionsBySet(
                recipeSetId,
              ),
            listExperimentMemories: (recipeId: string) =>
              new DrizzleRecipeRepository(context.database.db).listExperimentMemories(recipeId),
            findImageById: (id: string) =>
              new DrizzleImageUploadRepository(context.database.db).findImageById(id),
          }),
          transaction: (operation) =>
            withTransaction(context.database.db, (transaction) => {
              const sessionRepository = new DrizzleSessionRepository(transaction);
              const recipeRepository = new DrizzleRecipeRepository(transaction);
              const feedbackRepository = new DrizzleFeedbackRepository(transaction);
              const eventRepository = new DrizzleDecisionEventRepository(transaction);
              return operation({
                findSessionById: (id: string) => sessionRepository.findById(id),
                findIdempotencyRecordByRequestId: (requestId: string) =>
                  sessionRepository.findIdempotencyRecordByRequestId(requestId),
                findRecipeById: (id: string) => recipeRepository.findById(id),
                listRecipesBySession: (sessionId: string) =>
                  recipeRepository.listBySession(sessionId),
                findRecipeSetById: (id: string) => recipeRepository.findSetById(id),
                listRecipesBySet: (recipeSetId: string) => recipeRepository.listBySet(recipeSetId),
                listRecipeVersionChain: (recipeId: string) =>
                  recipeRepository.listRecipeVersionChain(recipeId),
                findFeedbackById: (id: string) => feedbackRepository.findById(id),
                listFeedbackByRecipe: (recipeId: string) =>
                  feedbackRepository.listByRecipe(recipeId),
                listIngredientsBySession: (sessionId: string) =>
                  new DrizzleIngredientRepository(transaction).listBySession(sessionId),
                listSafetyDecisionsBySet: (recipeSetId: string) =>
                  recipeRepository.listSafetyDecisionsBySet(recipeSetId),
                listExperimentMemories: (recipeId: string) =>
                  recipeRepository.listExperimentMemories(recipeId),
                findImageById: (id: string) =>
                  new DrizzleImageUploadRepository(transaction).findImageById(id),
                acquireSessionMutationLease: (
                  input: Parameters<DrizzleSessionRepository["acquireSessionMutationLease"]>[0],
                ) => sessionRepository.acquireSessionMutationLease(input),
                assertSessionMutationLease: (
                  input: Parameters<DrizzleSessionRepository["assertSessionMutationLease"]>[0],
                ) => sessionRepository.assertSessionMutationLease(input),
                renewSessionMutationLease: (
                  input: Parameters<DrizzleSessionRepository["renewSessionMutationLease"]>[0],
                ) => sessionRepository.renewSessionMutationLease(input),
                releaseSessionMutationLease: (
                  input: Parameters<DrizzleSessionRepository["releaseSessionMutationLease"]>[0],
                ) => sessionRepository.releaseSessionMutationLease(input),
                updateVersion: (input: Parameters<DrizzleSessionRepository["updateVersion"]>[0]) =>
                  sessionRepository.updateVersion(input),
                saveIdempotencyRecord: (
                  input: Parameters<DrizzleSessionRepository["saveIdempotencyRecord"]>[0],
                ) => sessionRepository.saveIdempotencyRecord(input),
                acquireIdempotencyLease: (
                  input: Parameters<DrizzleSessionRepository["acquireIdempotencyLease"]>[0],
                ) => sessionRepository.acquireIdempotencyLease(input),
                assertIdempotencyLease: (
                  input: Parameters<DrizzleSessionRepository["assertIdempotencyLease"]>[0],
                ) => sessionRepository.assertIdempotencyLease(input),
                renewIdempotencyLease: (
                  input: Parameters<DrizzleSessionRepository["renewIdempotencyLease"]>[0],
                ) => sessionRepository.renewIdempotencyLease(input),
                completeIdempotencyRecord: (
                  input: Parameters<DrizzleSessionRepository["completeIdempotencyRecord"]>[0],
                ) => sessionRepository.completeIdempotencyRecord(input),
                deleteIdempotencyRecord: (
                  input: Parameters<DrizzleSessionRepository["deleteIdempotencyRecord"]>[0],
                ) => sessionRepository.deleteIdempotencyRecord(input),
                createFeedback: (input: Parameters<DrizzleFeedbackRepository["create"]>[0]) =>
                  feedbackRepository.create(input),
                createSingleRecipeSet: (
                  input: Parameters<DrizzleRecipeRepository["createSingleRecipeSet"]>[0],
                ) => recipeRepository.createSingleRecipeSet(input),
                createSafetyDecision: (
                  input: Parameters<DrizzleRecipeRepository["createSafetyDecision"]>[0],
                ) => recipeRepository.createSafetyDecision(input),
                createExperimentMemory: (
                  input: Parameters<DrizzleRecipeRepository["createExperimentMemory"]>[0],
                ) => recipeRepository.createExperimentMemory(input),
                createDecisionEvent: (
                  input: Parameters<DrizzleDecisionEventRepository["createDecisionEvent"]>[0],
                ) => eventRepository.createDecisionEvent(input),
              });
            }),
          primaryProvider: {
            async generate() {
              throw new Error("TEST_GENERATE_NOT_USED");
            },
            async adjust(input: unknown) {
              providerCalls.push(input);
              return proposed;
            },
          },
          fallbackProvider: {
            async generate() {
              throw new Error("TEST_GENERATE_NOT_USED");
            },
            async adjust() {
              return proposed;
            },
          },
        },
        {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: feedbackResult.sessionVersion,
          feedbackId: feedbackResult.feedbackId,
        },
      );

      expect(result.state).toBe("ADJUSTMENT");
      expect(result.proposedRecipe.version).toBe(2);
      expect(result.proposedRecipe.parentRecipeId).toBe(context.recipeId);
      expect(result.proposedRecipe.feedbackId).toBe(feedbackResult.feedbackId);
      expect(providerCalls).toHaveLength(1);
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "ADJUSTMENT",
        selectedRecipeId: context.recipeId,
        currentStep: null,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("overwrites provider safety hints and replays the same proposal without another provider call", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackResult = await saveFeedback(createDependencies(context.database), {
      sessionId: context.sessionId,
      requestId: randomUUID(),
      expectedVersion: 0,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    const calls = { count: 0 };
    const provider = makeAdjustmentProvider(
      (input) =>
        RecipeCandidateSchema.parse({
          ...input.currentRecipe,
          id: randomUUID(),
          title: `${input.currentRecipe.title}·模型提示`,
          materials: [{ name: "白酒", amountMl: 20, unit: "ml" }],
          estimatedAbv: 99,
          safetyLevel: "BLOCK",
        }),
      calls,
    );
    const dependencies = createRealAdjustmentDependencies(context.database, provider);
    const requestId = randomUUID();

    try {
      const first = await generateAdjustment(dependencies, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: feedbackResult.sessionVersion,
        feedbackId: feedbackResult.feedbackId,
      });
      const replay = await generateAdjustment(dependencies, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: feedbackResult.sessionVersion,
        feedbackId: feedbackResult.feedbackId,
      });

      expect(first).toEqual(replay);
      expect(first.proposedRecipe.candidate.safetyLevel).toBe("ALLOW");
      expect(first.proposedRecipe.candidate.estimatedAbv).toBe(52);
      expect(first.safety.level).toBe("ALLOW");
      expect(calls.count).toBe(1);
      expect(
        new DrizzleRecipeRepository(context.database.db).listBySession(context.sessionId),
      ).toHaveLength(4);
    } finally {
      context.database.cleanup();
    }
  });

  it("allows only one in-flight adjustment mutation for the same expected version", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackResult = await saveFeedback(createDependencies(context.database), {
      sessionId: context.sessionId,
      requestId: randomUUID(),
      expectedVersion: 0,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    const proposed = adjustmentCandidate(fixtures.recipes[0]);
    const calls = { count: 0 };
    let markProviderStarted: (() => void) | undefined;
    const providerStarted = new Promise<void>((resolve) => {
      markProviderStarted = resolve;
    });
    let releaseProvider: (() => void) | undefined;
    const providerGate = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const provider: RecipeProvider = {
      async generate() {
        throw new Error("TEST_GENERATE_NOT_USED");
      },
      async adjust(input) {
        calls.count += 1;
        markProviderStarted?.();
        await providerGate;
        return RecipeCandidateSchema.parse({
          ...proposed,
          id: randomUUID(),
          title: `${input.currentRecipe.title}·并发调整`,
        });
      },
    };
    const dependencies = {
      ...createRealAdjustmentDependencies(context.database, provider),
    };

    try {
      const firstPromise = generateAdjustment(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: feedbackResult.sessionVersion,
        feedbackId: feedbackResult.feedbackId,
      });
      await providerStarted;
      await expect(
        generateAdjustment(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: feedbackResult.sessionVersion,
          feedbackId: feedbackResult.feedbackId,
        }),
      ).rejects.toBeInstanceOf(SessionMutationInProgressError);
      releaseProvider?.();
      await firstPromise;

      expect(calls.count).toBe(1);
      expect(
        new DrizzleRecipeRepository(context.database.db).listBySession(context.sessionId),
      ).toHaveLength(4);
    } finally {
      releaseProvider?.();
      context.database.cleanup();
    }
  });

  it("cleans up a failed provider attempt so the same request can retry", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackResult = await saveFeedback(createDependencies(context.database), {
      sessionId: context.sessionId,
      requestId: randomUUID(),
      expectedVersion: 0,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    const requestId = randomUUID();
    let calls = 0;
    const provider: RecipeProvider = {
      async generate() {
        throw new Error("TEST_GENERATE_NOT_USED");
      },
      async adjust(input) {
        calls += 1;
        if (calls === 1) {
          throw new Error("TEST_PROVIDER_503");
        }
        return RecipeCandidateSchema.parse({
          ...input.currentRecipe,
          id: randomUUID(),
          title: `${input.currentRecipe.title}·重试成功`,
          materials: [{ name: "白酒", amountMl: 20, unit: "ml" }],
        });
      },
    };
    const dependencies = createRealAdjustmentDependencies(context.database, provider);

    try {
      await expect(
        generateAdjustment(dependencies, {
          sessionId: context.sessionId,
          requestId,
          expectedVersion: feedbackResult.sessionVersion,
          feedbackId: feedbackResult.feedbackId,
        }),
      ).rejects.toThrow("PROVIDER_UNAVAILABLE");
      expect(
        new DrizzleRecipeRepository(context.database.db).listBySession(context.sessionId),
      ).toHaveLength(3);
      const retry = await generateAdjustment(dependencies, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: feedbackResult.sessionVersion,
        feedbackId: feedbackResult.feedbackId,
      });
      expect(retry.proposedRecipe.version).toBe(2);
      expect(calls).toBe(2);
    } finally {
      context.database.cleanup();
    }
  });

  it("supports a second feedback cycle as V2 to V3 after explicit acceptance", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const firstFeedback = await saveFeedback(createDependencies(context.database), {
      sessionId: context.sessionId,
      requestId: randomUUID(),
      expectedVersion: 0,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    const calls = { count: 0 };
    const provider = makeAdjustmentProvider(
      (input) =>
        RecipeCandidateSchema.parse({
          ...input.currentRecipe,
          id: randomUUID(),
          title: `${input.currentRecipe.title}·第${calls.count}轮`,
          materials: [{ name: "白酒", amountMl: Math.max(5, 30 - calls.count * 5), unit: "ml" }],
          estimatedAbv: null,
          safetyLevel: "WARN",
        }),
      calls,
    );
    const dependencies = createRealAdjustmentDependencies(context.database, provider);

    try {
      const firstProposal = await generateAdjustment(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: firstFeedback.sessionVersion,
        feedbackId: firstFeedback.feedbackId,
      });
      const accepted = acceptAdjustment(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: firstProposal.sessionVersion,
        proposedRecipeId: firstProposal.proposedRecipe.recipeId,
      });
      context.database.sqlite
        .prepare("UPDATE sessions SET state = 'FEEDBACK', current_step = NULL WHERE id = ?")
        .run(context.sessionId);
      const secondFeedback = await saveFeedback(createDependencies(context.database), {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: accepted.sessionVersion,
        recipeId: accepted.currentRecipeId,
        feedback: {
          ...fixtures.feedback,
          deltas: { sweetness: 0, acidity: 1, alcoholIntensity: -1, body: 0 },
        },
      });
      const secondProposal = await generateAdjustment(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: secondFeedback.sessionVersion,
        feedbackId: secondFeedback.feedbackId,
      });
      const chain = new DrizzleRecipeRepository(context.database.db).listRecipeVersionChain(
        secondProposal.proposedRecipe.recipeId,
      );

      expect(chain.map((recipe) => recipe.version)).toEqual([1, 2, 3]);
      expect(secondProposal.proposedRecipe.parentRecipeId).toBe(accepted.currentRecipeId);
      expect(secondProposal.proposedRecipe.feedbackId).toBe(secondFeedback.feedbackId);
      expect(secondProposal.state).toBe("ADJUSTMENT");
      expect(
        new DrizzleRecipeRepository(context.database.db).listBySession(context.sessionId),
      ).toHaveLength(5);
    } finally {
      context.database.cleanup();
    }
  });

  it("does not persist a proposal when deterministic Safety remains BLOCK", async () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackResult = await saveFeedback(createDependencies(context.database), {
      sessionId: context.sessionId,
      requestId: randomUUID(),
      expectedVersion: 0,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    const calls = { count: 0 };
    const provider = makeAdjustmentProvider(
      (input) =>
        RecipeCandidateSchema.parse({
          ...input.currentRecipe,
          id: randomUUID(),
          title: `${input.currentRecipe.title}·危险候选`,
          safetyLevel: "ALLOW",
        }),
      calls,
    );
    const dependencies = createRealAdjustmentDependencies(context.database, provider, () => ({
      level: "BLOCK",
      estimatedFinalAbv: 99,
      pureAlcoholMl: 99,
      hits: [],
    }));

    try {
      await expect(
        generateAdjustment(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: feedbackResult.sessionVersion,
          feedbackId: feedbackResult.feedbackId,
        }),
      ).rejects.toBeInstanceOf(AdjustmentSafetyBlockedError);
      expect(calls.count).toBeGreaterThan(0);
      expect(
        new DrizzleRecipeRepository(context.database.db).listBySession(context.sessionId),
      ).toHaveLength(3);
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "ADJUSTMENT",
        selectedRecipeId: context.recipeId,
        version: feedbackResult.sessionVersion,
      });
    } finally {
      context.database.cleanup();
    }
  });
});

describe("accept-adjustment application", () => {
  it("accepts the direct V2 proposal and moves the session into MIXING", () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const recipeRepository = new DrizzleRecipeRepository(context.database.db);
    const feedbackRepository = new DrizzleFeedbackRepository(context.database.db);
    const feedbackId = randomUUID();
    feedbackRepository.create({
      id: feedbackId,
      sessionId: context.sessionId,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    context.database.sqlite
      .prepare(
        "UPDATE sessions SET state = 'ADJUSTMENT', version = 0, current_step = NULL WHERE id = ?",
      )
      .run(context.sessionId);
    const proposalSetId = randomUUID();
    const proposal = recipeRepository.createSingleRecipeSet({
      recipeSet: { id: proposalSetId, sessionId: context.sessionId, sourceMode: "fallback" },
      recipe: {
        recipeSetId: proposalSetId,
        sessionId: context.sessionId,
        candidate: RecipeCandidateSchema.parse({
          ...adjustmentCandidate(fixtures.recipes[0]),
          safetyLevel: "ALLOW",
        }),
        version: 2,
        parentRecipeId: context.recipeId,
        feedbackId,
      },
    });
    recipeRepository.createSafetyDecision({
      recipeId: proposal.id,
      level: proposal.safetyLevel,
      ruleHits: [],
      engineVersion: "1.0.0",
    });

    const requestId = randomUUID();
    try {
      const result = acceptAdjustment(createAdjustmentUnitOfWork(context.database.db), {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: 0,
        proposedRecipeId: proposal.id,
      });
      const replay = acceptAdjustment(createAdjustmentUnitOfWork(context.database.db), {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: 0,
        proposedRecipeId: proposal.id,
      });

      expect(result).toMatchObject({
        sessionId: context.sessionId,
        state: "MIXING",
        currentRecipeId: proposal.id,
        sessionVersion: 1,
      });
      expect(replay).toEqual(result);
      expect(
        new DrizzleRecipeRepository(context.database.db).listDecisionEvents(context.sessionId),
      ).toHaveLength(1);
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "MIXING",
        version: 1,
        selectedRecipeId: proposal.id,
        currentStep: 0,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects sibling proposals for the same parent and feedback without changing state", () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const recipeRepository = new DrizzleRecipeRepository(context.database.db);
    const feedbackId = randomUUID();
    new DrizzleFeedbackRepository(context.database.db).create({
      id: feedbackId,
      sessionId: context.sessionId,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    context.database.sqlite
      .prepare(
        "UPDATE sessions SET state = 'ADJUSTMENT', version = 0, current_step = 2 WHERE id = ?",
      )
      .run(context.sessionId);

    const createProposal = () => {
      const proposalSetId = randomUUID();
      const proposal = recipeRepository.createSingleRecipeSet({
        recipeSet: { id: proposalSetId, sessionId: context.sessionId, sourceMode: "fallback" },
        recipe: {
          recipeSetId: proposalSetId,
          sessionId: context.sessionId,
          candidate: RecipeCandidateSchema.parse({
            ...adjustmentCandidate(fixtures.recipes[0]),
            safetyLevel: "ALLOW",
          }),
          version: 2,
          parentRecipeId: context.recipeId,
          feedbackId,
        },
      });
      recipeRepository.createSafetyDecision({
        recipeId: proposal.id,
        level: proposal.safetyLevel,
        ruleHits: [],
        engineVersion: "1.0.0",
      });
      return proposal;
    };
    const firstProposal = createProposal();
    createProposal();

    try {
      expect(() =>
        acceptAdjustment(createAdjustmentUnitOfWork(context.database.db), {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: 0,
          proposedRecipeId: firstProposal.id,
        }),
      ).toThrow(AdjustmentProposalInvalidError);
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "ADJUSTMENT",
        version: 0,
        selectedRecipeId: context.recipeId,
        currentStep: 2,
      });
      expect(
        new DrizzleRecipeRepository(context.database.db).listBySession(context.sessionId),
      ).toHaveLength(5);
      expect(
        new DrizzleRecipeRepository(context.database.db).listDecisionEvents(context.sessionId),
      ).toHaveLength(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects a proposal from another session and rejects the wrong phase", () => {
    const first = createFeedbackContext();
    const second = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackId = randomUUID();
    new DrizzleFeedbackRepository(first.database.db).create({
      id: feedbackId,
      sessionId: first.sessionId,
      recipeId: first.recipeId,
      feedback: fixtures.feedback,
    });
    const proposalSetId = randomUUID();
    const proposal = new DrizzleRecipeRepository(first.database.db).createSingleRecipeSet({
      recipeSet: { id: proposalSetId, sessionId: first.sessionId, sourceMode: "fallback" },
      recipe: {
        recipeSetId: proposalSetId,
        sessionId: first.sessionId,
        candidate: RecipeCandidateSchema.parse({
          ...adjustmentCandidate(fixtures.recipes[0]),
          safetyLevel: "ALLOW",
        }),
        version: 2,
        parentRecipeId: first.recipeId,
        feedbackId,
      },
    });
    new DrizzleRecipeRepository(first.database.db).createSafetyDecision({
      recipeId: proposal.id,
      level: proposal.safetyLevel,
      ruleHits: [],
      engineVersion: "1.0.0",
    });
    first.database.sqlite
      .prepare("UPDATE sessions SET state = 'ADJUSTMENT', version = 0 WHERE id = ?")
      .run(first.sessionId);
    second.database.sqlite
      .prepare("UPDATE sessions SET state = 'ADJUSTMENT', version = 0 WHERE id = ?")
      .run(second.sessionId);

    try {
      expect(() =>
        acceptAdjustment(createAdjustmentUnitOfWork(second.database.db), {
          sessionId: second.sessionId,
          requestId: randomUUID(),
          expectedVersion: 0,
          proposedRecipeId: proposal.id,
        }),
      ).toThrow();
      expect(() =>
        acceptAdjustment(createAdjustmentUnitOfWork(first.database.db), {
          sessionId: first.sessionId,
          requestId: randomUUID(),
          expectedVersion: 0,
          proposedRecipeId: proposal.id,
        }),
      ).not.toThrow();
    } finally {
      first.database.cleanup();
      second.database.cleanup();
    }
  });

  it("rejects a proposal that is not the direct next version", () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const recipeRepository = new DrizzleRecipeRepository(context.database.db);
    const feedbackId = randomUUID();
    new DrizzleFeedbackRepository(context.database.db).create({
      id: feedbackId,
      sessionId: context.sessionId,
      recipeId: context.recipeId,
      feedback: fixtures.feedback,
    });
    const unrelatedRecipe = recipeRepository
      .listBySession(context.sessionId)
      .find((recipe) => recipe.id !== context.recipeId);
    if (unrelatedRecipe === undefined) {
      throw new Error("TEST_UNRELATED_RECIPE_MISSING");
    }
    const proposalSetId = randomUUID();
    const proposal = recipeRepository.createSingleRecipeSet({
      recipeSet: { id: proposalSetId, sessionId: context.sessionId, sourceMode: "fallback" },
      recipe: {
        recipeSetId: proposalSetId,
        sessionId: context.sessionId,
        candidate: RecipeCandidateSchema.parse({
          ...adjustmentCandidate(fixtures.recipes[0]),
          safetyLevel: "ALLOW",
        }),
        version: 2,
        parentRecipeId: unrelatedRecipe.id,
        feedbackId,
      },
    });
    recipeRepository.createSafetyDecision({
      recipeId: proposal.id,
      level: proposal.safetyLevel,
      ruleHits: [],
      engineVersion: "1.0.0",
    });
    context.database.sqlite
      .prepare("UPDATE sessions SET state = 'ADJUSTMENT', version = 0 WHERE id = ?")
      .run(context.sessionId);

    try {
      expect(() =>
        acceptAdjustment(createAdjustmentUnitOfWork(context.database.db), {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: 0,
          proposedRecipeId: proposal.id,
        }),
      ).toThrow();
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "ADJUSTMENT",
        version: 0,
        selectedRecipeId: context.recipeId,
      });
    } finally {
      context.database.cleanup();
    }
  });
});

describe("complete-session application", () => {
  it("completes a FEEDBACK session when the current recipe has accepted feedback", () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackId = randomUUID();
    new DrizzleFeedbackRepository(context.database.db).create({
      id: feedbackId,
      sessionId: context.sessionId,
      recipeId: context.recipeId,
      feedback: {
        ...fixtures.feedback,
        accepted: true,
        rating: 5,
        deltas: { sweetness: 0, acidity: 0, alcoholIntensity: 0, body: 0 },
      },
    });
    context.database.sqlite
      .prepare(
        "UPDATE sessions SET state = 'FEEDBACK', version = 0, current_step = NULL WHERE id = ?",
      )
      .run(context.sessionId);

    try {
      const result = completeSession(createAdjustmentUnitOfWork(context.database.db), {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: 0,
        feedbackId,
      });

      expect(result).toMatchObject({
        sessionId: context.sessionId,
        state: "COMPLETED",
        sessionVersion: 1,
        currentRecipeId: context.recipeId,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("completes an ADJUSTMENT session without accepting a pending proposal", () => {
    const context = createFeedbackContext();
    const fixtures = makeDomainFixtures();
    const feedbackRepository = new DrizzleFeedbackRepository(context.database.db);
    const recipeRepository = new DrizzleRecipeRepository(context.database.db);
    const pendingFeedbackId = randomUUID();
    const acceptedFeedbackId = randomUUID();

    feedbackRepository.create({
      id: pendingFeedbackId,
      sessionId: context.sessionId,
      recipeId: context.recipeId,
      feedback: {
        ...fixtures.feedback,
        accepted: false,
      },
    });
    feedbackRepository.create({
      id: acceptedFeedbackId,
      sessionId: context.sessionId,
      recipeId: context.recipeId,
      feedback: {
        ...fixtures.feedback,
        accepted: true,
        rating: 5,
        deltas: { sweetness: 0, acidity: 0, alcoholIntensity: 0, body: 0 },
      },
    });

    const proposalSetId = randomUUID();
    const proposal = recipeRepository.createSingleRecipeSet({
      recipeSet: { id: proposalSetId, sessionId: context.sessionId, sourceMode: "fallback" },
      recipe: {
        recipeSetId: proposalSetId,
        sessionId: context.sessionId,
        candidate: RecipeCandidateSchema.parse({
          ...adjustmentCandidate(fixtures.recipes[0]),
          safetyLevel: "ALLOW",
        }),
        version: 2,
        parentRecipeId: context.recipeId,
        feedbackId: pendingFeedbackId,
      },
    });
    recipeRepository.createSafetyDecision({
      recipeId: proposal.id,
      level: proposal.safetyLevel,
      ruleHits: [],
      engineVersion: "1.0.0",
    });
    context.database.sqlite
      .prepare(
        "UPDATE sessions SET state = 'ADJUSTMENT', version = 0, current_step = 3 WHERE id = ?",
      )
      .run(context.sessionId);

    try {
      const result = completeSession(createAdjustmentUnitOfWork(context.database.db), {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: 0,
        feedbackId: acceptedFeedbackId,
      });

      expect(result).toMatchObject({
        sessionId: context.sessionId,
        state: "COMPLETED",
        sessionVersion: 1,
        currentRecipeId: context.recipeId,
      });
      expect(
        new DrizzleSessionRepository(context.database.db).findById(context.sessionId),
      ).toMatchObject({
        state: "COMPLETED",
        selectedRecipeId: context.recipeId,
        currentStep: null,
      });
      expect(new DrizzleRecipeRepository(context.database.db).findById(proposal.id)).not.toBeNull();
    } finally {
      context.database.cleanup();
    }
  });
});
