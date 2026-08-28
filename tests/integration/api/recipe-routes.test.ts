import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import { recognizeIngredients } from "@/src/application/recognize-ingredients";
import { confirmIngredients } from "@/src/application/confirm-ingredients";
import { createRecipeGenerationRouteHandlers } from "@/app/api/sessions/[sessionId]/recipes/route";
import { createRecipeSelectionRouteHandlers } from "@/app/api/sessions/[sessionId]/selection/route";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
import type {
  GenerateRecipeSetDependencies,
  GenerateRecipeSetReadRepository,
  GenerateRecipeSetTransactionRepository,
} from "@/src/application/generate-recipe-set";
import type {
  SelectRecipeDependencies,
  SelectRecipeReadRepository,
  SelectRecipeTransactionRepository,
} from "@/src/application/select-recipe";
import { RecipeCandidateSchema, RecipeCandidateSetSchema } from "@/src/domain/recipe";
import { withTransaction, type DatabaseExecutor } from "@/src/infrastructure/db/transaction";
import {
  decisionEvents,
  idempotencyRecords,
  images,
  recipeSets,
  recipes,
  safetyDecisions,
  sessions,
} from "@/src/infrastructure/db/schema";
import { DrizzleIngredientRepository } from "@/src/infrastructure/repositories/drizzle-ingredient-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { evaluateRecipeCandidateSafety } from "@/src/application/repair-blocked-recipe";
import { evaluateSafety } from "@/src/safety/evaluate-safety";
import type {
  QwenCompletionClient,
  QwenCompletionRequest,
  RecipeCandidate,
  RecipeCandidateSet,
  RecipeProvider,
} from "@/src/providers/recipe-provider";
import { QwenRecipeProvider } from "@/src/infrastructure/providers/qwen-recipe-provider";
import type { VisionProvider, VisionResult } from "@/src/providers/vision-provider";
import { makeDomainFixtures } from "@/tests/fixtures/domain";
import { createTestDatabase, type TestDatabase } from "@/tests/helpers/test-database";

const recognitionResult: VisionResult = {
  ingredients: [
    {
      rawName: "二锅头",
      canonicalName: "白酒",
      category: "spirit",
      brand: "示例白酒",
      abv: 52,
      confidence: 0.95,
      confirmed: false,
    },
    {
      rawName: "苏打水",
      canonicalName: "苏打水",
      category: "mixer",
      brand: null,
      abv: null,
      confidence: 0.94,
      confirmed: false,
    },
  ],
  needsLabelCloseup: false,
  userQuestions: [],
  sourceMode: "fallback",
};

const confirmedIngredients = recognitionResult.ingredients.map((ingredient) => ({
  ...ingredient,
  confirmed: true,
}));

class StaticVisionProvider implements VisionProvider {
  async recognize(): Promise<VisionResult> {
    return recognitionResult;
  }
}

class RecordingRecipeProvider implements RecipeProvider {
  generateCalls = 0;
  adjustCalls = 0;

  constructor(
    private readonly generateResult: RecipeCandidateSet,
    private readonly adjustResult?: RecipeCandidate,
  ) {}

  async generate(): Promise<RecipeCandidateSet> {
    this.generateCalls += 1;
    return this.generateResult;
  }

  async adjust(): Promise<RecipeCandidate> {
    this.adjustCalls += 1;
    return this.adjustResult ?? this.generateResult.recipes[0];
  }
}

class ScriptedQwenCompletionClient implements QwenCompletionClient {
  readonly requests: QwenCompletionRequest[] = [];

  constructor(private readonly responses: readonly string[]) {}

  async complete(request: QwenCompletionRequest): Promise<string> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) {
      throw new Error("UNEXPECTED_QWEN_REQUEST");
    }
    return response;
  }
}

function baseCandidateSet(): RecipeCandidateSet {
  const fixtures = makeDomainFixtures();
  const seeded = RecipeCandidateSetSchema.parse({
    recipes: fixtures.recipes,
    recommendedRecipeId: fixtures.recipes[0].id,
  });
  const recipes: RecipeCandidateSet["recipes"] = seeded.recipes.map((recipe, index) => ({
    ...recipe,
    materials:
      index === 0
        ? [
            { name: "白酒", amountMl: 30, unit: "ml" as const },
            { name: "苏打水", amountMl: 90, unit: "ml" as const },
          ]
        : [
            { name: "白酒", amountMl: 30 + index * 5, unit: "ml" as const },
            { name: index === 1 ? "苏打水" : "柠檬", amountMl: 80, unit: "ml" as const },
          ],
    missingIngredients: index === 2 ? ["柠檬"] : [],
  }));

  return RecipeCandidateSetSchema.parse({
    recipes,
    recommendedRecipeId: recipes[0].id,
  });
}

function jsonRequest(body: unknown, method: "POST" | "PUT" = "POST") {
  return new Request("http://localhost/api/sessions/test", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createGenerateDependencies(
  database: TestDatabase,
  primaryProvider: RecipeProvider,
  fallbackProvider: RecipeProvider,
): GenerateRecipeSetDependencies {
  return {
    read: () => {
      const sessionRepository = new DrizzleSessionRepository(database.db);
      const ingredientRepository = new DrizzleIngredientRepository(database.db);
      const recipeRepository = new DrizzleRecipeRepository(database.db);
      const repository: GenerateRecipeSetReadRepository = {
        create: (input) => sessionRepository.create(input),
        findById: (id) => sessionRepository.findById(id),
        updateVersion: (input) => sessionRepository.updateVersion(input),
        saveIdempotencyRecord: (input) => sessionRepository.saveIdempotencyRecord(input),
        findIdempotencyRecord: (sessionId, requestId) =>
          sessionRepository.findIdempotencyRecord(sessionId, requestId),
        findIdempotencyRecordByRequestId: (requestId) =>
          sessionRepository.findIdempotencyRecordByRequestId(requestId),
        listBySession: (sessionId) => ingredientRepository.listBySession(sessionId),
        replaceForSession: (input) => ingredientRepository.replaceForSession(input),
        findSetBySession: (sessionId) => recipeRepository.findSetBySession(sessionId),
        listBySet: (recipeSetId) => recipeRepository.listBySet(recipeSetId),
        listSafetyDecisionsBySet: (recipeSetId) =>
          recipeRepository.listSafetyDecisionsBySet(recipeSetId),
        listDecisionEvents: (sessionId) => recipeRepository.listDecisionEvents(sessionId),
      };
      return repository;
    },
    transaction: (operation) =>
      withTransaction(database.db, (transaction) =>
        operation(createGenerateTransactionRepository(transaction)),
      ),
    primaryProvider,
    fallbackProvider,
  };
}

function createGenerateTransactionRepository(database: DatabaseExecutor) {
  const sessionRepository = new DrizzleSessionRepository(database);
  const ingredientRepository = new DrizzleIngredientRepository(database);
  const recipeRepository = new DrizzleRecipeRepository(database);

  const repository: GenerateRecipeSetTransactionRepository = {
    create: (input: Parameters<DrizzleSessionRepository["create"]>[0]) =>
      sessionRepository.create(input),
    findById: (id: string) => sessionRepository.findById(id),
    updateVersion: (input: Parameters<DrizzleSessionRepository["updateVersion"]>[0]) =>
      sessionRepository.updateVersion(input),
    saveIdempotencyRecord: (
      input: Parameters<DrizzleSessionRepository["saveIdempotencyRecord"]>[0],
    ) => sessionRepository.saveIdempotencyRecord(input),
    findIdempotencyRecord: (sessionId: string, requestId: string) =>
      sessionRepository.findIdempotencyRecord(sessionId, requestId),
    findIdempotencyRecordByRequestId: (requestId: string) =>
      sessionRepository.findIdempotencyRecordByRequestId(requestId),
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
    listBySession: (sessionId: string) => ingredientRepository.listBySession(sessionId),
    replaceForSession: (input: Parameters<DrizzleIngredientRepository["replaceForSession"]>[0]) =>
      ingredientRepository.replaceForSession(input),
    createRecipeSet: (input: Parameters<DrizzleRecipeRepository["createRecipeSet"]>[0]) =>
      recipeRepository.createRecipeSet(input),
    setRecommendedRecipe: (
      recipeSetId: Parameters<DrizzleRecipeRepository["setRecommendedRecipe"]>[0],
      recipeId: Parameters<DrizzleRecipeRepository["setRecommendedRecipe"]>[1],
    ) => recipeRepository.setRecommendedRecipe(recipeSetId, recipeId),
    createRecipe: (input: Parameters<DrizzleRecipeRepository["createRecipe"]>[0]) =>
      recipeRepository.createRecipe(input),
    createSafetyDecision: (input: {
      recipeId: string;
      level: "ALLOW" | "WARN" | "BLOCK";
      ruleHits: readonly {
        ruleId: string;
        ruleVersion: number;
        level: "ALLOW" | "WARN" | "BLOCK";
        reason: string;
        alternative?: string;
      }[];
      engineVersion: string;
    }) => {
      database
        .insert(safetyDecisions)
        .values({
          id: randomUUID(),
          recipeId: input.recipeId,
          level: input.level,
          ruleHitsJson: JSON.stringify(input.ruleHits),
          engineVersion: input.engineVersion,
        })
        .run();
    },
    createDecisionEvent: (input: {
      sessionId: string;
      event: { type: string; summary: string; metadata: Record<string, unknown> };
    }) => {
      database
        .insert(decisionEvents)
        .values({
          id: randomUUID(),
          sessionId: input.sessionId,
          eventType: input.event.type,
          summary: input.event.summary,
          metadataJson: JSON.stringify(input.event.metadata),
        })
        .run();
    },
  };
  return repository;
}

function recipePersistenceSnapshot(database: TestDatabase) {
  return {
    sessions: database.db.select().from(sessions).all(),
    recipeSets: database.db.select().from(recipeSets).all(),
    recipes: database.db.select().from(recipes).all(),
    safetyDecisions: database.db.select().from(safetyDecisions).all(),
    decisionEvents: database.db.select().from(decisionEvents).all(),
    idempotencyRecords: database.db.select().from(idempotencyRecords).all(),
  };
}

function createSelectionDependencies(database: TestDatabase): SelectRecipeDependencies {
  return {
    read: () => {
      const sessionRepository = new DrizzleSessionRepository(database.db);
      const recipeRepository = new DrizzleRecipeRepository(database.db);
      const repository: SelectRecipeReadRepository = {
        create: (input) => sessionRepository.create(input),
        findById: (id) => sessionRepository.findById(id),
        updateVersion: (input) => sessionRepository.updateVersion(input),
        saveIdempotencyRecord: (input) => sessionRepository.saveIdempotencyRecord(input),
        findIdempotencyRecord: (sessionId, requestId) =>
          sessionRepository.findIdempotencyRecord(sessionId, requestId),
        findIdempotencyRecordByRequestId: (requestId) =>
          sessionRepository.findIdempotencyRecordByRequestId(requestId),
        findSetBySession: (sessionId) => recipeRepository.findSetBySession(sessionId),
        listBySet: (recipeSetId) => recipeRepository.listBySet(recipeSetId),
        listSafetyDecisionsBySet: (recipeSetId) =>
          recipeRepository.listSafetyDecisionsBySet(recipeSetId),
      };
      return repository;
    },
    transaction: (operation) =>
      withTransaction(database.db, (transaction) => {
        const sessionRepository = new DrizzleSessionRepository(transaction);
        const recipeRepository = new DrizzleRecipeRepository(transaction);
        const repository: SelectRecipeTransactionRepository = {
          create: (input) => sessionRepository.create(input),
          findById: (id) => sessionRepository.findById(id),
          updateVersion: (input) => sessionRepository.updateVersion(input),
          saveIdempotencyRecord: (input) => sessionRepository.saveIdempotencyRecord(input),
          findIdempotencyRecord: (sessionId, requestId) =>
            sessionRepository.findIdempotencyRecord(sessionId, requestId),
          findIdempotencyRecordByRequestId: (requestId) =>
            sessionRepository.findIdempotencyRecordByRequestId(requestId),
          acquireSessionMutationLease: (input) =>
            sessionRepository.acquireSessionMutationLease(input),
          assertSessionMutationLease: (input) =>
            sessionRepository.assertSessionMutationLease(input),
          renewSessionMutationLease: (input) => sessionRepository.renewSessionMutationLease(input),
          releaseSessionMutationLease: (input) =>
            sessionRepository.releaseSessionMutationLease(input),
          findSetBySession: (sessionId) => recipeRepository.findSetBySession(sessionId),
          listBySet: (recipeSetId) => recipeRepository.listBySet(recipeSetId),
          listSafetyDecisionsBySet: (recipeSetId) =>
            recipeRepository.listSafetyDecisionsBySet(recipeSetId),
        };
        return operation(repository);
      }),
  };
}

async function createReadyRouteContext() {
  const database = createTestDatabase();
  const fixtures = makeDomainFixtures();
  const unitOfWork = createSessionUnitOfWork(database.db);
  const created = createSession(unitOfWork, { requestId: fixtures.ids.requestId });
  const savedPreferences = savePreferences(unitOfWork, {
    sessionId: created.response.session.id,
    requestId: randomUUID(),
    expectedVersion: 0,
    preferences: fixtures.tasteProfile,
  });
  const overviewImageId = randomUUID();
  database.db
    .insert(images)
    .values({
      id: overviewImageId,
      sessionId: created.response.session.id,
      role: "overview",
      objectKey: `${created.response.session.id}/overview-${overviewImageId}.jpg`,
      mime: "image/jpeg",
      width: 1280,
      height: 720,
    })
    .run();
  await recognizeIngredients(unitOfWork, new StaticVisionProvider(), {
    sessionId: created.response.session.id,
    requestId: randomUUID(),
    expectedVersion: savedPreferences.response.session.version,
    overviewImageId,
    labelImageIds: [],
  });
  const confirmed = await confirmIngredients(unitOfWork, {
    sessionId: created.response.session.id,
    requestId: randomUUID(),
    expectedVersion: 2,
    ingredients: confirmedIngredients,
  });

  return {
    database,
    sessionId: created.response.session.id,
    expectedVersion: confirmed.response.session.version,
  };
}

describe("recipe routes", () => {
  it("runs generation and selection through thin JSON handlers", async () => {
    const context = await createReadyRouteContext();
    const candidateSet = baseCandidateSet();
    const generationDependencies = createGenerateDependencies(
      context.database,
      new RecordingRecipeProvider(candidateSet),
      new RecordingRecipeProvider(candidateSet),
    );

    try {
      const generationResponse = await createRecipeGenerationRouteHandlers(
        generationDependencies,
      ).POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(generationResponse.status).toBe(201);
      const generationBody = await generationResponse.json();
      expect(generationBody.session).toMatchObject({
        state: "RECIPE_SELECTION",
        version: context.expectedVersion + 1,
      });
      expect(generationBody.data.recipeSet.degraded).toBe(false);

      const selectionResponse = await createRecipeSelectionRouteHandlers(
        createSelectionDependencies(context.database),
      ).PUT(
        jsonRequest(
          {
            requestId: randomUUID(),
            expectedVersion: generationBody.session.version,
            recipeId: generationBody.data.recipeSet.recipes[0].id,
            warningAcknowledged: true,
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(selectionResponse.status).toBe(200);
      expect((await selectionResponse.json()).session).toMatchObject({
        state: "MIXING",
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("recovers the persisted recommendedRecipeId and recipes through GET", async () => {
    const context = await createReadyRouteContext();
    const candidateSet = baseCandidateSet();
    const generationHandlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        new RecordingRecipeProvider(candidateSet),
        new RecordingRecipeProvider(candidateSet),
      ),
    );

    try {
      const generationResponse = await generationHandlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const generatedBody = await generationResponse.json();

      const getResponse = await generationHandlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      expect(getResponse.status).toBe(200);
      const getBody = await getResponse.json();
      expect(getBody.data.recipeSet.degraded).toBe(generatedBody.data.recipeSet.degraded);
      expect(getBody.data.recipeSet.provenance).toEqual(generatedBody.data.recipeSet.provenance);
      expect(getBody.data.recipeSet.recommendedRecipeId).toBe(
        generatedBody.data.recipeSet.recommendedRecipeId,
      );
      expect(
        getBody.data.recipeSet.recipes.some(
          (recipe: { id: string }) =>
            recipe.id === generatedBody.data.recipeSet.recommendedRecipeId,
        ),
      ).toBe(true);

      const persistedRecipes = context.database.db.select().from(recipes).all();
      const persistedDecisions = context.database.db.select().from(safetyDecisions).all();
      const confirmedIngredients = new DrizzleIngredientRepository(
        context.database.db,
      ).listBySession(context.sessionId);
      expect(persistedRecipes).toHaveLength(3);
      expect(new Set(persistedRecipes.map((recipe) => recipe.id)).size).toBe(3);
      expect(persistedDecisions).toHaveLength(3);
      expect(new Set(persistedDecisions.map((decision) => decision.recipeId)).size).toBe(3);
      for (const recipe of getBody.data.recipeSet.recipes) {
        const persistedDecision = persistedDecisions.find(
          (decision) => decision.recipeId === recipe.id,
        );
        expect(persistedDecision).toBeDefined();
        const candidate = { ...recipe };
        delete candidate.safety;
        expect(persistedDecision?.level).toBe(
          evaluateRecipeCandidateSafety(
            RecipeCandidateSchema.parse(candidate),
            confirmedIngredients,
            evaluateSafety,
          ).safetyDecision.level,
        );
      }
    } finally {
      context.database.cleanup();
    }
  });

  it("returns persisted safety reasons and alternatives with the recipe snapshot", async () => {
    const context = await createReadyRouteContext();
    const candidateSet = baseCandidateSet();
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        new RecordingRecipeProvider(candidateSet),
        new RecordingRecipeProvider(candidateSet),
      ),
    );

    try {
      const generated = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generated.status).toBe(201);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.data.recipeSet.recipes).toHaveLength(3);
      for (const recipe of body.data.recipeSet.recipes) {
        expect(recipe.safety).toEqual({
          level: recipe.safetyLevel,
          reasons: expect.any(Array),
          alternatives: expect.any(Array),
        });
        expect(recipe.safety.reasons.length).toBeGreaterThan(0);
      }
    } finally {
      context.database.cleanup();
    }
  });

  it("GET fails closed when one persisted Safety decision is missing without writes or Provider calls", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const recipe = context.database.db.select().from(recipes).all()[0];
      if (recipe === undefined) {
        throw new Error("TEST_RECIPE_MISSING");
      }
      context.database.db
        .delete(safetyDecisions)
        .where(eq(safetyDecisions.recipeId, recipe.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET fails closed when a Safety decision recipeId is mismatched without writes or Provider calls", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const recipeRows = context.database.db.select().from(recipes).all();
      const decisions = context.database.db.select().from(safetyDecisions).all();
      const firstRecipe = recipeRows[0];
      const secondDecision = decisions.find((decision) => decision.recipeId === recipeRows[1]?.id);
      if (firstRecipe === undefined || secondDecision === undefined) {
        throw new Error("TEST_SAFETY_FIXTURE_MISSING");
      }
      context.database.db
        .delete(safetyDecisions)
        .where(eq(safetyDecisions.recipeId, firstRecipe.id))
        .run();
      context.database.db
        .update(safetyDecisions)
        .set({ recipeId: firstRecipe.id })
        .where(eq(safetyDecisions.id, secondDecision.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET fails closed when persisted ALLOW disagrees with the current Safety BLOCK result", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const recipe = context.database.db.select().from(recipes).all()[0];
      if (recipe === undefined) {
        throw new Error("TEST_RECIPE_MISSING");
      }
      context.database.db
        .update(recipes)
        .set({
          materialsJson: JSON.stringify([
            { name: "白酒", amountMl: 30, unit: "ml" },
            { name: "能量饮料", amountMl: 80, unit: "ml" },
          ]),
        })
        .where(eq(recipes.id, recipe.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET fails closed when persisted Safety ruleHits are polluted but the level is unchanged", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const decision = context.database.db.select().from(safetyDecisions).all()[0];
      if (decision === undefined) {
        throw new Error("TEST_SAFETY_DECISION_MISSING");
      }
      const pollutedRuleHits = JSON.parse(decision.ruleHitsJson) as Array<Record<string, unknown>>;
      pollutedRuleHits.push({
        ruleId: "POLLUTED_RULE",
        ruleVersion: 999,
        level: decision.level,
        reason: "污染的安全原因",
        alternative: "污染的替代建议",
      });
      context.database.db
        .update(safetyDecisions)
        .set({ ruleHitsJson: JSON.stringify(pollutedRuleHits) })
        .where(eq(safetyDecisions.id, decision.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET fails closed when persisted Safety engineVersion is polluted despite matching levels", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const decision = context.database.db.select().from(safetyDecisions).all()[0];
      if (decision === undefined) {
        throw new Error("TEST_SAFETY_DECISION_MISSING");
      }
      context.database.db
        .update(safetyDecisions)
        .set({ engineVersion: "polluted-engine-version" })
        .where(eq(safetyDecisions.id, decision.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET maps invalid persisted recipe JSON to stable INVALID_STATE without writes or Provider calls", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const recipe = context.database.db.select().from(recipes).all()[0];
      if (recipe === undefined) {
        throw new Error("TEST_RECIPE_MISSING");
      }
      context.database.db
        .update(recipes)
        .set({ materialsJson: "{invalid-json" })
        .where(eq(recipes.id, recipe.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET maps schema-invalid persisted recipe JSON to stable INVALID_STATE", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const recipe = context.database.db.select().from(recipes).all()[0];
      if (recipe === undefined) {
        throw new Error("TEST_RECIPE_MISSING");
      }
      context.database.db
        .update(recipes)
        .set({ materialsJson: JSON.stringify([]) })
        .where(eq(recipes.id, recipe.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET maps invalid decision event JSON to stable INVALID_STATE without leaking raw data", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");
      if (event === undefined) {
        throw new Error("TEST_GENERATION_EVENT_MISSING");
      }
      context.database.db
        .update(decisionEvents)
        .set({ metadataJson: "{invalid-event-json" })
        .where(eq(decisionEvents.id, event.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      const serialized = JSON.stringify(await response.json());

      expect(response.status).toBe(409);
      expect(serialized).toContain("INVALID_STATE");
      expect(serialized).not.toContain("invalid-event-json");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET maps schema-invalid decision event JSON to stable INVALID_STATE", async () => {
    const context = await createReadyRouteContext();
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        primaryProvider,
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");
      if (event === undefined) {
        throw new Error("TEST_GENERATION_EVENT_MISSING");
      }
      context.database.db
        .update(decisionEvents)
        .set({ metadataJson: JSON.stringify([]) })
        .where(eq(decisionEvents.id, event.id))
        .run();
      const beforeGet = recipePersistenceSnapshot(context.database);

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
      expect(primaryProvider.generateCalls).toBe(1);
      expect(recipePersistenceSnapshot(context.database)).toEqual(beforeGet);
    } finally {
      context.database.cleanup();
    }
  });

  it("GET preserves a 500 for infrastructure errors without leaking internals", async () => {
    const primaryProvider = new RecordingRecipeProvider(baseCandidateSet());
    const handlers = createRecipeGenerationRouteHandlers({
      read: () => {
        throw new Error("SQLITE_OFFLINE D:\\private\\database.sqlite");
      },
      transaction: () => {
        throw new Error("SQLITE_OFFLINE D:\\private\\database.sqlite");
      },
      primaryProvider,
      fallbackProvider: new RecordingRecipeProvider(baseCandidateSet()),
    });

    const response = await handlers.GET(new Request("http://localhost"), {
      params: Promise.resolve({ sessionId: randomUUID() }),
    });
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(500);
    expect(serialized).not.toContain("SQLITE_OFFLINE");
    expect(serialized).not.toContain("database.sqlite");
    expect(primaryProvider.generateCalls).toBe(0);
  });

  it("persists Qwen repair provenance across API replay and GET recovery", async () => {
    const context = await createReadyRouteContext();
    const requestId = randomUUID();
    const client = new ScriptedQwenCompletionClient([
      "not-json",
      JSON.stringify(baseCandidateSet()),
    ]);
    const generationHandlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        new QwenRecipeProvider({ client, model: "qwen-task-10-route-test" }),
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );
    const input = {
      requestId,
      expectedVersion: context.expectedVersion,
    };

    try {
      const firstResponse = await generationHandlers.POST(jsonRequest(input), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      const firstBody = await firstResponse.json();
      const replayResponse = await generationHandlers.POST(jsonRequest(input), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      const replayBody = await replayResponse.json();
      const getResponse = await generationHandlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      const getBody = await getResponse.json();
      const stages = firstBody.data.recipeSet.provenance.stages as Array<Record<string, unknown>>;

      expect(firstResponse.status).toBe(201);
      expect(replayResponse.status).toBe(201);
      expect(getResponse.status).toBe(200);
      expect(stages).toEqual([
        expect.objectContaining({ phase: "generate", outcome: "invalid_output" }),
        expect.objectContaining({ phase: "generate", outcome: "repair_accepted" }),
      ]);
      expect(replayBody).toEqual(firstBody);
      expect(getBody.data.recipeSet.provenance).toEqual(firstBody.data.recipeSet.provenance);
      expect(client.requests).toHaveLength(2);
      expect(JSON.stringify(firstBody)).not.toContain("not-json");
      expect(JSON.stringify(firstBody)).not.toContain("qwen-task-10-route-test");
    } finally {
      context.database.cleanup();
    }
  });

  it.each([
    ["missing", () => ({ sourceMode: "fallback", degraded: false })],
    ["invalid", () => ({ sourceMode: "fallback", degraded: false, provenance: "bad" })],
    [
      "inconsistent",
      () => ({
        sourceMode: "qwen",
        degraded: false,
        provenance: {
          sourceMode: "qwen",
          degraded: false,
          stages: [{ phase: "generate", attempt: 0, sourceMode: "qwen", degraded: false }],
        },
      }),
    ],
  ])("GET rejects %s event provenance with a stable invariant envelope", async (_, metadata) => {
    const context = await createReadyRouteContext();
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        new RecordingRecipeProvider(baseCandidateSet()),
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");
      if (event === undefined) {
        throw new Error("TEST_GENERATION_EVENT_MISSING");
      }
      context.database.db
        .update(decisionEvents)
        .set({ metadataJson: JSON.stringify(metadata()) })
        .where(eq(decisionEvents.id, event.id))
        .run();

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
    } finally {
      context.database.cleanup();
    }
  });

  it.each([
    [
      "repair-first",
      (provenance: Record<string, unknown>) => ({
        ...provenance,
        stages: [
          {
            ...(provenance.stages as Array<Record<string, unknown>>)[0],
            phase: "repair",
            attempt: 1,
          },
          ...(provenance.stages as Array<Record<string, unknown>>).slice(1),
        ],
      }),
    ],
    [
      "fallback-first",
      (provenance: Record<string, unknown>) => ({
        ...provenance,
        stages: [
          {
            ...(provenance.stages as Array<Record<string, unknown>>)[0],
            phase: "fallback",
          },
          ...(provenance.stages as Array<Record<string, unknown>>).slice(1),
        ],
      }),
    ],
    [
      "missing-initial",
      (provenance: Record<string, unknown>) => ({
        ...provenance,
        stages: (provenance.stages as Array<Record<string, unknown>>).slice(1),
      }),
    ],
    [
      "out-of-order-attempt",
      (provenance: Record<string, unknown>) => ({
        ...provenance,
        stages: [
          {
            ...(provenance.stages as Array<Record<string, unknown>>)[0],
            attempt: 1,
          },
          ...(provenance.stages as Array<Record<string, unknown>>).slice(1),
        ],
      }),
    ],
    [
      "unknown-first",
      (provenance: Record<string, unknown>) => ({
        ...provenance,
        stages: [
          {
            ...(provenance.stages as Array<Record<string, unknown>>)[0],
            phase: "unknown",
          },
          ...(provenance.stages as Array<Record<string, unknown>>).slice(1),
        ],
      }),
    ],
  ])("GET rejects %s provenance as a non-generate initial stage", async (_, mutate) => {
    const context = await createReadyRouteContext();
    const handlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        new RecordingRecipeProvider(baseCandidateSet()),
        new RecordingRecipeProvider(baseCandidateSet()),
      ),
    );

    try {
      const generationResponse = await handlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");
      if (event === undefined) {
        throw new Error("TEST_GENERATION_EVENT_MISSING");
      }
      const metadata = JSON.parse(event.metadataJson) as Record<string, unknown>;
      const provenance = metadata.provenance as Record<string, unknown>;
      context.database.db
        .update(decisionEvents)
        .set({
          metadataJson: JSON.stringify({ ...metadata, provenance: mutate(provenance) }),
        })
        .where(eq(decisionEvents.id, event.id))
        .run();

      const response = await handlers.GET(new Request("http://localhost"), {
        params: Promise.resolve({ sessionId: context.sessionId }),
      });
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe("INVALID_STATE");
    } finally {
      context.database.cleanup();
    }
  });

  it("fail-closes selection when the chosen recipe is missing a Safety decision", async () => {
    const context = await createReadyRouteContext();
    const candidateSet = baseCandidateSet();
    const generationHandlers = createRecipeGenerationRouteHandlers(
      createGenerateDependencies(
        context.database,
        new RecordingRecipeProvider(candidateSet),
        new RecordingRecipeProvider(candidateSet),
      ),
    );

    try {
      const generationResponse = await generationHandlers.POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(generationResponse.status).toBe(201);
      const generatedBody = await generationResponse.json();
      const selectedRecipeId = generatedBody.data.recipeSet.recipes[0].id as string;

      context.database.db
        .delete(safetyDecisions)
        .where(eq(safetyDecisions.recipeId, selectedRecipeId))
        .run();

      const selectionResponse = await createRecipeSelectionRouteHandlers(
        createSelectionDependencies(context.database),
      ).PUT(
        jsonRequest(
          {
            requestId: randomUUID(),
            expectedVersion: generatedBody.session.version,
            recipeId: selectedRecipeId,
            warningAcknowledged: true,
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );

      expect(selectionResponse.status).toBe(409);
      expect((await selectionResponse.json()).error.code).toBe("INVALID_STATE");
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "RECIPE_SELECTION",
        selectedRecipeId: null,
        currentStep: null,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("maps malformed JSON, ABV_REQUIRED, warning acknowledgement, and internal errors to stable envelopes", async () => {
    const context = await createReadyRouteContext();
    const allowSet = baseCandidateSet();
    const warnSet = baseCandidateSet();
    warnSet.recipes[2] = {
      ...warnSet.recipes[2],
      experimental: true,
      safetyLevel: "WARN",
    };

    try {
      const malformed = await createRecipeGenerationRouteHandlers(
        createGenerateDependencies(
          context.database,
          new RecordingRecipeProvider(allowSet),
          new RecordingRecipeProvider(allowSet),
        ),
      ).POST(
        new Request("http://localhost/api/sessions/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(malformed.status).toBe(400);

      createGenerateTransactionRepository(context.database.db).replaceForSession({
        sessionId: context.sessionId,
        ingredients: [{ ...confirmedIngredients[0], abv: null }, confirmedIngredients[1]],
      });

      const abvMissing = await createRecipeGenerationRouteHandlers(
        createGenerateDependencies(
          context.database,
          new RecordingRecipeProvider(allowSet),
          new RecordingRecipeProvider(allowSet),
        ),
      ).POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(abvMissing.status).toBe(422);
      expect((await abvMissing.json()).error.code).toBe("ABV_REQUIRED");

      createGenerateTransactionRepository(context.database.db).replaceForSession({
        sessionId: context.sessionId,
        ingredients: confirmedIngredients,
      });

      const generatedWarn = await createRecipeGenerationRouteHandlers(
        createGenerateDependencies(
          context.database,
          new RecordingRecipeProvider(warnSet),
          new RecordingRecipeProvider(allowSet),
        ),
      ).POST(
        jsonRequest({
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      const generatedWarnBody = await generatedWarn.json();

      const warningMissing = await createRecipeSelectionRouteHandlers(
        createSelectionDependencies(context.database),
      ).PUT(
        jsonRequest(
          {
            requestId: randomUUID(),
            expectedVersion: generatedWarnBody.session.version,
            recipeId: generatedWarnBody.data.recipeSet.recipes[2].id,
            warningAcknowledged: false,
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      expect(warningMissing.status).toBe(422);
      expect((await warningMissing.json()).error.code).toBe("INVALID_REQUEST");

      const internal = await createRecipeSelectionRouteHandlers({
        read: () => {
          throw new Error("DASHSCOPE_API_KEY=secret-value C:\\private\\prompt.txt");
        },
        transaction: () => {
          throw new Error("DASHSCOPE_API_KEY=secret-value C:\\private\\prompt.txt");
        },
      }).PUT(
        jsonRequest(
          {
            requestId: randomUUID(),
            expectedVersion: generatedWarnBody.session.version,
            recipeId: generatedWarnBody.data.recipeSet.recipes[0].id,
            warningAcknowledged: true,
          },
          "PUT",
        ),
        { params: Promise.resolve({ sessionId: context.sessionId }) },
      );
      const serialized = JSON.stringify(await internal.json());
      expect(internal.status).toBe(500);
      expect(serialized).not.toContain("secret-value");
      expect(serialized).not.toContain("C:\\private\\prompt.txt");
    } finally {
      context.database.cleanup();
    }
  });

  it("maps blocked-recipe fallback exhaustion to a stable PROVIDER_UNAVAILABLE envelope", async () => {
    const context = await createReadyRouteContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[0] = {
      ...unsafeSet.recipes[0],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" as const },
        { name: "能量饮料", amountMl: 100, unit: "ml" as const },
      ],
      safetyLevel: "BLOCK",
    };

    const primaryProvider = new RecordingRecipeProvider(unsafeSet, unsafeSet.recipes[0]);
    const fallbackProvider = {
      async generate() {
        throw new Error("RAW_FALLBACK_RESPONSE_WITH_SECRET");
      },
      async adjust() {
        return unsafeSet.recipes[0];
      },
    } satisfies RecipeProvider;

    const response = await createRecipeGenerationRouteHandlers(
      createGenerateDependencies(context.database, primaryProvider, fallbackProvider),
    ).POST(
      jsonRequest({
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      }),
      { params: Promise.resolve({ sessionId: context.sessionId }) },
    );

    try {
      const body = await response.json();
      const serialized = JSON.stringify(body);
      expect(response.status).toBe(503);
      expect(body.error.code).toBe("PROVIDER_UNAVAILABLE");
      expect(serialized).not.toContain("RAW_FALLBACK_RESPONSE_WITH_SECRET");
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "READY",
        version: context.expectedVersion,
      });
    } finally {
      context.database.cleanup();
    }
  });
});
