import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { createSession } from "@/src/application/create-session";
import { savePreferences } from "@/src/application/save-preferences";
import { recognizeIngredients } from "@/src/application/recognize-ingredients";
import { confirmIngredients } from "@/src/application/confirm-ingredients";
import {
  generateRecipeSet,
  type GenerateRecipeSetDependencies,
} from "@/src/application/generate-recipe-set";
import {
  selectRecipe,
  WarningAcknowledgementRequiredError,
  type SelectRecipeDependencies,
} from "@/src/application/select-recipe";
import { createSessionUnitOfWork } from "@/src/application/unit-of-work";
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
  sessionMutationLeases,
} from "@/src/infrastructure/db/schema";
import { DrizzleIngredientRepository } from "@/src/infrastructure/repositories/drizzle-ingredient-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import type {
  OutcomeAwareRecipeProvider,
  QwenCompletionClient,
  QwenCompletionRequest,
  RecipeProvider,
  RecipeProviderOutcome,
  RecipeCandidateSet,
  RecipeCandidate,
} from "@/src/providers/recipe-provider";
import { QwenRecipeProvider } from "@/src/infrastructure/providers/qwen-recipe-provider";
import type { VisionProvider, VisionResult } from "@/src/providers/vision-provider";
import type { Clock } from "@/src/application/clock";
import { evaluateSafety } from "@/src/safety/evaluate-safety";
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
    {
      rawName: "薄荷",
      canonicalName: "薄荷",
      category: "herb",
      brand: null,
      abv: null,
      confidence: 0.92,
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

class BlockingRecipeProvider implements RecipeProvider {
  generateCalls = 0;
  adjustCalls = 0;
  private releaseGenerate: (() => void) | null = null;
  private readonly waitForRelease = new Promise<void>((resolve) => {
    this.releaseGenerate = resolve;
  });

  constructor(
    private readonly candidateSet: RecipeCandidateSet,
    private readonly adjustedCandidate: RecipeCandidate,
  ) {}

  async generate(): Promise<RecipeCandidateSet> {
    this.generateCalls += 1;
    if (this.generateCalls === 1) {
      await this.waitForRelease;
    }
    return this.candidateSet;
  }

  async adjust(): Promise<RecipeCandidate> {
    this.adjustCalls += 1;
    return this.adjustedCandidate;
  }

  release(): void {
    this.releaseGenerate?.();
  }
}

class RecordingRecipeProvider implements RecipeProvider {
  generateCalls = 0;
  adjustCalls = 0;

  constructor(
    private readonly generateResponses: Array<RecipeCandidateSet | Error>,
    private readonly adjustResponses: Array<RecipeCandidate | Error> = [],
  ) {}

  async generate(): Promise<RecipeCandidateSet> {
    this.generateCalls += 1;
    const response =
      this.generateResponses[Math.min(this.generateCalls - 1, this.generateResponses.length - 1)];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }

  async adjust(): Promise<RecipeCandidate> {
    this.adjustCalls += 1;
    const response =
      this.adjustResponses[Math.min(this.adjustCalls - 1, this.adjustResponses.length - 1)];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

class OutcomeRecordingRecipeProvider implements OutcomeAwareRecipeProvider {
  generateCalls = 0;
  adjustCalls = 0;

  constructor(
    private readonly generateOutcome: RecipeProviderOutcome<RecipeCandidateSet>,
    private readonly adjustOutcome?: RecipeProviderOutcome<RecipeCandidate>,
  ) {}

  async generateWithOutcome(): Promise<RecipeProviderOutcome<RecipeCandidateSet>> {
    this.generateCalls += 1;
    return this.generateOutcome;
  }

  async generate(): Promise<RecipeCandidateSet> {
    return (await this.generateWithOutcome()).value;
  }

  async adjustWithOutcome(): Promise<RecipeProviderOutcome<RecipeCandidate>> {
    this.adjustCalls += 1;
    return (
      this.adjustOutcome ?? {
        value: this.generateOutcome.value.recipes[0],
        sourceMode: this.generateOutcome.sourceMode,
        degraded: this.generateOutcome.degraded,
      }
    );
  }

  async adjust(): Promise<RecipeCandidate> {
    return (await this.adjustWithOutcome()).value;
  }
}

class SequencedOutcomeRecipeProvider implements OutcomeAwareRecipeProvider {
  generateCalls = 0;
  adjustCalls = 0;
  private nextAdjustOutcome = 0;

  constructor(
    private readonly generateOutcome: RecipeProviderOutcome<RecipeCandidateSet>,
    private readonly adjustOutcomes: readonly RecipeProviderOutcome<RecipeCandidate>[],
  ) {}

  async generateWithOutcome(): Promise<RecipeProviderOutcome<RecipeCandidateSet>> {
    this.generateCalls += 1;
    return this.generateOutcome;
  }

  async generate(): Promise<RecipeCandidateSet> {
    return (await this.generateWithOutcome()).value;
  }

  async adjustWithOutcome(): Promise<RecipeProviderOutcome<RecipeCandidate>> {
    this.adjustCalls += 1;
    const outcome =
      this.adjustOutcomes[Math.min(this.nextAdjustOutcome, this.adjustOutcomes.length - 1)];
    this.nextAdjustOutcome += 1;
    if (outcome === undefined) {
      throw new Error("NO_ADJUST_OUTCOME");
    }
    return outcome;
  }

  async adjust(): Promise<RecipeCandidate> {
    return (await this.adjustWithOutcome()).value;
  }
}

class ManualClock implements Clock {
  constructor(private currentTime = 0) {}

  now(): Date {
    return new Date(this.currentTime);
  }

  advance(milliseconds: number): void {
    this.currentTime += milliseconds;
  }
}

class GatedQwenCompletionClient implements QwenCompletionClient {
  readonly requests: QwenCompletionRequest[] = [];
  readonly leaseRemainingMs: number[] = [];
  private readonly firstResponseGate: Promise<void>;
  private readonly secondResponseGate: Promise<void>;
  private releaseFirstResponse: (() => void) | null = null;
  private releaseSecondResponse: (() => void) | null = null;

  constructor(
    private readonly database: TestDatabase,
    private readonly clock: ManualClock,
    private readonly candidateSet: RecipeCandidateSet,
    private readonly requestId: string,
  ) {
    this.firstResponseGate = new Promise<void>((resolve) => {
      this.releaseFirstResponse = resolve;
    });
    this.secondResponseGate = new Promise<void>((resolve) => {
      this.releaseSecondResponse = resolve;
    });
  }

  async complete(request: QwenCompletionRequest): Promise<string> {
    this.requests.push(request);
    const record = this.database.db
      .select()
      .from(idempotencyRecords)
      .all()
      .find((item) => item.requestId === this.requestId);
    this.leaseRemainingMs.push(
      (record?.leaseExpiresAt?.getTime() ?? 0) - this.clock.now().getTime(),
    );
    this.clock.advance(5_250);

    if (this.requests.length === 1) {
      await this.firstResponseGate;
      return "not-json";
    }
    if (this.requests.length === 2) {
      await this.secondResponseGate;
      return JSON.stringify(this.candidateSet);
    }
    throw new Error("UNEXPECTED_QWEN_REQUEST");
  }

  releaseFirst(): void {
    this.releaseFirstResponse?.();
  }

  releaseSecond(): void {
    this.releaseSecondResponse?.();
  }
}

class SequencedQwenCompletionClient implements QwenCompletionClient {
  readonly requests: QwenCompletionRequest[] = [];
  readonly leaseRemainingMs: number[] = [];

  constructor(
    private readonly database: TestDatabase,
    private readonly clock: ManualClock,
    private readonly requestId: string,
    private readonly responses: readonly string[],
  ) {}

  async complete(request: QwenCompletionRequest): Promise<string> {
    this.requests.push(request);
    const record = this.database.db
      .select()
      .from(idempotencyRecords)
      .all()
      .find((item) => item.requestId === this.requestId);
    this.leaseRemainingMs.push(
      (record?.leaseExpiresAt?.getTime() ?? 0) - this.clock.now().getTime(),
    );
    this.clock.advance(5_250);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined) {
      throw new Error("UNEXPECTED_QWEN_REQUEST");
    }
    return response;
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createGenerateDependencies(
  database: TestDatabase,
  primaryProvider: RecipeProvider,
  fallbackProvider: RecipeProvider,
  options: {
    evaluateSafetyImpl?: typeof evaluateSafety;
    failAfterPersist?: boolean;
    failBeforeTransaction?: () => boolean;
    clock?: Clock;
    sleep?: (milliseconds: number) => Promise<void>;
    leaseDurationMs?: number;
    maxWaitAttempts?: number;
    leaseOwnerFactory?: () => string;
  } = {},
): GenerateRecipeSetDependencies {
  return {
    read: () => {
      const sessionRepository = new DrizzleSessionRepository(database.db);
      const ingredientRepository = new DrizzleIngredientRepository(database.db);
      const recipeRepository = new DrizzleRecipeRepository(database.db);
      return {
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
    },
    transaction: (operation) => {
      if (options.failBeforeTransaction?.() === true) {
        throw new Error("INJECTED_CLEANUP_FAILURE");
      }
      return withTransaction(database.db, (transaction) => {
        const repository = createGenerateTransactionRepository(transaction);
        const result = operation(repository);
        if (options.failAfterPersist === true) {
          throw new Error("INJECTED_TRANSACTION_FAILURE");
        }
        return result;
      });
    },
    primaryProvider,
    fallbackProvider,
    evaluateSafety: options.evaluateSafetyImpl,
    clock: options.clock,
    sleep: options.sleep,
    leaseDurationMs: options.leaseDurationMs,
    maxWaitAttempts: options.maxWaitAttempts,
    leaseOwnerFactory: options.leaseOwnerFactory,
  };
}

function createGenerateTransactionRepository(database: DatabaseExecutor) {
  const sessionRepository = new DrizzleSessionRepository(database);
  const ingredientRepository = new DrizzleIngredientRepository(database);
  const recipeRepository = new DrizzleRecipeRepository(database);

  return {
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
    createBatch: (input: Parameters<DrizzleRecipeRepository["createBatch"]>[0]) =>
      recipeRepository.createBatch(input),
    findSetBySession: (sessionId: string) => recipeRepository.findSetBySession(sessionId),
    listBySet: (recipeSetId: string) => recipeRepository.listBySet(recipeSetId),
    listSafetyDecisionsBySet: (recipeSetId: string) =>
      recipeRepository.listSafetyDecisionsBySet(recipeSetId),
    listDecisionEvents: (sessionId: string) => recipeRepository.listDecisionEvents(sessionId),
    createSafetyDecision: (
      input: Parameters<GenerateRecipeSetDependencies["transaction"]>[0] extends (
        repository: infer T,
      ) => unknown
        ? T extends { createSafetyDecision: (input: infer U) => void }
          ? U
          : never
        : never,
    ) => {
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
    createDecisionEvent: (
      input: Parameters<GenerateRecipeSetDependencies["transaction"]>[0] extends (
        repository: infer T,
      ) => unknown
        ? T extends { createDecisionEvent: (input: infer U) => void }
          ? U
          : never
        : never,
    ) => {
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
    createExperimentMemory: (
      input: Parameters<DrizzleRecipeRepository["createExperimentMemory"]>[0],
    ) => recipeRepository.createExperimentMemory(input),
    listExperimentMemories: (recipeId: string) => recipeRepository.listExperimentMemories(recipeId),
  };
}

async function createReadyContext() {
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
    unitOfWork,
    sessionId: created.response.session.id,
    expectedVersion: confirmed.response.session.version,
    preferences: fixtures.tasteProfile,
  };
}

async function flushAsyncWork(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
}

function settle<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

function baseCandidateSet(): RecipeCandidateSet {
  const fixtures = makeDomainFixtures();
  const seeded = RecipeCandidateSetSchema.parse({
    recipes: jsonClone(fixtures.recipes),
    recommendedRecipeId: fixtures.recipes[0].id,
  });
  const recipes: RecipeCandidateSet["recipes"] = seeded.recipes;
  recipes[0].materials = [
    { name: "白酒", amountMl: 30, unit: "ml" },
    { name: "苏打水", amountMl: 90, unit: "ml" },
  ];
  recipes[1].materials = [
    { name: "白酒", amountMl: 35, unit: "ml" },
    { name: "薄荷", amountMl: 10, unit: "ml" },
    { name: "苏打水", amountMl: 80, unit: "ml" },
  ];
  recipes[2].materials = [
    { name: "白酒", amountMl: 30, unit: "ml" },
    { name: "苏打水", amountMl: 60, unit: "ml" },
    { name: "柠檬", amountMl: 10, unit: "ml" },
  ];
  recipes[2].missingIngredients = ["柠檬"];
  return RecipeCandidateSetSchema.parse({
    recipes,
    recommendedRecipeId: recipes[0].id,
  });
}

function buildCustomBlockDecision(reason: string) {
  return {
    level: "BLOCK" as const,
    estimatedFinalAbv: 12,
    pureAlcoholMl: 15,
    hits: [
      {
        ruleId: "TEST_BLOCK_RULE",
        ruleVersion: 1,
        level: "BLOCK" as const,
        reason,
        alternative: "请改用安全版本",
      },
    ],
  };
}

function seedRecipeSelectionState(
  database: TestDatabase,
  sessionId: string,
  expectedVersion: number,
  candidateSet: RecipeCandidateSet,
  safetyLevels: Record<string, "ALLOW" | "WARN" | "BLOCK">,
) {
  withTransaction(database.db, (transaction) => {
    new DrizzleRecipeRepository(transaction).createBatch({
      sessionId,
      requestId: randomUUID(),
      expectedVersion,
      recipeSetId: randomUUID(),
      sourceMode: "fallback",
      recipes: candidateSet.recipes.map((candidate) => ({ candidate })),
      recommendedRecipeId: candidateSet.recommendedRecipeId,
      safetyDecisions: candidateSet.recipes.map((candidate) => ({
        recipeId: candidate.id,
        level: safetyLevels[candidate.id] ?? "ALLOW",
        ruleHits:
          safetyLevels[candidate.id] === "ALLOW"
            ? []
            : [
                {
                  ruleId: `SEEDED_${safetyLevels[candidate.id]}`,
                  ruleVersion: 1,
                  level: safetyLevels[candidate.id] ?? "ALLOW",
                  reason: `Seeded ${safetyLevels[candidate.id]} decision`,
                },
              ],
        engineVersion: "1.0.0",
      })),
      event: {
        type: "recipe_set_generated",
        summary: "Seeded recipe set for selection tests.",
        metadata: { seeded: true },
      },
    });
  });
}

function createSelectionDependencies(database: TestDatabase): SelectRecipeDependencies {
  return {
    read: () => {
      const sessionRepository = new DrizzleSessionRepository(database.db);
      const recipeRepository = new DrizzleRecipeRepository(database.db);
      return {
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
    },
    transaction: (operation) =>
      withTransaction(database.db, (transaction) => {
        const sessionRepository = new DrizzleSessionRepository(transaction);
        const recipeRepository = new DrizzleRecipeRepository(transaction);
        return operation({
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
        });
      }),
  };
}

function createDuplicateDecisionSelectionDependencies(
  database: TestDatabase,
  duplicatedRecipeId: string,
): SelectRecipeDependencies {
  const base = createSelectionDependencies(database);
  return {
    read: () => {
      const repository = base.read();
      return {
        ...repository,
        listSafetyDecisionsBySet: (recipeSetId) => {
          const decisions = repository.listSafetyDecisionsBySet(recipeSetId);
          const duplicatedDecision = decisions.find(
            (decision) => decision.recipeId === duplicatedRecipeId,
          );
          return duplicatedDecision === undefined ? decisions : [...decisions, duplicatedDecision];
        },
      };
    },
    transaction: (operation) =>
      base.transaction((repository) =>
        operation({
          ...repository,
          listSafetyDecisionsBySet: (recipeSetId) => {
            const decisions = repository.listSafetyDecisionsBySet(recipeSetId);
            const duplicatedDecision = decisions.find(
              (decision) => decision.recipeId === duplicatedRecipeId,
            );
            return duplicatedDecision === undefined
              ? decisions
              : [...decisions, duplicatedDecision];
          },
        }),
      ),
  };
}

describe("generateRecipeSet", () => {
  it("renews the lease before each Qwen completion during a two-request operation", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const clock = new ManualClock();
    const requestId = randomUUID();
    const qwenClient = new GatedQwenCompletionClient(
      context.database,
      clock,
      candidateSet,
      requestId,
    );
    const primaryProvider = new QwenRecipeProvider({
      client: qwenClient,
      model: "qwen-test-fixture",
      timeoutMs: 5_000,
    });
    const fallbackProvider = new RecordingRecipeProvider([candidateSet]);
    let releaseWait: () => void = () => undefined;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    let waitCalls = 0;
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        clock,
        leaseDurationMs: 1_000,
        maxWaitAttempts: 10,
        sleep: async () => {
          waitCalls += 1;
          if (waitCalls === 1) {
            await waitGate;
          }
        },
      },
    );
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };
    const first = generateRecipeSet(dependencies, input);
    let secondOutcome: Promise<{ value: Awaited<typeof first> } | { error: unknown }> | undefined;

    try {
      await flushAsyncWork();
      expect(qwenClient.requests).toHaveLength(1);

      secondOutcome = settle(generateRecipeSet(dependencies, input));
      await flushAsyncWork();
      expect(waitCalls).toBeGreaterThan(0);

      qwenClient.releaseFirst();
      await flushAsyncWork();
      expect(qwenClient.requests).toHaveLength(2);
      expect(clock.now().getTime()).toBe(10_500);
      expect(qwenClient.leaseRemainingMs[0]).toBe(11_000);
      expect(qwenClient.leaseRemainingMs[1]).toBeGreaterThan(6_000);

      qwenClient.releaseSecond();
      await expect(first).resolves.toMatchObject({ replayed: false });
      releaseWait();
      await expect(secondOutcome).resolves.toMatchObject({
        value: { replayed: true },
      });
    } finally {
      qwenClient.releaseFirst();
      qwenClient.releaseSecond();
      releaseWait();
      await Promise.allSettled([first, ...(secondOutcome === undefined ? [] : [secondOutcome])]);
      context.database.cleanup();
    }
  });

  it("renews before both Qwen repair rounds and safely falls back after they stay blocked", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[1] = {
      ...unsafeSet.recipes[1],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 120, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const firstBlockedRepair = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 110, unit: "ml" },
      ],
      safetyLevel: "ALLOW" as const,
    });
    const secondBlockedRepair = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 120, unit: "ml" },
      ],
      safetyLevel: "ALLOW" as const,
    });
    const fallbackSet = baseCandidateSet();
    fallbackSet.recipes[1].title = "两轮修复后的本地保底方案";
    const clock = new ManualClock();
    const requestId = randomUUID();
    const qwenClient = new SequencedQwenCompletionClient(context.database, clock, requestId, [
      JSON.stringify(unsafeSet),
      JSON.stringify(firstBlockedRepair),
      JSON.stringify(secondBlockedRepair),
    ]);
    const primaryProvider = new QwenRecipeProvider({
      client: qwenClient,
      model: "qwen-test-fixture",
      timeoutMs: 5_000,
    });
    const fallbackProvider = new RecordingRecipeProvider([fallbackSet]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        clock,
        leaseDurationMs: 1_000,
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 100,
          )
            ? buildCustomBlockDecision("Qwen 两轮修复后仍被确定性 Safety 阻止")
            : evaluateSafety(input),
      },
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: context.expectedVersion,
      });
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");

      expect(qwenClient.requests.map((request) => request.operation)).toEqual([
        "generate",
        "adjust",
        "adjust",
      ]);
      expect(qwenClient.leaseRemainingMs).toEqual([11_000, 11_000, 11_000]);
      expect(fallbackProvider.generateCalls).toBe(1);
      expect(result.response.data.recipeSet.sourceMode).toBe("fallback");
      expect(result.response.data.recipeSet.degraded).toBe(true);
      expect(
        result.response.data.recipeSet.recipes.every(
          (candidate) => candidate.safetyLevel !== "BLOCK",
        ),
      ).toBe(true);
      expect(event?.metadataJson).toContain('"degraded":true');
    } finally {
      context.database.cleanup();
    }
  });

  it("writes the recipe set, three recipes, safety decisions, recommendation, and event in one transaction", async () => {
    const context = await createReadyContext();
    const primaryProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });

      expect(result.replayed).toBe(false);
      expect(result.response.session).toMatchObject({
        state: "RECIPE_SELECTION",
        version: context.expectedVersion + 1,
      });
      expect(result.response.data.recipeSet.recipes).toHaveLength(3);
      expect(primaryProvider.generateCalls).toBe(1);
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(1);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(3);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(3);
      expect(context.database.db.select().from(recipeSets).all()[0]?.recommendedRecipeId).toBe(
        result.response.data.recipeSet.recommendedRecipeId,
      );
      expect(
        context.database.db
          .select()
          .from(decisionEvents)
          .all()
          .filter((row) => row.eventType === "recipe_set_generated"),
      ).toHaveLength(1);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "RECIPE_SELECTION",
        version: context.expectedVersion + 1,
      });
      const reloadedSet = new DrizzleRecipeRepository(context.database.db).findSetBySession(
        context.sessionId,
      );
      const reloadedRecipes = new DrizzleRecipeRepository(context.database.db).listBySet(
        reloadedSet?.id ?? "",
      );
      expect(reloadedSet?.recommendedRecipeId).toBe(
        result.response.data.recipeSet.recommendedRecipeId,
      );
      expect(reloadedRecipes.map((recipe) => recipe.id)).toContain(
        result.response.data.recipeSet.recommendedRecipeId,
      );
    } finally {
      context.database.cleanup();
    }
  });

  it("persists fallback provenance in the recipe set and audit event when Qwen internally degrades", async () => {
    const context = await createReadyContext();
    const primaryProvider = new OutcomeRecordingRecipeProvider({
      value: baseCandidateSet(),
      sourceMode: "fallback",
      degraded: true,
    });
    const repairFallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      repairFallbackProvider,
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });
      const persistedSet = context.database.db.select().from(recipeSets).all()[0];
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");

      expect(result.response.data.recipeSet.sourceMode).toBe("fallback");
      expect((result.response.data.recipeSet as Record<string, unknown>).degraded).toBe(true);
      expect(persistedSet?.sourceMode).toBe("fallback");
      expect(event?.metadataJson).toContain('"sourceMode":"fallback"');
      expect(event?.metadataJson).toContain('"degraded":true');
      expect(primaryProvider.generateCalls).toBe(1);
      expect(repairFallbackProvider.generateCalls).toBe(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("persists Qwen invalid-output and repair provenance through replay", async () => {
    const context = await createReadyContext();
    const requestId = randomUUID();
    const client = new SequencedQwenCompletionClient(
      context.database,
      new ManualClock(),
      requestId,
      ["not-json", JSON.stringify(baseCandidateSet())],
    );
    const primaryProvider = new QwenRecipeProvider({
      client,
      model: "qwen-task-10-test",
    });
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      new RecordingRecipeProvider([baseCandidateSet()]),
    );
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };

    try {
      const first = await generateRecipeSet(dependencies, input);
      const replay = await generateRecipeSet(dependencies, input);
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");
      const metadata = JSON.parse(event?.metadataJson ?? "{}") as {
        provenance?: unknown;
      };
      const stages = first.response.data.recipeSet.provenance.stages;

      expect(stages).toEqual([
        expect.objectContaining({ phase: "generate", outcome: "invalid_output" }),
        expect.objectContaining({ phase: "generate", outcome: "repair_accepted" }),
      ]);
      expect(metadata.provenance).toEqual(first.response.data.recipeSet.provenance);
      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);
      expect(client.requests).toHaveLength(2);
      expect(event?.metadataJson).not.toContain("not-json");
      expect(event?.metadataJson).not.toContain("qwen-task-10-test");
    } finally {
      context.database.cleanup();
    }
  });

  it("keeps qwen provenance after repairing a blocked candidate without degrading", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[1] = {
      ...unsafeSet.recipes[1],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 120, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const repairedCandidate = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 80, unit: "ml" },
      ],
      safetyLevel: "ALLOW" as const,
    });
    const primaryProvider = new OutcomeRecordingRecipeProvider(
      {
        value: unsafeSet,
        sourceMode: "qwen",
        degraded: false,
      },
      {
        value: repairedCandidate,
        sourceMode: "qwen",
        degraded: false,
      },
    );
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 120,
          )
            ? buildCustomBlockDecision("Repair required before selection")
            : evaluateSafety(input),
      },
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");

      expect(result.response.data.recipeSet.sourceMode).toBe("qwen");
      expect((result.response.data.recipeSet as Record<string, unknown>).degraded).toBe(false);
      expect(primaryProvider.generateCalls).toBe(1);
      expect(primaryProvider.adjustCalls).toBe(1);
      expect(fallbackProvider.generateCalls).toBe(0);
      expect(event?.metadataJson).toContain('"sourceMode":"qwen"');
      expect(event?.metadataJson).toContain('"degraded":false');
      expect(event?.metadataJson).toContain("B_CREATIVE");
      expect(event?.summary).toContain("修复");
    } finally {
      context.database.cleanup();
    }
  });

  it("persists fallback degraded provenance when a blocked candidate repair degrades to fallback", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[2] = {
      ...unsafeSet.recipes[2],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 120, unit: "ml" },
      ],
      missingIngredients: [],
      safetyLevel: "BLOCK",
    };
    const repairedCandidate = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[2],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 75, unit: "ml" },
      ],
      safetyLevel: "WARN" as const,
    });
    const primaryProvider = new OutcomeRecordingRecipeProvider(
      {
        value: unsafeSet,
        sourceMode: "qwen",
        degraded: false,
      },
      {
        value: repairedCandidate,
        sourceMode: "fallback",
        degraded: true,
      },
    );
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 120,
          )
            ? buildCustomBlockDecision("Repair fallback required")
            : evaluateSafety(input),
      },
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");

      expect(result.response.data.recipeSet.sourceMode).toBe("fallback");
      expect((result.response.data.recipeSet as Record<string, unknown>).degraded).toBe(true);
      expect(primaryProvider.generateCalls).toBe(1);
      expect(primaryProvider.adjustCalls).toBe(1);
      expect(fallbackProvider.generateCalls).toBe(0);
      expect(event?.metadataJson).toContain('"sourceMode":"fallback"');
      expect(event?.metadataJson).toContain('"degraded":true');
      expect(event?.metadataJson).toContain("C_UPGRADE");
    } finally {
      context.database.cleanup();
    }
  });

  it("retains fallback degraded provenance when a later repair succeeds with Qwen", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[1] = {
      ...unsafeSet.recipes[1],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 120, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const fallbackRepairThatStaysBlocked = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 110, unit: "ml" },
      ],
      safetyLevel: "BLOCK" as const,
    });
    const qwenRepairThatPasses = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 80, unit: "ml" },
      ],
      safetyLevel: "ALLOW" as const,
    });
    const primaryProvider = new SequencedOutcomeRecipeProvider(
      {
        value: unsafeSet,
        sourceMode: "qwen",
        degraded: false,
      },
      [
        {
          value: fallbackRepairThatStaysBlocked,
          sourceMode: "fallback",
          degraded: true,
        },
        {
          value: qwenRepairThatPasses,
          sourceMode: "qwen",
          degraded: false,
        },
      ],
    );
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 100,
          )
            ? buildCustomBlockDecision("连续修复仍需安全裁决")
            : evaluateSafety(input),
      },
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });
      const persistedSet = context.database.db.select().from(recipeSets).all()[0];
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");

      expect(primaryProvider.adjustCalls).toBe(2);
      expect(result.response.data.recipeSet.sourceMode).toBe("fallback");
      expect(result.response.data.recipeSet.degraded).toBe(true);
      expect(persistedSet?.sourceMode).toBe("fallback");
      expect(event?.metadataJson).toContain('"sourceMode":"fallback"');
      expect(event?.metadataJson).toContain('"degraded":true');
      expect(event?.summary).toContain("降级");
    } finally {
      context.database.cleanup();
    }
  });

  it("persists every generate and repair provenance stage through response and event", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[1] = {
      ...unsafeSet.recipes[1],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 120, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const fallbackRepairThatStaysBlocked = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 110, unit: "ml" },
      ],
      safetyLevel: "BLOCK" as const,
    });
    const qwenRepairThatPasses = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 80, unit: "ml" },
      ],
      safetyLevel: "ALLOW" as const,
    });
    const primaryProvider = new SequencedOutcomeRecipeProvider(
      {
        value: unsafeSet,
        sourceMode: "qwen",
        degraded: false,
      },
      [
        {
          value: fallbackRepairThatStaysBlocked,
          sourceMode: "fallback",
          degraded: true,
        },
        {
          value: qwenRepairThatPasses,
          sourceMode: "qwen",
          degraded: false,
        },
      ],
    );
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      new RecordingRecipeProvider([baseCandidateSet()]),
      {
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 100,
          )
            ? buildCustomBlockDecision("每阶段 provenance 都必须经过 Safety")
            : evaluateSafety(input),
      },
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });
      const responseRecipeSet = result.response.data.recipeSet as Record<string, unknown>;
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");
      const eventMetadata = JSON.parse(event?.metadataJson ?? "{}") as Record<string, unknown>;
      const expectedStages = [
        { phase: "generate", attempt: 0, sourceMode: "qwen", degraded: false },
        {
          phase: "repair",
          attempt: 1,
          strategy: "B_CREATIVE",
          sourceMode: "fallback",
          degraded: true,
        },
        {
          phase: "repair",
          attempt: 2,
          strategy: "B_CREATIVE",
          sourceMode: "qwen",
          degraded: false,
        },
      ];

      expect(responseRecipeSet.provenance).toMatchObject({
        sourceMode: "fallback",
        degraded: true,
        stages: expectedStages,
      });
      expect(eventMetadata.provenance).toMatchObject({
        sourceMode: "fallback",
        degraded: true,
        stages: expectedStages,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("fails closed when deterministic Safety evaluation throws without fallback writes", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[0] = {
      ...unsafeSet.recipes[0],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 100, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    let blockedCandidateEvaluated = false;
    const dependencies = createGenerateDependencies(
      context.database,
      new RecordingRecipeProvider([unsafeSet], [unsafeSet.recipes[0], unsafeSet.recipes[0]]),
      new RecordingRecipeProvider([baseCandidateSet()]),
      {
        evaluateSafetyImpl: (input) => {
          const isBlockedCandidate = input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 100,
          );
          if (isBlockedCandidate && blockedCandidateEvaluated) {
            throw new Error("SAFETY_ENGINE_DOWN");
          }
          if (isBlockedCandidate) {
            blockedCandidateEvaluated = true;
            return buildCustomBlockDecision("Safety engine must remain authoritative");
          }
          return evaluateSafety(input);
        },
      },
    );

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
      ).rejects.toMatchObject({ code: "SAFETY_EVALUATION_FAILED" });
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(0);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(0);
      expect(
        context.database.db
          .select()
          .from(decisionEvents)
          .all()
          .filter((event) => event.eventType === "recipe_set_generated"),
      ).toHaveLength(0);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "READY",
        version: context.expectedVersion,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects an old expectedVersion before any provider call", async () => {
    const context = await createReadyContext();
    const primaryProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
    );

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion - 1,
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      expect(primaryProvider.generateCalls).toBe(0);
      expect(fallbackProvider.generateCalls).toBe(0);
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("blocks generation before provider execution when a confirmed alcohol ingredient loses ABV", async () => {
    const context = await createReadyContext();
    const primaryProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
    );

    createGenerateTransactionRepository(context.database.db).replaceForSession({
      sessionId: context.sessionId,
      ingredients: [
        { ...confirmedIngredients[0], abv: null },
        confirmedIngredients[1],
        confirmedIngredients[2],
      ],
    });

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
      ).rejects.toMatchObject({ code: "ABV_REQUIRED" });
      expect(primaryProvider.generateCalls).toBe(0);
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("re-evaluates safety after repairing a blocked candidate", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[1] = {
      ...unsafeSet.recipes[1],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 100, unit: "ml" },
      ],
    };
    const repairedCandidate = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[1],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 80, unit: "ml" },
      ],
      safetyLevel: "ALLOW" as const,
    });
    const primaryProvider = new RecordingRecipeProvider([unsafeSet], [repairedCandidate]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const candidateEvaluationCounts = new Map<string, number>();
    const blockedSignature = "白酒:35|苏打水:100";
    const repairedSignature = "白酒:35|苏打水:80";
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) => {
          const candidateSignature = input.ingredients
            .map((ingredient) => `${ingredient.name}:${ingredient.volumeMl}`)
            .join("|");
          candidateEvaluationCounts.set(
            candidateSignature,
            (candidateEvaluationCounts.get(candidateSignature) ?? 0) + 1,
          );
          if (
            input.ingredients.some(
              (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl === 100,
            )
          ) {
            return buildCustomBlockDecision("需要修复该候选");
          }
          return evaluateSafety(input);
        },
      },
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });

      expect(primaryProvider.adjustCalls).toBe(1);
      expect(candidateEvaluationCounts.get(blockedSignature)).toBe(1);
      expect(candidateEvaluationCounts.get(repairedSignature)).toBe(1);
      expect(
        result.response.data.recipeSet.recipes.every(
          (candidate) => candidate.safetyLevel !== "BLOCK",
        ),
      ).toBe(true);
    } finally {
      context.database.cleanup();
    }
  });

  it("falls back to a deterministic replacement after two blocked repairs", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[0] = {
      ...unsafeSet.recipes[0],
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 120, unit: "ml" },
      ],
    };
    const stillBlockedCandidate = RecipeCandidateSchema.parse({
      ...unsafeSet.recipes[0],
      id: randomUUID(),
      materials: [
        { name: "白酒", amountMl: 30, unit: "ml" },
        { name: "苏打水", amountMl: 110, unit: "ml" },
      ],
      safetyLevel: "WARN" as const,
    });
    const fallbackSet = baseCandidateSet();
    fallbackSet.recipes[0].title = "本地保底替换方案";
    const primaryProvider = new RecordingRecipeProvider(
      [unsafeSet],
      [
        stillBlockedCandidate,
        RecipeCandidateSchema.parse({
          ...stillBlockedCandidate,
          id: randomUUID(),
          materials: [
            { name: "白酒", amountMl: 30, unit: "ml" },
            { name: "苏打水", amountMl: 120, unit: "ml" },
          ],
        }),
      ],
    );
    const fallbackProvider = new RecordingRecipeProvider([fallbackSet]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) => {
          if (
            input.ingredients.some(
              (ingredient) =>
                ingredient.name === "苏打水" &&
                (ingredient.volumeMl === 120 || ingredient.volumeMl === 110),
            )
          ) {
            return buildCustomBlockDecision("连续修复后仍然危险");
          }
          return evaluateSafety(input);
        },
      },
    );

    try {
      const result = await generateRecipeSet(dependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion,
      });
      const selectedA = result.response.data.recipeSet.recipes.find(
        (candidate) => candidate.strategy === "A_CONSERVATIVE",
      );
      const event = context.database.db
        .select()
        .from(decisionEvents)
        .all()
        .find((row) => row.eventType === "recipe_set_generated");

      expect(primaryProvider.adjustCalls).toBe(2);
      expect(fallbackProvider.generateCalls).toBe(1);
      expect(selectedA?.title).toBe("本地保底替换方案");
      expect(
        result.response.data.recipeSet.recipes.every(
          (candidate) => candidate.safetyLevel !== "BLOCK",
        ),
      ).toBe(true);
      expect(event?.metadataJson).toContain("A_CONSERVATIVE");
    } finally {
      context.database.cleanup();
    }
  });

  it("surfaces provider exhaustion as PROVIDER_UNAVAILABLE without persisting raw provider output", async () => {
    const context = await createReadyContext();
    const unsafeError = new Error(
      'provider raw response {"token":"secret","path":"C:\\\\private\\\\prompt.txt"}',
    );
    const primaryProvider = new RecordingRecipeProvider([unsafeError]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
    );

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      const serialized = JSON.stringify({
        events: context.database.db.select().from(decisionEvents).all(),
        recipeSets: context.database.db.select().from(recipeSets).all(),
        idempotencyRecords: context.database.db.select().from(idempotencyRecords).all(),
      });

      expect(primaryProvider.generateCalls).toBe(1);
      expect(fallbackProvider.generateCalls).toBe(0);
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("C:\\private\\prompt.txt");
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(0);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("maps fallback provider failures during blocked-candidate replacement to PROVIDER_UNAVAILABLE without partial writes", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[0] = {
      ...unsafeSet.recipes[0],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 100, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const primaryProvider = new RecordingRecipeProvider(
      [unsafeSet],
      [unsafeSet.recipes[0], unsafeSet.recipes[0]],
    );
    const fallbackProvider = new RecordingRecipeProvider([
      new Error("RAW_FALLBACK_PROVIDER_ERROR"),
    ]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 100,
          )
            ? buildCustomBlockDecision("Fallback replacement still unsafe")
            : {
                level: "ALLOW",
                estimatedFinalAbv: 10,
                pureAlcoholMl: 12,
                hits: [],
              },
      },
    );

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(0);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(0);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "READY",
        version: context.expectedVersion,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("maps malformed fallback replacement sets to PROVIDER_UNAVAILABLE without partial writes", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[0] = {
      ...unsafeSet.recipes[0],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 100, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const malformedFallbackSet = jsonClone(baseCandidateSet());
    malformedFallbackSet.recipes[0] = {
      ...malformedFallbackSet.recipes[0],
      strategy: "B_CREATIVE",
    };
    const primaryProvider = new RecordingRecipeProvider(
      [unsafeSet],
      [unsafeSet.recipes[0], unsafeSet.recipes[0]],
    );
    const fallbackProvider = new RecordingRecipeProvider([malformedFallbackSet]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 100,
          )
            ? buildCustomBlockDecision("Fallback replacement still unsafe")
            : {
                level: "ALLOW",
                estimatedFinalAbv: 10,
                pureAlcoholMl: 12,
                hits: [],
              },
      },
    );

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(0);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("maps blocked fallback replacements to PROVIDER_UNAVAILABLE without partial writes", async () => {
    const context = await createReadyContext();
    const unsafeSet = baseCandidateSet();
    unsafeSet.recipes[0] = {
      ...unsafeSet.recipes[0],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 100, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const blockedFallbackSet = jsonClone(baseCandidateSet());
    blockedFallbackSet.recipes[0] = {
      ...blockedFallbackSet.recipes[0],
      materials: [
        { name: "白酒", amountMl: 35, unit: "ml" },
        { name: "苏打水", amountMl: 100, unit: "ml" },
      ],
      safetyLevel: "BLOCK",
    };
    const primaryProvider = new RecordingRecipeProvider(
      [unsafeSet],
      [unsafeSet.recipes[0], unsafeSet.recipes[0]],
    );
    const fallbackProvider = new RecordingRecipeProvider([blockedFallbackSet]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        evaluateSafetyImpl: (input) =>
          input.ingredients.some(
            (ingredient) => ingredient.name === "苏打水" && ingredient.volumeMl >= 100,
          )
            ? buildCustomBlockDecision("Fallback replacement still unsafe")
            : {
                level: "ALLOW",
                estimatedFinalAbv: 10,
                pureAlcoholMl: 12,
                hits: [],
              },
      },
    );

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
      ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(0);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("rolls back persisted writes when the final transaction fails", async () => {
    const context = await createReadyContext();
    const primaryProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      { failAfterPersist: true },
    );

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion,
        }),
      ).rejects.toThrow("INJECTED_TRANSACTION_FAILURE");

      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(0);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(0);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "READY",
        version: context.expectedVersion,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("replays the same requestId without calling the provider twice", async () => {
    const context = await createReadyContext();
    const primaryProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
    );
    const requestId = randomUUID();
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };

    try {
      const first = await generateRecipeSet(dependencies, input);
      const replay = await generateRecipeSet(dependencies, input);

      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);
      expect((replay.response.data.recipeSet as Record<string, unknown>).degraded).toBe(
        (first.response.data.recipeSet as Record<string, unknown>).degraded,
      );
      expect(primaryProvider.generateCalls).toBe(1);
      expect(context.database.db.select().from(idempotencyRecords).all().length).toBeGreaterThan(0);
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects reusing the same requestId with a different expectedVersion", async () => {
    const context = await createReadyContext();
    const primaryProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
    );
    const requestId = randomUUID();

    try {
      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId,
          expectedVersion: context.expectedVersion,
        }),
      ).resolves.toMatchObject({ replayed: false });

      await expect(
        generateRecipeSet(dependencies, {
          sessionId: context.sessionId,
          requestId,
          expectedVersion: context.expectedVersion + 1,
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      expect(primaryProvider.generateCalls).toBe(1);
    } finally {
      context.database.cleanup();
    }
  });

  it("recovers a pending reservation after cleanup failure and fences the old owner", async () => {
    const context = await createReadyContext();
    const clock = new ManualClock();
    const requestId = randomUUID();
    const leaseOwners = ["owner-a", "owner-b"];
    let generateCalls = 0;
    let cleanupFailureArmed = false;
    const primaryProvider: RecipeProvider = {
      async generate() {
        generateCalls += 1;
        if (generateCalls === 1) {
          cleanupFailureArmed = true;
          throw new Error("RAW_PROVIDER_FAILURE");
        }
        return baseCandidateSet();
      },
      async adjust() {
        throw new Error("UNEXPECTED_ADJUST");
      },
    };
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      new RecordingRecipeProvider([baseCandidateSet()]),
      {
        clock,
        leaseDurationMs: 1_000,
        leaseOwnerFactory: () => leaseOwners.shift() ?? "owner-c",
        failBeforeTransaction: () => {
          if (!cleanupFailureArmed) {
            return false;
          }
          cleanupFailureArmed = false;
          return true;
        },
      },
    );
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };

    try {
      await expect(generateRecipeSet(dependencies, input)).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
      });
      const pending = context.database.db
        .select()
        .from(idempotencyRecords)
        .all()
        .find((record) => record.requestId === requestId);
      expect(pending?.leaseOwner).toBe("owner-a");
      expect(pending?.statusCode).toBe(102);
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(0);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(0);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(0);
      expect(
        context.database.db
          .select()
          .from(decisionEvents)
          .all()
          .filter((row) => row.eventType === "recipe_set_generated"),
      ).toHaveLength(0);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "READY",
        version: context.expectedVersion,
      });

      await expect(
        generateRecipeSet(dependencies, {
          ...input,
          expectedVersion: context.expectedVersion + 1,
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      expect(generateCalls).toBe(1);

      clock.advance(11_001);
      const retried = await generateRecipeSet(dependencies, input);
      expect(retried.replayed).toBe(false);
      expect(generateCalls).toBe(2);
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(1);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(3);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(3);
      expect(
        context.database.db
          .select()
          .from(decisionEvents)
          .all()
          .filter((row) => row.eventType === "recipe_set_generated"),
      ).toHaveLength(1);

      const repository = createGenerateTransactionRepository(context.database.db);
      expect(() =>
        repository.completeIdempotencyRecord({
          requestId,
          leaseOwner: "owner-a",
          now: clock.now(),
          response: { pending: true },
          statusCode: 102,
        }),
      ).toThrowError(/IDEMPOTENCY_LEASE_LOST/);
      expect(() =>
        repository.deleteIdempotencyRecord({
          requestId,
          leaseOwner: "owner-a",
          now: clock.now(),
        }),
      ).toThrowError(/IDEMPOTENCY_LEASE_LOST/);
      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(1);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(3);
    } finally {
      context.database.cleanup();
    }
  });

  it("allows only one same-body concurrent request to reach the provider", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const repairedCandidate = candidateSet.recipes[0];
    const primaryProvider = new BlockingRecipeProvider(candidateSet, repairedCandidate);
    const fallbackProvider = new RecordingRecipeProvider([baseCandidateSet()]);
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
    );
    const requestId = randomUUID();
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };
    const first = generateRecipeSet(dependencies, input);
    const second = generateRecipeSet(dependencies, input);

    try {
      await flushAsyncWork();
      expect(primaryProvider.generateCalls).toBe(1);
      primaryProvider.release();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect([firstResult.replayed, secondResult.replayed].sort()).toEqual([false, true]);
      expect(primaryProvider.generateCalls).toBe(1);
    } finally {
      primaryProvider.release();
      await Promise.allSettled([first, second]);
      context.database.cleanup();
    }
  });

  it("keeps the lease renewed during a long provider call so a second request cannot take over", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const primaryProvider = new BlockingRecipeProvider(candidateSet, candidateSet.recipes[0]!);
    const fallbackProvider = new RecordingRecipeProvider([candidateSet]);
    const clock = new ManualClock();
    const requestId = randomUUID();
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        clock,
        leaseDurationMs: 1_000,
        maxWaitAttempts: 5,
        sleep: async () => {
          clock.advance(300);
        },
      },
    );
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };
    const first = generateRecipeSet(dependencies, input);
    const secondOutcome = settle(generateRecipeSet(dependencies, input));

    try {
      await flushAsyncWork();
      expect(primaryProvider.generateCalls).toBe(1);
      expect(await secondOutcome).toMatchObject({
        error: { code: "IDEMPOTENCY_IN_PROGRESS" },
      });
      expect(primaryProvider.generateCalls).toBe(1);
      primaryProvider.release();
      await expect(first).resolves.toMatchObject({ replayed: false });
      expect(fallbackProvider.generateCalls).toBe(0);
    } finally {
      primaryProvider.release();
      await Promise.allSettled([first]);
      context.database.cleanup();
    }
  });

  it("covers the Qwen worst-case two-request budget with a real 10.5-second lease check before takeover", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const primaryProvider = new BlockingRecipeProvider(candidateSet, candidateSet.recipes[0]!);
    const fallbackProvider = new RecordingRecipeProvider([candidateSet]);
    const clock = new ManualClock();
    const requestId = randomUUID();
    let waitCalls = 0;
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        clock,
        leaseDurationMs: 1_000,
        maxWaitAttempts: 6,
        sleep: async () => {
          waitCalls += 1;
          if (waitCalls <= 5) {
            clock.advance(2_100);
          }
        },
      },
    );
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };
    const first = generateRecipeSet(dependencies, input);
    const secondOutcome = settle(generateRecipeSet(dependencies, input));

    try {
      await flushAsyncWork();
      const pendingRecord = context.database.db
        .select()
        .from(idempotencyRecords)
        .all()
        .find((record) => record.requestId === requestId);

      expect(primaryProvider.generateCalls).toBe(1);
      expect(pendingRecord?.leaseOwner).not.toBeNull();
      expect(pendingRecord?.leaseExpiresAt?.getTime()).toBe(11_000);
      expect(await secondOutcome).toMatchObject({
        error: { code: "IDEMPOTENCY_IN_PROGRESS" },
      });
      expect(clock.now().getTime()).toBe(10_500);
      expect(primaryProvider.generateCalls).toBe(1);
      primaryProvider.release();
      await expect(first).resolves.toMatchObject({ replayed: false });
      expect(fallbackProvider.generateCalls).toBe(0);
    } finally {
      primaryProvider.release();
      await Promise.allSettled([first]);
      context.database.cleanup();
    }
  });

  it("allows a new owner to take over after expiry and fences the old owner from renew release and commit", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const primaryProvider = new BlockingRecipeProvider(candidateSet, candidateSet.recipes[0]!);
    const fallbackProvider = new RecordingRecipeProvider([candidateSet]);
    const clock = new ManualClock();
    const requestId = randomUUID();
    const leaseOwners = ["owner-a", "owner-b"];
    const dependencies = createGenerateDependencies(
      context.database,
      primaryProvider,
      fallbackProvider,
      {
        clock,
        leaseDurationMs: 1_000,
        maxWaitAttempts: 6,
        sleep: async () => {
          clock.advance(2_500);
        },
        leaseOwnerFactory: () => leaseOwners.shift() ?? "owner-c",
      },
    );
    const input = {
      sessionId: context.sessionId,
      requestId,
      expectedVersion: context.expectedVersion,
    };
    const first = settle(generateRecipeSet(dependencies, input));
    const second = settle(generateRecipeSet(dependencies, input));

    try {
      await flushAsyncWork();
      const secondResult = await second;
      expect(secondResult).toMatchObject({
        value: {
          replayed: false,
          response: {
            session: {
              state: "RECIPE_SELECTION",
              version: context.expectedVersion + 1,
            },
          },
        },
      });
      expect(primaryProvider.generateCalls).toBe(2);
      expect(fallbackProvider.generateCalls).toBe(0);

      const repository = createGenerateTransactionRepository(context.database.db);
      expect(() =>
        repository.renewIdempotencyLease({
          requestId,
          expectedVersion: context.expectedVersion,
          leaseOwner: "owner-a",
          leaseExpiresAt: new Date(clock.now().getTime() + 1_000),
          now: clock.now(),
        }),
      ).toThrowError(/IDEMPOTENCY_LEASE_LOST/);
      expect(() =>
        repository.deleteIdempotencyRecord({
          requestId,
          leaseOwner: "owner-a",
          now: clock.now(),
        }),
      ).toThrowError(/IDEMPOTENCY_LEASE_LOST/);

      primaryProvider.release();
      expect(await first).toMatchObject({
        error: { code: "IDEMPOTENCY_LEASE_LOST" },
      });

      expect(context.database.db.select().from(recipeSets).all()).toHaveLength(1);
      expect(
        context.database.db
          .select()
          .from(decisionEvents)
          .all()
          .filter((row) => row.eventType === "recipe_set_generated"),
      ).toHaveLength(1);
      expect(context.database.db.select().from(recipes).all()).toHaveLength(3);
      expect(context.database.db.select().from(safetyDecisions).all()).toHaveLength(3);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "RECIPE_SELECTION",
        version: context.expectedVersion + 1,
      });
    } finally {
      primaryProvider.release();
      await Promise.allSettled([first, second]);
      context.database.cleanup();
    }
  });
});

describe("selectRecipe", () => {
  it("rejects selecting when the chosen recipe is missing a Safety decision and leaves no writes", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const selectedRecipeId = candidateSet.recipes[0].id;

    try {
      seedRecipeSelectionState(
        context.database,
        context.sessionId,
        context.expectedVersion,
        candidateSet,
        {},
      );
      context.database.db
        .delete(safetyDecisions)
        .where(eq(safetyDecisions.recipeId, selectedRecipeId))
        .run();
      const initialIdempotencyCount = context.database.db
        .select()
        .from(idempotencyRecords)
        .all().length;

      expect(() =>
        selectRecipe(createSelectionDependencies(context.database), {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion + 1,
          recipeId: selectedRecipeId,
          warningAcknowledged: true,
        }),
      ).toThrowError(/RECIPE_SAFETY/);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "RECIPE_SELECTION",
        version: context.expectedVersion + 1,
        selectedRecipeId: null,
        currentStep: null,
      });
      expect(context.database.db.select().from(sessionMutationLeases).all()).toHaveLength(0);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(
        initialIdempotencyCount,
      );
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects duplicate Safety decisions for the chosen recipe and leaves no writes", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const selectedRecipeId = candidateSet.recipes[0].id;

    try {
      seedRecipeSelectionState(
        context.database,
        context.sessionId,
        context.expectedVersion,
        { ...candidateSet, recommendedRecipeId: selectedRecipeId },
        {},
      );
      const initialIdempotencyCount = context.database.db
        .select()
        .from(idempotencyRecords)
        .all().length;
      expect(() =>
        selectRecipe(
          createDuplicateDecisionSelectionDependencies(context.database, selectedRecipeId),
          {
            sessionId: context.sessionId,
            requestId: randomUUID(),
            expectedVersion: context.expectedVersion + 1,
            recipeId: selectedRecipeId,
            warningAcknowledged: true,
          },
        ),
      ).toThrowError(/RECIPE_SAFETY/);
      expect(context.database.db.select().from(sessions).all()[0]?.selectedRecipeId).toBeNull();
      expect(context.database.db.select().from(sessionMutationLeases).all()).toHaveLength(0);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(
        initialIdempotencyCount,
      );
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects a mismatch between recipe safetyLevel and persisted Safety decision", async () => {
    const context = await createReadyContext();
    const candidateSet = baseCandidateSet();
    const selectedRecipeId = candidateSet.recipes[2].id;

    try {
      seedRecipeSelectionState(
        context.database,
        context.sessionId,
        context.expectedVersion,
        candidateSet,
        { [selectedRecipeId]: "WARN" },
      );
      context.database.db
        .update(recipes)
        .set({ safetyLevel: "ALLOW" })
        .where(eq(recipes.id, selectedRecipeId))
        .run();
      const initialIdempotencyCount = context.database.db
        .select()
        .from(idempotencyRecords)
        .all().length;

      expect(() =>
        selectRecipe(createSelectionDependencies(context.database), {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion + 1,
          recipeId: selectedRecipeId,
          warningAcknowledged: true,
        }),
      ).toThrowError(/RECIPE_SAFETY/);
      expect(context.database.db.select().from(sessions).all()[0]?.selectedRecipeId).toBeNull();
      expect(context.database.db.select().from(sessionMutationLeases).all()).toHaveLength(0);
      expect(context.database.db.select().from(idempotencyRecords).all()).toHaveLength(
        initialIdempotencyCount,
      );
    } finally {
      context.database.cleanup();
    }
  });

  it("requires warning acknowledgement before selecting a WARN recipe and enters MIXING at step 0 on success", async () => {
    const context = await createReadyContext();
    const warnSet = baseCandidateSet();
    const warnedRecipeId = warnSet.recipes[2].id;
    const selectDependencies = createSelectionDependencies(context.database);

    try {
      seedRecipeSelectionState(
        context.database,
        context.sessionId,
        context.expectedVersion,
        warnSet,
        {
          [warnedRecipeId]: "WARN",
        },
      );

      expect(() =>
        selectRecipe(selectDependencies, {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion + 1,
          recipeId: warnedRecipeId,
          warningAcknowledged: false,
        }),
      ).toThrow(WarningAcknowledgementRequiredError);

      const result = await selectRecipe(selectDependencies, {
        sessionId: context.sessionId,
        requestId: randomUUID(),
        expectedVersion: context.expectedVersion + 1,
        recipeId: warnedRecipeId,
        warningAcknowledged: true,
      });

      expect(result.response.session).toMatchObject({
        state: "MIXING",
        version: context.expectedVersion + 2,
      });
      expect(result.response.data.currentStep).toBe(0);
      expect(context.database.db.select().from(sessions).all()[0]).toMatchObject({
        state: "MIXING",
        currentStep: 0,
        selectedRecipeId: warnedRecipeId,
      });
    } finally {
      context.database.cleanup();
    }
  });

  it("rejects selecting a BLOCK recipe", async () => {
    const context = await createReadyContext();
    const blockSet = baseCandidateSet();
    const blockedRecipeId = blockSet.recipes[0].id;

    try {
      seedRecipeSelectionState(
        context.database,
        context.sessionId,
        context.expectedVersion,
        blockSet,
        {
          [blockedRecipeId]: "BLOCK",
        },
      );

      expect(() =>
        selectRecipe(createSelectionDependencies(context.database), {
          sessionId: context.sessionId,
          requestId: randomUUID(),
          expectedVersion: context.expectedVersion + 1,
          recipeId: blockedRecipeId,
          warningAcknowledged: true,
        }),
      ).toThrowError(/RECIPE_BLOCKED/);
    } finally {
      context.database.cleanup();
    }
  });

  it("replays a successful selection for the same requestId and rejects a body conflict", async () => {
    const context = await createReadyContext();
    const warnSet = baseCandidateSet();
    const warnedRecipeId = warnSet.recipes[2].id;
    const dependencies = createSelectionDependencies(context.database);
    const requestId = randomUUID();

    try {
      seedRecipeSelectionState(
        context.database,
        context.sessionId,
        context.expectedVersion,
        warnSet,
        { [warnedRecipeId]: "WARN" },
      );

      const first = selectRecipe(dependencies, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: context.expectedVersion + 1,
        recipeId: warnedRecipeId,
        warningAcknowledged: true,
      });
      const replay = selectRecipe(dependencies, {
        sessionId: context.sessionId,
        requestId,
        expectedVersion: context.expectedVersion + 1,
        recipeId: warnedRecipeId,
        warningAcknowledged: true,
      });

      expect(replay.replayed).toBe(true);
      expect(replay.response).toEqual(first.response);

      expect(() =>
        selectRecipe(dependencies, {
          sessionId: context.sessionId,
          requestId,
          expectedVersion: context.expectedVersion + 1,
          recipeId: warnedRecipeId,
          warningAcknowledged: false,
        }),
      ).toThrowError(/IDEMPOTENCY_KEY_REUSED/);
    } finally {
      context.database.cleanup();
    }
  });
});
