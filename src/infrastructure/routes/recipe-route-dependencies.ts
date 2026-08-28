import OpenAI from "openai";

import type { GenerateRecipeSetDependencies } from "@/src/application/generate-recipe-set";
import type { AdvanceMixingDependencies } from "@/src/application/advance-mixing";
import type { SelectRecipeDependencies } from "@/src/application/select-recipe";
import type { SaveFeedbackDependencies } from "@/src/application/save-feedback";
import type { GenerateAdjustmentDependencies } from "@/src/application/generate-adjustment";
import type { AcceptAdjustmentDependencies } from "@/src/application/accept-adjustment";
import type { CompleteSessionDependencies } from "@/src/application/complete-session";
import {
  createAdjustmentUnitOfWork,
  createFeedbackUnitOfWork,
} from "@/src/application/unit-of-work";
import { parseEnv } from "@/src/config/env";
import { createDatabase, type DatabaseHandle } from "@/src/infrastructure/db/client";
import { decisionEvents, safetyDecisions } from "@/src/infrastructure/db/schema";
import { withTransaction } from "@/src/infrastructure/db/transaction";
import { DrizzleIngredientRepository } from "@/src/infrastructure/repositories/drizzle-ingredient-repository";
import { DrizzleRecipeRepository } from "@/src/infrastructure/repositories/drizzle-recipe-repository";
import { DrizzleSessionRepository } from "@/src/infrastructure/repositories/drizzle-session-repository";
import { FallbackRecipeProvider } from "@/src/infrastructure/providers/fallback-recipe-provider";
import { QwenRecipeProvider } from "@/src/infrastructure/providers/qwen-recipe-provider";
import type {
  QwenCompletionClient,
  QwenCompletionRequest,
  RecipeProvider,
} from "@/src/providers/recipe-provider";

export class OpenAIQwenRecipeClient implements QwenCompletionClient {
  private readonly client: OpenAI;

  constructor(options: { apiKey: string; baseURL: string }) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
    });
  }

  async complete(request: QwenCompletionRequest): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: request.model,
        messages: [{ role: "user", content: request.prompt }],
        temperature: 0,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.operation === "generate" ? "recipe_candidate_set" : "recipe_candidate",
            strict: true,
            schema: request.jsonSchema as Record<string, unknown>,
          },
        },
      },
      {
        maxRetries: 0,
        timeout: request.timeoutMs,
        signal: request.signal,
      },
    );
    const content = response.choices[0]?.message.content;
    if (content === null || content === undefined) {
      throw new Error("QWEN_RECIPE_RESPONSE_EMPTY");
    }
    return content;
  }
}

let defaultDatabaseHandle: DatabaseHandle | null = null;

function getDatabaseHandle(): DatabaseHandle {
  if (defaultDatabaseHandle === null) {
    const environment = parseEnv();
    defaultDatabaseHandle = createDatabase(environment.DATABASE_PATH);
    defaultDatabaseHandle.applyMigrations();
  }
  return defaultDatabaseHandle;
}

function createRecipeProviders(): {
  primaryProvider: RecipeProvider;
  fallbackProvider: RecipeProvider;
  primarySourceMode: "fallback" | "qwen";
} {
  const environment = parseEnv();
  const fallbackProvider = new FallbackRecipeProvider();

  if (environment.AI_MODE === "qwen") {
    return {
      primaryProvider: new QwenRecipeProvider({
        client: new OpenAIQwenRecipeClient({
          apiKey: environment.DASHSCOPE_API_KEY,
          baseURL: environment.QWEN_BASE_URL,
        }),
        model: environment.QWEN_RECIPE_MODEL,
        fallback: fallbackProvider,
      }),
      fallbackProvider,
      primarySourceMode: "qwen",
    };
  }

  return {
    primaryProvider: fallbackProvider,
    fallbackProvider,
    primarySourceMode: "fallback",
  };
}

export function createDefaultGenerateRecipeSetDependencies(): GenerateRecipeSetDependencies {
  const database = getDatabaseHandle().db;
  const providers = createRecipeProviders();

  return {
    read: () => {
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
        listBySession: (sessionId: string) => ingredientRepository.listBySession(sessionId),
        replaceForSession: (
          input: Parameters<DrizzleIngredientRepository["replaceForSession"]>[0],
        ) => ingredientRepository.replaceForSession(input),
        findSetBySession: (sessionId: string) => recipeRepository.findSetBySession(sessionId),
        listBySet: (recipeSetId: string) => recipeRepository.listBySet(recipeSetId),
        listSafetyDecisionsBySet: (recipeSetId: string) =>
          recipeRepository.listSafetyDecisionsBySet(recipeSetId),
        listDecisionEvents: (sessionId: string) => recipeRepository.listDecisionEvents(sessionId),
      };
    },
    transaction: (operation) =>
      withTransaction(database, (transaction) => {
        const sessionRepository = new DrizzleSessionRepository(transaction);
        const ingredientRepository = new DrizzleIngredientRepository(transaction);
        const recipeRepository = new DrizzleRecipeRepository(transaction);
        return operation({
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
          replaceForSession: (
            input: Parameters<DrizzleIngredientRepository["replaceForSession"]>[0],
          ) => ingredientRepository.replaceForSession(input),
          createRecipeSet: (input: Parameters<DrizzleRecipeRepository["createRecipeSet"]>[0]) =>
            recipeRepository.createRecipeSet(input),
          setRecommendedRecipe: (
            recipeSetId: Parameters<DrizzleRecipeRepository["setRecommendedRecipe"]>[0],
            recipeId: Parameters<DrizzleRecipeRepository["setRecommendedRecipe"]>[1],
          ) => recipeRepository.setRecommendedRecipe(recipeSetId, recipeId),
          createRecipe: (input: Parameters<DrizzleRecipeRepository["createRecipe"]>[0]) =>
            recipeRepository.createRecipe(input),
          createSafetyDecision: (input) => {
            transaction
              .insert(safetyDecisions)
              .values({
                id: crypto.randomUUID(),
                recipeId: input.recipeId,
                level: input.level,
                ruleHitsJson: JSON.stringify(input.ruleHits),
                engineVersion: input.engineVersion,
              })
              .run();
          },
          createDecisionEvent: (input) => {
            transaction
              .insert(decisionEvents)
              .values({
                id: crypto.randomUUID(),
                sessionId: input.sessionId,
                eventType: input.event.type,
                summary: input.event.summary,
                metadataJson: JSON.stringify(input.event.metadata),
              })
              .run();
          },
        });
      }),
    primaryProvider: providers.primaryProvider,
    fallbackProvider: providers.fallbackProvider,
    primarySourceMode: providers.primarySourceMode,
  };
}

export function createDefaultSelectRecipeDependencies(): SelectRecipeDependencies {
  const database = getDatabaseHandle().db;

  return {
    read: () => {
      const sessionRepository = new DrizzleSessionRepository(database);
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
        findSetBySession: (sessionId: string) => recipeRepository.findSetBySession(sessionId),
        listBySet: (recipeSetId: string) => recipeRepository.listBySet(recipeSetId),
        listSafetyDecisionsBySet: (recipeSetId: string) =>
          recipeRepository.listSafetyDecisionsBySet(recipeSetId),
      };
    },
    transaction: (operation) =>
      withTransaction(database, (transaction) => {
        const sessionRepository = new DrizzleSessionRepository(transaction);
        const recipeRepository = new DrizzleRecipeRepository(transaction);
        return operation({
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
          findSetBySession: (sessionId: string) => recipeRepository.findSetBySession(sessionId),
          listBySet: (recipeSetId: string) => recipeRepository.listBySet(recipeSetId),
          listSafetyDecisionsBySet: (recipeSetId: string) =>
            recipeRepository.listSafetyDecisionsBySet(recipeSetId),
        });
      }),
  };
}

export function createDefaultAdvanceMixingDependencies(): AdvanceMixingDependencies {
  const database = getDatabaseHandle().db;

  return {
    read: () => {
      const sessionRepository = new DrizzleSessionRepository(database);
      const recipeRepository = new DrizzleRecipeRepository(database);
      return {
        findById: (id: string) => sessionRepository.findById(id),
        findIdempotencyRecordByRequestId: (requestId: string) =>
          sessionRepository.findIdempotencyRecordByRequestId(requestId),
        findRecipeById: (id: string) => recipeRepository.findById(id),
      };
    },
    transaction: (operation) =>
      withTransaction(database, (transaction) => {
        const sessionRepository = new DrizzleSessionRepository(transaction);
        const recipeRepository = new DrizzleRecipeRepository(transaction);
        return operation({
          findById: (id: string) => sessionRepository.findById(id),
          findIdempotencyRecordByRequestId: (requestId: string) =>
            sessionRepository.findIdempotencyRecordByRequestId(requestId),
          findRecipeById: (id: string) => recipeRepository.findById(id),
          updateVersion: (input: Parameters<DrizzleSessionRepository["updateVersion"]>[0]) =>
            sessionRepository.updateVersion(input),
          saveIdempotencyRecord: (
            input: Parameters<DrizzleSessionRepository["saveIdempotencyRecord"]>[0],
          ) => sessionRepository.saveIdempotencyRecord(input),
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
        });
      }),
  };
}

export function createDefaultSaveFeedbackDependencies(): SaveFeedbackDependencies {
  return createFeedbackUnitOfWork(getDatabaseHandle().db);
}

export function createDefaultGenerateAdjustmentDependencies(): GenerateAdjustmentDependencies {
  const providers = createRecipeProviders();
  return {
    ...createAdjustmentUnitOfWork(getDatabaseHandle().db),
    primaryProvider: providers.primaryProvider,
    fallbackProvider: providers.fallbackProvider,
    primarySourceMode: providers.primarySourceMode,
  };
}

export function createDefaultAcceptAdjustmentDependencies(): AcceptAdjustmentDependencies {
  return createAdjustmentUnitOfWork(getDatabaseHandle().db);
}

export function createDefaultCompleteSessionDependencies(): CompleteSessionDependencies {
  return createAdjustmentUnitOfWork(getDatabaseHandle().db);
}
