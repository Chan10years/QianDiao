import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  assertIdempotencyFingerprint,
  fingerprintRequest,
  IdempotencyInProgressError,
} from "@/src/application/idempotency";
import { sleep, systemClock, type Clock } from "@/src/application/clock";
import { SuccessEnvelopeSchema, MutationMetaSchema } from "@/src/domain/api";
import { SessionIdSchema } from "@/src/domain/id";
import { RecipeCandidateSchema, RecipeCandidateSetSchema } from "@/src/domain/recipe";
import type { DetectedIngredient } from "@/src/domain/ingredient";
import type { IngredientRepository } from "@/src/repositories/ingredient-repository";
import type {
  DecisionEventWriteInput,
  RecipeRepository,
  SafetyDecisionWriteInput,
} from "@/src/repositories/recipe-repository";
import type { IdempotencyReservationRepository } from "@/src/repositories/idempotency-reservation-repository";
import {
  SessionNotFoundError,
  SessionVersionConflictError,
  type SessionRepository,
} from "@/src/repositories/session-repository";
import type { RecipeProvider, RecipeProvenanceStage } from "@/src/providers/recipe-provider";
import {
  isOutcomeAwareRecipeProvider,
  RecipeProvenanceSchema,
} from "@/src/providers/recipe-provider";
import {
  BlockedRecipeFallbackExhaustedError,
  evaluateRecipeCandidateSafety,
  repairBlockedRecipe,
  SafetyEvaluationFailedError,
  type EvaluatedRecipeCandidate,
} from "@/src/application/repair-blocked-recipe";
import { rankRecommendation } from "@/src/agent/rank-recommendation";
import { validateCandidateSet } from "@/src/agent/validate-candidate-set";
import { evaluateSafety as defaultEvaluateSafety } from "@/src/safety/evaluate-safety";
import type { SafetyDecision, SafetyInput } from "@/src/safety/types";
import { QWEN_RECIPE_PROVIDER_WORST_CASE_EXTERNAL_CALL_MS } from "@/src/infrastructure/providers/qwen-recipe-provider";
import {
  IngredientAbvRequiredError,
  IngredientConfirmationRequiredError,
} from "@/src/application/confirm-ingredients";
import { SessionEvent, transition } from "@/src/workflow/session-machine";
import { VersionConflictError } from "@/src/application/save-preferences";
import {
  IdempotencyLeaseLostError,
  type IdempotencyLeaseAcquisition,
} from "@/src/repositories/idempotency-reservation-repository";

const IDEMPOTENCY_PENDING_STATUS_CODE = 102;
const GENERATION_LEASE_DURATION_MS = 15_000;
const IDEMPOTENCY_WAIT_ATTEMPTS = 600;
const IDEMPOTENCY_WAIT_MS = 10;
const PROVIDER_CALL_LEASE_MARGIN_MS = 1_000;
const EXTERNAL_PROVIDER_LEASE_DURATION_MS =
  QWEN_RECIPE_PROVIDER_WORST_CASE_EXTERNAL_CALL_MS + PROVIDER_CALL_LEASE_MARGIN_MS;

const GenerateRecipeSetInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
}).strict();

const GeneratedRecipeSetSchema = z
  .object({
    recipeSet: z
      .object({
        id: z.string().uuid(),
        sourceMode: z.enum(["fallback", "qwen"]),
        degraded: z.boolean(),
        provenance: RecipeProvenanceSchema,
        recommendedRecipeId: z.string().uuid(),
        recipes: z.array(RecipeCandidateSchema).length(3),
      })
      .strict(),
  })
  .strict();

const GenerateRecipeSetResponseSchema = SuccessEnvelopeSchema(GeneratedRecipeSetSchema);

export type GenerateRecipeSetInput = z.input<typeof GenerateRecipeSetInputSchema>;
export type GenerateRecipeSetResponse = z.infer<typeof GenerateRecipeSetResponseSchema>;

export interface GenerateRecipeSetResult {
  requestId: string;
  response: GenerateRecipeSetResponse;
  replayed: boolean;
}

export type GenerateRecipeSetReadRepository = SessionRepository &
  IngredientRepository &
  Pick<
    RecipeRepository,
    "findSetBySession" | "listBySet" | "listSafetyDecisionsBySet" | "listDecisionEvents"
  >;
export type GenerateRecipeSetTransactionRepository = SessionRepository &
  IngredientRepository &
  Pick<RecipeRepository, "createRecipeSet" | "createRecipe" | "setRecommendedRecipe"> &
  IdempotencyReservationRepository & {
    createSafetyDecision(input: SafetyDecisionWriteInput): void;
    createDecisionEvent(input: { sessionId: string; event: DecisionEventWriteInput }): void;
  };

export interface GenerateRecipeSetDependencies {
  read(): GenerateRecipeSetReadRepository;
  transaction<T>(operation: (repository: GenerateRecipeSetTransactionRepository) => T): T;
  primaryProvider: RecipeProvider;
  fallbackProvider: RecipeProvider;
  primarySourceMode?: "fallback" | "qwen";
  evaluateSafety?: (input: SafetyInput) => SafetyDecision;
  clock?: Clock;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseDurationMs?: number;
  maxWaitAttempts?: number;
  leaseOwnerFactory?: () => string;
}

export class RecipeGenerationBlockedError extends Error {
  readonly code = "SAFETY_BLOCKED";

  constructor() {
    super("SAFETY_BLOCKED");
    this.name = "RecipeGenerationBlockedError";
  }
}

export class RecipeProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";

  constructor() {
    super("PROVIDER_UNAVAILABLE");
    this.name = "RecipeProviderUnavailableError";
  }
}

function parseStoredResponse(response: Record<string, unknown>): GenerateRecipeSetResponse {
  return GenerateRecipeSetResponseSchema.parse(response);
}

function replayFromRecord(
  requestId: string,
  record: { response: Record<string, unknown> },
): GenerateRecipeSetResult {
  return {
    requestId,
    response: parseStoredResponse(record.response),
    replayed: true,
  };
}

function isPendingIdempotencyRecord(record: { statusCode: number }): boolean {
  return record.statusCode === IDEMPOTENCY_PENDING_STATUS_CODE;
}

function hasActiveLease(
  record: { leaseOwner: string | null; leaseExpiresAt: Date | null },
  now: Date,
): boolean {
  return (
    record.leaseOwner !== null &&
    record.leaseExpiresAt !== null &&
    record.leaseExpiresAt.getTime() > now.getTime()
  );
}

async function resolveIdempotencyRecord(
  dependencies: GenerateRecipeSetDependencies,
  requestId: string,
  requestFingerprint: string,
  clock: Clock,
  wait: (milliseconds: number) => Promise<void>,
  maxWaitAttempts: number,
): Promise<GenerateRecipeSetResult | null> {
  for (let attempt = 0; attempt < maxWaitAttempts; attempt += 1) {
    const record = dependencies.read().findIdempotencyRecordByRequestId(requestId);
    if (record === null) {
      return null;
    }

    assertIdempotencyFingerprint(record, requestFingerprint);
    if (!isPendingIdempotencyRecord(record)) {
      return replayFromRecord(requestId, record);
    }
    if (!hasActiveLease(record, clock.now())) {
      return null;
    }
    await wait(IDEMPOTENCY_WAIT_MS);
  }

  throw new IdempotencyInProgressError();
}

function acquireIdempotencyLease(
  dependencies: GenerateRecipeSetDependencies,
  input: GenerateRecipeSetInput,
  requestFingerprint: string,
  leaseOwner: string,
  leaseExpiresAt: Date,
  now: Date,
): IdempotencyLeaseAcquisition {
  try {
    return dependencies.transaction((repository) =>
      repository.acquireIdempotencyLease({
        id: randomUUID(),
        sessionId: input.sessionId,
        requestId: input.requestId,
        requestFingerprint,
        expectedVersion: input.expectedVersion,
        response: { pending: true },
        statusCode: IDEMPOTENCY_PENDING_STATUS_CODE,
        leaseOwner,
        leaseExpiresAt,
        now,
      }),
    );
  } catch (error) {
    if (error instanceof SessionVersionConflictError) {
      throw new VersionConflictError();
    }
    throw error;
  }
}

function releaseIdempotencyRecord(
  dependencies: GenerateRecipeSetDependencies,
  requestId: string,
  leaseOwner: string,
  now: Date,
): void {
  try {
    dependencies.transaction((repository) => {
      repository.deleteIdempotencyRecord({ requestId, leaseOwner, now });
    });
  } catch (error) {
    if (error instanceof IdempotencyLeaseLostError) {
      return;
    }
    throw error;
  }
}

function assertReadyInput(
  session: {
    state: string;
    preferences: GenerateRecipeSetDependencies extends never ? never : unknown;
    currentStep: number | null;
  },
  ingredients: readonly DetectedIngredient[],
): readonly DetectedIngredient[] {
  if (ingredients.length === 0 || ingredients.some((ingredient) => ingredient.confirmed !== true)) {
    throw new IngredientConfirmationRequiredError();
  }
  if (
    ingredients.some((ingredient) => ingredient.category === "spirit" && ingredient.abv === null)
  ) {
    throw new IngredientAbvRequiredError();
  }

  transition(session.state as never, SessionEvent.GENERATE_RECIPE_SET, {
    hasPreferences: session.preferences !== null,
    hasOverviewImage: true,
    allIngredientsConfirmed: true,
    alcoholAbvConfirmed: true,
    hasRecipeSet: session.state === "RECIPE_SELECTION",
    hasSelectedRecipe: false,
    hasSelectedAdjustedRecipe: false,
    currentStep: session.currentStep,
    totalSteps: null,
    hasFeedback: false,
  });

  return ingredients;
}

function runSafetyPrecheck(
  ingredients: readonly DetectedIngredient[],
  evaluateSafety: (input: SafetyInput) => SafetyDecision,
): void {
  let precheck: SafetyDecision;
  try {
    precheck = evaluateSafety({
      ingredients: ingredients.map((ingredient, index) => ({
        name: ingredient.canonicalName,
        canonicalName: ingredient.canonicalName,
        category: ingredient.category,
        volumeMl: ingredient.category === "spirit" ? 30 : index === 0 ? 30 : 60,
        abv: ingredient.abv,
        confirmed: ingredient.confirmed,
      })),
    });
  } catch {
    throw new SafetyEvaluationFailedError();
  }
  if (precheck.level === "BLOCK") {
    throw new RecipeGenerationBlockedError();
  }
}

function toRecipeProviderIngredient(ingredient: DetectedIngredient): DetectedIngredient {
  return {
    rawName: ingredient.rawName,
    canonicalName: ingredient.canonicalName,
    category: ingredient.category,
    brand: ingredient.brand,
    abv: ingredient.abv,
    confidence: ingredient.confidence,
    confirmed: ingredient.confirmed,
  };
}

async function generateCandidateSet(
  dependencies: GenerateRecipeSetDependencies,
  preferences: GenerateRecipeSetDependencies extends never
    ? never
    : {
        sweetness: 1 | 2 | 3 | 4 | 5;
        acidity: 1 | 2 | 3 | 4 | 5;
        alcoholIntensity: 1 | 2 | 3 | 4 | 5;
        body: 1 | 2 | 3 | 4 | 5;
      },
  ingredients: readonly DetectedIngredient[],
  renewLease: () => Promise<void>,
): Promise<{
  candidateSet: z.infer<typeof RecipeCandidateSetSchema>;
  sourceMode: "fallback" | "qwen";
  degraded: boolean;
  provenanceStages: readonly RecipeProvenanceStage[];
}> {
  const providerIngredients = ingredients.map(toRecipeProviderIngredient);
  const allowedMaterialNames = providerIngredients.map((ingredient) => ingredient.canonicalName);
  const primarySourceMode = dependencies.primarySourceMode ?? "qwen";
  await renewLease();

  let generatedSet: Awaited<ReturnType<RecipeProvider["generate"]>>;
  let sourceMode = primarySourceMode;
  let degraded = false;
  let provenanceStages: readonly RecipeProvenanceStage[] = [];
  try {
    if (isOutcomeAwareRecipeProvider(dependencies.primaryProvider)) {
      const outcome = await dependencies.primaryProvider.generateWithOutcome(
        {
          preferences,
          ingredients: providerIngredients,
        },
        { beforeExternalCall: renewLease },
      );
      generatedSet = outcome.value;
      sourceMode = outcome.sourceMode;
      degraded = outcome.degraded;
      provenanceStages = outcome.provenanceStages ?? [
        {
          phase: "generate",
          attempt: 0,
          sourceMode,
          degraded,
          outcome: sourceMode === "fallback" && degraded ? "fallback" : "accepted",
        },
      ];
    } else {
      generatedSet = await dependencies.primaryProvider.generate({
        preferences,
        ingredients: providerIngredients,
      });
      provenanceStages = [
        {
          phase: "generate",
          attempt: 0,
          sourceMode,
          degraded,
          outcome: "accepted",
        },
      ];
    }
  } catch (error) {
    if (error instanceof IdempotencyLeaseLostError) {
      throw error;
    }
    throw new RecipeProviderUnavailableError();
  }

  return {
    candidateSet: validateCandidateSet(generatedSet, { allowedMaterialNames }),
    sourceMode,
    degraded,
    provenanceStages,
  };
}

async function finalizeCandidates(
  dependencies: GenerateRecipeSetDependencies,
  candidateSet: z.infer<typeof RecipeCandidateSetSchema>,
  preferences: {
    sweetness: 1 | 2 | 3 | 4 | 5;
    acidity: 1 | 2 | 3 | 4 | 5;
    alcoholIntensity: 1 | 2 | 3 | 4 | 5;
    body: 1 | 2 | 3 | 4 | 5;
  },
  ingredients: readonly DetectedIngredient[],
  evaluateSafety: (input: SafetyInput) => SafetyDecision,
  renewLease: (kind: "adjust" | "fallback-generate") => Promise<void>,
): Promise<{
  recipes: readonly EvaluatedRecipeCandidate[];
  repairedStrategies: readonly string[];
  fallbackStrategies: readonly string[];
  sourceMode: "fallback" | "qwen";
  degraded: boolean;
  provenanceStages: readonly RecipeProvenanceStage[];
}> {
  const confirmedMaterialNames = ingredients.map((ingredient) => ingredient.canonicalName);
  const evaluatedRecipes: EvaluatedRecipeCandidate[] = [];
  const repairedStrategies = new Set<string>();
  const fallbackStrategies = new Set<string>();
  const provenanceStages: RecipeProvenanceStage[] = [];

  for (const candidate of candidateSet.recipes) {
    let evaluated: EvaluatedRecipeCandidate;
    try {
      evaluated = evaluateRecipeCandidateSafety(candidate, ingredients, evaluateSafety);
    } catch {
      throw new SafetyEvaluationFailedError();
    }
    if (evaluated.safetyDecision.level !== "BLOCK") {
      evaluatedRecipes.push(evaluated);
      continue;
    }

    let repaired: EvaluatedRecipeCandidate & {
      repaired: boolean;
      repairAttempts: number;
      fallbackUsed: boolean;
      sourceMode: "fallback" | "qwen";
      degraded: boolean;
      provenanceStages: readonly RecipeProvenanceStage[];
    };
    try {
      repaired = await repairBlockedRecipe({
        preferences,
        candidate,
        confirmedIngredients: ingredients,
        confirmedMaterialNames,
        primaryProvider: dependencies.primaryProvider,
        fallbackProvider: dependencies.fallbackProvider,
        primarySourceMode: dependencies.primarySourceMode,
        evaluateSafety,
        initialEvaluation: evaluated,
        beforeExternalCall: renewLease,
      });
    } catch (error) {
      if (error instanceof BlockedRecipeFallbackExhaustedError) {
        throw new RecipeProviderUnavailableError();
      }
      throw error;
    }
    evaluatedRecipes.push(repaired);
    provenanceStages.push(...repaired.provenanceStages);
    repairedStrategies.add(candidate.strategy);
    if (repaired.fallbackUsed) {
      fallbackStrategies.add(candidate.strategy);
    }
  }

  return {
    recipes: evaluatedRecipes,
    repairedStrategies: [...repairedStrategies],
    fallbackStrategies: [...fallbackStrategies],
    sourceMode: provenanceStages.some((stage) => stage.sourceMode === "fallback")
      ? "fallback"
      : "qwen",
    degraded: provenanceStages.some((stage) => stage.degraded),
    provenanceStages,
  };
}

function renewProviderLease(
  dependencies: GenerateRecipeSetDependencies,
  input: { requestId: string; expectedVersion: number },
  leaseOwner: string,
  clock: Clock,
): void {
  const now = clock.now();
  dependencies.transaction((repository) => {
    repository.renewIdempotencyLease({
      requestId: input.requestId,
      expectedVersion: input.expectedVersion,
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + EXTERNAL_PROVIDER_LEASE_DURATION_MS),
      now,
    });
  });
}

function resolveRankInputRecommendedRecipeId(
  generated: z.infer<typeof RecipeCandidateSetSchema>,
  finalized: readonly EvaluatedRecipeCandidate[],
): z.infer<typeof RecipeCandidateSetSchema>["recommendedRecipeId"] {
  const finalizedIds = new Set(finalized.map((item) => item.candidate.id));
  if (finalizedIds.has(generated.recommendedRecipeId)) {
    return generated.recommendedRecipeId;
  }

  const originalRecommendedStrategy =
    generated.recipes.find((candidate) => candidate.id === generated.recommendedRecipeId)
      ?.strategy ?? null;
  const matchingStrategyCandidate =
    originalRecommendedStrategy === null
      ? undefined
      : finalized.find((item) => item.candidate.strategy === originalRecommendedStrategy)
          ?.candidate;

  return matchingStrategyCandidate?.id ?? finalized[0]?.candidate.id ?? generated.recipes[0].id;
}

function buildEventSummary(
  sourceMode: "fallback" | "qwen",
  degraded: boolean,
  repairedStrategies: readonly string[],
): string {
  if (sourceMode === "fallback" && degraded) {
    return "主 Provider 未能稳定完成全部生成或修复，已降级补齐三套可选配方。";
  }
  if (sourceMode === "fallback") {
    return "已生成三套本地保底配方并完成确定性 Safety 审核。";
  }
  if (repairedStrategies.length > 0) {
    return "已生成三套配方，并对危险候选执行修复或本地替换。";
  }
  return "已生成三套配方并完成确定性 Safety 审核。";
}

export async function generateRecipeSet(
  dependencies: GenerateRecipeSetDependencies,
  input: unknown,
): Promise<GenerateRecipeSetResult> {
  const parsed = GenerateRecipeSetInputSchema.parse(input);
  const clock = dependencies.clock ?? systemClock;
  const wait = dependencies.sleep ?? sleep;
  const maxWaitAttempts = dependencies.maxWaitAttempts ?? IDEMPOTENCY_WAIT_ATTEMPTS;
  const leaseDurationMs = dependencies.leaseDurationMs ?? GENERATION_LEASE_DURATION_MS;
  const leaseOwner = dependencies.leaseOwnerFactory?.() ?? randomUUID();
  const evaluateSafety = dependencies.evaluateSafety ?? defaultEvaluateSafety;
  const requestFingerprint = fingerprintRequest({
    operation: "generate-recipe-set",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
  });

  for (let reservationAttempt = 0; reservationAttempt < 8; reservationAttempt += 1) {
    const existing = await resolveIdempotencyRecord(
      dependencies,
      parsed.requestId,
      requestFingerprint,
      clock,
      wait,
      maxWaitAttempts,
    );
    if (existing !== null) {
      return existing;
    }

    const session = dependencies.read().findById(parsed.sessionId);
    if (session === null) {
      throw new SessionNotFoundError();
    }
    if (session.version !== parsed.expectedVersion) {
      throw new VersionConflictError();
    }
    const ingredients = assertReadyInput(
      session,
      dependencies.read().listBySession(parsed.sessionId),
    );
    runSafetyPrecheck(ingredients, evaluateSafety);

    const acquisition = acquireIdempotencyLease(
      dependencies,
      parsed,
      requestFingerprint,
      leaseOwner,
      new Date(clock.now().getTime() + leaseDurationMs),
      clock.now(),
    );
    if (acquisition.status === "conflict") {
      assertIdempotencyFingerprint(acquisition.record, requestFingerprint);
    }
    if (acquisition.status === "completed") {
      return replayFromRecord(parsed.requestId, acquisition.record);
    }
    if (acquisition.status === "busy") {
      continue;
    }

    try {
      const generated = await generateCandidateSet(
        dependencies,
        session.preferences ?? {
          sweetness: 3,
          acidity: 3,
          alcoholIntensity: 3,
          body: 3,
        },
        ingredients,
        async () => {
          renewProviderLease(
            dependencies,
            {
              requestId: parsed.requestId,
              expectedVersion: parsed.expectedVersion,
            },
            leaseOwner,
            clock,
          );
        },
      );
      const finalized = await finalizeCandidates(
        dependencies,
        generated.candidateSet,
        session.preferences ?? {
          sweetness: 3,
          acidity: 3,
          alcoholIntensity: 3,
          body: 3,
        },
        ingredients,
        evaluateSafety,
        async () => {
          renewProviderLease(
            dependencies,
            {
              requestId: parsed.requestId,
              expectedVersion: parsed.expectedVersion,
            },
            leaseOwner,
            clock,
          );
        },
      );
      const finalSourceMode =
        generated.sourceMode === "fallback" || finalized.sourceMode === "fallback"
          ? "fallback"
          : "qwen";
      const finalDegraded = generated.degraded || finalized.degraded;
      const ranked = rankRecommendation({
        preferences: session.preferences ?? {
          sweetness: 3,
          acidity: 3,
          alcoholIntensity: 3,
          body: 3,
        },
        candidateSet: {
          recipes: finalized.recipes.map((item) => item.candidate),
          recommendedRecipeId: resolveRankInputRecommendedRecipeId(
            generated.candidateSet,
            finalized.recipes,
          ),
        },
        allowedMaterialNames: ingredients.map((ingredient) => ingredient.canonicalName),
      }).candidateSet;

      return dependencies.transaction((repository) => {
        const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);
        if (transactionExisting === null) {
          throw new Error("IDEMPOTENCY_RECORD_NOT_FOUND");
        }
        assertIdempotencyFingerprint(transactionExisting, requestFingerprint);
        if (!isPendingIdempotencyRecord(transactionExisting)) {
          throw new IdempotencyLeaseLostError();
        }
        repository.assertIdempotencyLease({
          requestId: parsed.requestId,
          expectedVersion: parsed.expectedVersion,
          leaseOwner,
          now: clock.now(),
        });

        const currentSession = repository.findById(parsed.sessionId);
        if (currentSession === null) {
          throw new SessionNotFoundError();
        }
        if (currentSession.version !== parsed.expectedVersion) {
          throw new VersionConflictError();
        }

        const recipeSetId = randomUUID();
        const provenance = RecipeProvenanceSchema.parse({
          recipeSetId,
          sourceMode: finalSourceMode,
          degraded: finalDegraded,
          stages: [...generated.provenanceStages, ...finalized.provenanceStages],
        });
        repository.createRecipeSet({
          id: recipeSetId,
          sessionId: parsed.sessionId,
          sourceMode: finalSourceMode,
        });
        ranked.recipes.forEach((candidate) => {
          const decision = finalized.recipes.find((item) => item.candidate.id === candidate.id);
          if (decision === undefined) {
            throw new Error(`SAFETY_DECISION_MISSING:${candidate.id}`);
          }
          repository.createRecipe({
            recipeSetId,
            sessionId: parsed.sessionId,
            candidate,
          });
          repository.createSafetyDecision({
            recipeId: candidate.id,
            level: decision.safetyDecision.level,
            ruleHits: decision.safetyDecision.hits,
            engineVersion: "1.0.0",
          });
        });
        repository.setRecommendedRecipe(recipeSetId, ranked.recommendedRecipeId);
        repository.createDecisionEvent({
          sessionId: parsed.sessionId,
          event: {
            type: "recipe_set_generated",
            summary: buildEventSummary(
              finalSourceMode,
              finalDegraded,
              finalized.repairedStrategies,
            ),
            metadata: {
              sourceMode: finalSourceMode,
              degraded: finalDegraded,
              provenance,
              repairedStrategies: finalized.repairedStrategies,
              fallbackStrategies: finalized.fallbackStrategies,
            },
          },
        });
        const updatedSession = repository.updateVersion({
          id: parsed.sessionId,
          expectedVersion: parsed.expectedVersion,
          leaseOwner,
          leaseNow: clock.now(),
          state: "RECIPE_SELECTION",
          currentStep: null,
        });

        const response: GenerateRecipeSetResponse = {
          data: {
            recipeSet: {
              id: recipeSetId,
              sourceMode: finalSourceMode,
              degraded: finalDegraded,
              provenance,
              recommendedRecipeId: ranked.recommendedRecipeId,
              recipes: ranked.recipes,
            },
          },
          session: {
            id: parsed.sessionId,
            state: "RECIPE_SELECTION",
            version: updatedSession.version,
          },
        };

        repository.completeIdempotencyRecord({
          requestId: parsed.requestId,
          leaseOwner,
          now: clock.now(),
          response,
          statusCode: 201,
        });

        return {
          requestId: parsed.requestId,
          response,
          replayed: false,
        };
      });
    } catch (error) {
      try {
        releaseIdempotencyRecord(dependencies, parsed.requestId, leaseOwner, clock.now());
      } catch {
        // A failed cleanup leaves the pending reservation for lease-expiry recovery.
      }
      if (error instanceof RecipeProviderUnavailableError) {
        throw error;
      }
      if (
        error instanceof SessionVersionConflictError ||
        (error instanceof Error && error.message === "VERSION_CONFLICT")
      ) {
        throw new VersionConflictError();
      }
      if (
        error instanceof z.ZodError ||
        error instanceof RecipeGenerationBlockedError ||
        error instanceof IngredientAbvRequiredError ||
        error instanceof IngredientConfirmationRequiredError
      ) {
        throw error;
      }
      if (
        error instanceof Error &&
        (error.message.includes("INVALID_SCHEMA") ||
          error.message.includes("INVALID_CANDIDATE_CONSTRAINT") ||
          error.message.includes("DUPLICATE_CANDIDATE"))
      ) {
        throw new RecipeProviderUnavailableError();
      }
      throw error;
    }
  }

  throw new IdempotencyInProgressError();
}
