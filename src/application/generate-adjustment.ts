import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  assertIdempotencyFingerprint,
  fingerprintRequest,
  IdempotencyKeyReusedError,
  IdempotencyInProgressError,
} from "@/src/application/idempotency";
import { systemClock, type Clock } from "@/src/application/clock";
import {
  buildAdjustmentConstraints,
  AdjustmentConstraintsSchema,
} from "@/src/agent/build-adjustment-constraints";
import {
  evaluateRecipeCandidateSafety,
  repairBlockedRecipe,
  BlockedRecipeFallbackExhaustedError,
} from "@/src/application/repair-blocked-recipe";
import {
  toVersionedRecipeReadModel,
  type VersionedRecipeReadModel,
} from "@/src/application/get-current-recipe";
import { validateAdjustedCandidate } from "@/src/agent/validate-candidate-set";
import type {
  AdjustmentReadRepository,
  AdjustmentUnitOfWork,
} from "@/src/application/unit-of-work";
import { MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";
import { FeedbackSchema, type Feedback } from "@/src/domain/feedback";
import { RecipeCandidateSchema, RecipeSafetySummarySchema } from "@/src/domain/recipe";
import { SessionIdSchema } from "@/src/domain/id";
import type { RecipeRecord } from "@/src/repositories/recipe-repository";
import {
  SessionMutationInProgressError,
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";
import type { RecipeProvider, RecipeSourceMode } from "@/src/providers/recipe-provider";
import { isOutcomeAwareRecipeProvider } from "@/src/providers/recipe-provider";
import type { SafetyDecision, SafetyInput } from "@/src/safety/types";
import { evaluateSafety as defaultEvaluateSafety } from "@/src/safety/evaluate-safety";
import { VersionConflictError } from "@/src/application/save-preferences";
import {
  IngredientAbvRequiredError,
  IngredientConfirmationRequiredError,
} from "@/src/application/confirm-ingredients";
import { RecipeDataIntegrityError } from "@/src/repositories/recipe-repository";
import { IdempotencyLeaseLostError } from "@/src/repositories/idempotency-reservation-repository";

const PENDING_IDEMPOTENCY_STATUS_CODE = 102;
const DEFAULT_LEASE_DURATION_MS = 150_000;

const GenerateAdjustmentInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  feedbackId: z.string().uuid(),
}).strict();

const VersionedRecipeReadModelSchema = z
  .object({
    recipeId: z.string().uuid(),
    recipeSetId: z.string().uuid(),
    candidate: RecipeCandidateSchema,
    version: z.number().int().positive(),
    parentRecipeId: z.string().uuid().nullable(),
    feedbackId: z.string().uuid().nullable(),
    safety: RecipeSafetySummarySchema,
    isSelected: z.boolean(),
  })
  .strict();

const GenerateAdjustmentDataSchema = z
  .object({
    sessionId: SessionIdSchema,
    state: z.literal("ADJUSTMENT"),
    sessionVersion: z.number().int().nonnegative(),
    currentRecipeId: z.string().uuid(),
    proposedRecipe: VersionedRecipeReadModelSchema,
    constraints: AdjustmentConstraintsSchema,
    safety: RecipeSafetySummarySchema,
  })
  .strict();

const GenerateAdjustmentResponseSchema = SuccessEnvelopeSchema(GenerateAdjustmentDataSchema);

export type GenerateAdjustmentInput = z.input<typeof GenerateAdjustmentInputSchema>;

export interface GenerateAdjustmentResult {
  sessionId: string;
  state: "ADJUSTMENT";
  sessionVersion: number;
  currentRecipeId: string;
  proposedRecipe: VersionedRecipeReadModel;
  constraints: z.infer<typeof AdjustmentConstraintsSchema>;
  safety: z.infer<typeof RecipeSafetySummarySchema>;
}

export interface GenerateAdjustmentDependencies extends AdjustmentUnitOfWork {
  primaryProvider: RecipeProvider;
  fallbackProvider: RecipeProvider;
  primarySourceMode?: RecipeSourceMode;
  evaluateSafety?: (input: SafetyInput) => SafetyDecision;
  clock?: Clock;
  leaseDurationMs?: number;
  leaseOwnerFactory?: () => string;
}

export class AdjustmentInvalidStateError extends Error {
  readonly code = "INVALID_STATE";

  constructor() {
    super("INVALID_STATE");
    this.name = "AdjustmentInvalidStateError";
  }
}

export class AdjustmentFeedbackInvalidError extends Error {
  readonly code = "ADJUSTMENT_FEEDBACK_INVALID";

  constructor() {
    super("ADJUSTMENT_FEEDBACK_INVALID");
    this.name = "AdjustmentFeedbackInvalidError";
  }
}

export class AdjustmentProposalPendingError extends Error {
  readonly code = "ADJUSTMENT_PROPOSAL_PENDING";

  constructor() {
    super("ADJUSTMENT_PROPOSAL_PENDING");
    this.name = "AdjustmentProposalPendingError";
  }
}

export class AdjustmentProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";

  constructor() {
    super("PROVIDER_UNAVAILABLE");
    this.name = "AdjustmentProviderUnavailableError";
  }
}

export class AdjustmentSafetyBlockedError extends Error {
  readonly code = "SAFETY_BLOCKED";

  constructor() {
    super("SAFETY_BLOCKED");
    this.name = "AdjustmentSafetyBlockedError";
  }
}

export class AdjustmentSafetyEvaluationError extends Error {
  readonly code = "SAFETY_EVALUATION_FAILED";

  constructor() {
    super("SAFETY_EVALUATION_FAILED");
    this.name = "AdjustmentSafetyEvaluationError";
  }
}

function parseStoredResponse(response: Record<string, unknown>): GenerateAdjustmentResult {
  return GenerateAdjustmentResponseSchema.parse(response).data;
}

function toResponse(result: GenerateAdjustmentResult) {
  return GenerateAdjustmentResponseSchema.parse({
    data: result,
    session: {
      id: result.sessionId,
      state: result.state,
      version: result.sessionVersion,
    },
  });
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

function normalizeFeedback(record: {
  rating: number;
  accepted: boolean;
  deltas: Feedback["deltas"];
  notes: string | null;
  finalImageId: string | null;
}): Feedback {
  return FeedbackSchema.parse({
    rating: record.rating,
    accepted: record.accepted,
    deltas: record.deltas,
    ...(record.notes === null ? {} : { notes: record.notes }),
    finalImageId: record.finalImageId,
  });
}

function assertCurrentRecipe(
  repository: Pick<AdjustmentReadRepository, "findRecipeById">,
  session: { id: string; selectedRecipeId: string | null },
): RecipeRecord {
  if (session.selectedRecipeId === null) {
    throw new AdjustmentFeedbackInvalidError();
  }
  const recipe = repository.findRecipeById(session.selectedRecipeId);
  if (recipe === null || recipe.sessionId !== session.id) {
    throw new RecipeDataIntegrityError();
  }
  return recipe;
}

function assertAdjustmentInput(
  repository: AdjustmentReadRepository,
  input: { sessionId: string; expectedVersion: number; feedbackId: string },
): {
  session: NonNullable<ReturnType<AdjustmentReadRepository["findSessionById"]>>;
  currentRecipe: RecipeRecord;
  feedback: NonNullable<ReturnType<AdjustmentReadRepository["findFeedbackById"]>>;
  normalizedFeedback: Feedback;
} {
  const session = repository.findSessionById(input.sessionId);
  if (session === null) {
    throw new SessionNotFoundError();
  }
  if (session.state !== "ADJUSTMENT") {
    throw new AdjustmentInvalidStateError();
  }
  if (session.version !== input.expectedVersion) {
    throw new VersionConflictError();
  }

  const currentRecipe = assertCurrentRecipe(repository, session);
  repository.listRecipeVersionChain(currentRecipe.id);

  const feedback = repository.findFeedbackById(input.feedbackId);
  if (
    feedback === null ||
    feedback.sessionId !== input.sessionId ||
    feedback.recipeId !== currentRecipe.id ||
    feedback.accepted
  ) {
    throw new AdjustmentFeedbackInvalidError();
  }

  const feedbackHistory = repository.listFeedbackByRecipe(currentRecipe.id);
  if (feedbackHistory.at(-1)?.id !== feedback.id) {
    throw new AdjustmentFeedbackInvalidError();
  }

  const directProposals = repository
    .listRecipesBySession(input.sessionId)
    .filter(
      (recipe) =>
        recipe.parentRecipeId === currentRecipe.id &&
        recipe.version === currentRecipe.version + 1 &&
        recipe.feedbackId === feedback.id,
    );
  if (directProposals.length > 0) {
    throw new AdjustmentProposalPendingError();
  }
  const parallelProposals = repository
    .listRecipesBySession(input.sessionId)
    .filter(
      (recipe) =>
        recipe.parentRecipeId === currentRecipe.id && recipe.version === currentRecipe.version + 1,
    );
  if (parallelProposals.length > 0) {
    throw new RecipeDataIntegrityError();
  }

  return {
    session,
    currentRecipe,
    feedback,
    normalizedFeedback: normalizeFeedback(feedback),
  };
}

function assertConfirmedIngredients(
  ingredients: ReturnType<AdjustmentReadRepository["listIngredientsBySession"]>,
): ReturnType<AdjustmentReadRepository["listIngredientsBySession"]> {
  if (ingredients.length === 0 || ingredients.some((ingredient) => !ingredient.confirmed)) {
    throw new IngredientConfirmationRequiredError();
  }
  if (
    ingredients.some((ingredient) => ingredient.category === "spirit" && ingredient.abv === null)
  ) {
    throw new IngredientAbvRequiredError();
  }
  return ingredients;
}

async function callAdjustmentProvider(
  dependencies: GenerateAdjustmentDependencies,
  input: {
    preferences: NonNullable<
      ReturnType<AdjustmentReadRepository["findSessionById"]>
    >["preferences"];
    currentRecipe: RecipeRecord;
    feedback: Feedback;
    confirmedMaterialNames: readonly string[];
    constraints: z.infer<typeof AdjustmentConstraintsSchema>;
    experimentMemories: readonly {
      recipeId: string;
      feedbackId: string;
      summary: string;
      tags: readonly string[];
    }[];
    renewLease: () => Promise<void>;
  },
): Promise<{
  candidate: Awaited<ReturnType<RecipeProvider["adjust"]>>;
  sourceMode: RecipeSourceMode;
  degraded: boolean;
}> {
  const preferences = input.preferences ?? {
    sweetness: 3,
    acidity: 3,
    alcoholIntensity: 3,
    body: 3,
  };
  const currentCandidate = RecipeCandidateSchema.parse({
    id: input.currentRecipe.id,
    strategy: input.currentRecipe.strategy,
    title: input.currentRecipe.title,
    fitReason: input.currentRecipe.fitReason,
    differenceReason: input.currentRecipe.differenceReason,
    materials: input.currentRecipe.materials,
    steps: input.currentRecipe.steps,
    estimatedAbv: input.currentRecipe.estimatedAbv,
    safetyLevel: input.currentRecipe.safetyLevel,
    experimental: input.currentRecipe.experimental,
    missingIngredients: input.currentRecipe.missingIngredients,
  });
  const providerInput = {
    preferences,
    currentRecipe: currentCandidate,
    confirmedMaterialNames: [...input.confirmedMaterialNames],
    feedback: input.feedback,
    experimentMemories: input.experimentMemories.map((memory) => ({
      ...memory,
      tags: [...memory.tags],
    })),
    constraints: input.constraints,
  };

  try {
    await input.renewLease();
    if (isOutcomeAwareRecipeProvider(dependencies.primaryProvider)) {
      const outcome = await dependencies.primaryProvider.adjustWithOutcome(providerInput, {
        beforeExternalCall: input.renewLease,
      });
      return {
        candidate: outcome.value,
        sourceMode: outcome.sourceMode,
        degraded: outcome.degraded,
      };
    }
    return {
      candidate: await dependencies.primaryProvider.adjust(providerInput),
      sourceMode: dependencies.primarySourceMode ?? "qwen",
      degraded: false,
    };
  } catch (error) {
    if (error instanceof IdempotencyLeaseLostError) {
      throw error;
    }
    throw new AdjustmentProviderUnavailableError();
  }
}

function cleanupPendingReservation(
  dependencies: GenerateAdjustmentDependencies,
  requestId: string,
  leaseOwner: string,
  clock: Clock,
): void {
  try {
    dependencies.transaction((repository) => {
      repository.deleteIdempotencyRecord({
        requestId,
        leaseOwner,
        now: clock.now(),
      });
    });
  } catch (error) {
    if (!(error instanceof IdempotencyLeaseLostError)) {
      throw error;
    }
  }
}

function replayIfCompleted(
  record: { response: Record<string, unknown>; statusCode: number; requestFingerprint: string },
  requestFingerprint: string,
): GenerateAdjustmentResult | null {
  if (record.requestFingerprint !== requestFingerprint) {
    throw new IdempotencyKeyReusedError();
  }
  if (record.statusCode === PENDING_IDEMPOTENCY_STATUS_CODE) {
    throw new IdempotencyInProgressError();
  }
  return parseStoredResponse(record.response);
}

export async function generateAdjustment(
  dependencies: GenerateAdjustmentDependencies,
  input: unknown,
): Promise<GenerateAdjustmentResult> {
  const parsed = GenerateAdjustmentInputSchema.parse(input);
  const clock = dependencies.clock ?? systemClock;
  const leaseOwner = dependencies.leaseOwnerFactory?.() ?? randomUUID();
  const leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  const requestFingerprint = fingerprintRequest({
    operation: "generate-adjustment",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    feedbackId: parsed.feedbackId,
  });

  const existing = dependencies.read().findIdempotencyRecordByRequestId(parsed.requestId);
  if (existing !== null) {
    const replay = replayIfCompleted(existing, requestFingerprint);
    if (replay !== null) {
      return replay;
    }
    if (hasActiveLease(existing, clock.now())) {
      throw new IdempotencyInProgressError();
    }
  }

  const preflight = assertAdjustmentInput(dependencies.read(), parsed);
  const ingredients = assertConfirmedIngredients(
    dependencies.read().listIngredientsBySession(parsed.sessionId),
  );
  const experimentMemories = dependencies
    .read()
    .listExperimentMemories(preflight.currentRecipe.id)
    .map((memory) => ({
      recipeId: memory.recipeId,
      feedbackId: memory.feedbackId,
      summary: memory.summary,
      tags: [...memory.tags],
    }));
  const constraints = buildAdjustmentConstraints(preflight.normalizedFeedback);
  const confirmedMaterialNames = ingredients.map((ingredient) => ingredient.canonicalName);
  const evaluateSafety = dependencies.evaluateSafety ?? defaultEvaluateSafety;

  let acquisition;
  try {
    acquisition = dependencies.transaction((repository) =>
      repository.acquireIdempotencyLease({
        id: randomUUID(),
        sessionId: parsed.sessionId,
        requestId: parsed.requestId,
        requestFingerprint,
        expectedVersion: parsed.expectedVersion,
        response: { pending: true },
        statusCode: PENDING_IDEMPOTENCY_STATUS_CODE,
        leaseOwner,
        leaseExpiresAt: new Date(clock.now().getTime() + leaseDurationMs),
        now: clock.now(),
      }),
    );
  } catch (error) {
    if (error instanceof SessionVersionConflictError) {
      throw new VersionConflictError();
    }
    throw error;
  }

  if (acquisition.status === "conflict") {
    assertIdempotencyFingerprint(acquisition.record, requestFingerprint);
  }
  if (acquisition.status === "completed") {
    return parseStoredResponse(acquisition.record.response);
  }
  if (acquisition.status === "busy") {
    if (acquisition.record.requestId === parsed.requestId) {
      throw new IdempotencyInProgressError();
    }
    throw new SessionMutationInProgressError();
  }

  try {
    const providerResult = await callAdjustmentProvider(dependencies, {
      preferences: preflight.session.preferences,
      currentRecipe: preflight.currentRecipe,
      feedback: preflight.normalizedFeedback,
      confirmedMaterialNames,
      constraints,
      experimentMemories,
      renewLease: async () => {
        dependencies.transaction((repository) =>
          repository.renewIdempotencyLease({
            requestId: parsed.requestId,
            expectedVersion: parsed.expectedVersion,
            leaseOwner,
            leaseExpiresAt: new Date(clock.now().getTime() + leaseDurationMs),
            now: clock.now(),
          }),
        );
      },
    });

    let adjustedCandidate: z.infer<typeof RecipeCandidateSchema>;
    try {
      adjustedCandidate = RecipeCandidateSchema.parse(providerResult.candidate);
      adjustedCandidate = validateAdjustedCandidate(
        adjustedCandidate,
        RecipeCandidateSchema.parse({
          id: preflight.currentRecipe.id,
          strategy: preflight.currentRecipe.strategy,
          title: preflight.currentRecipe.title,
          fitReason: preflight.currentRecipe.fitReason,
          differenceReason: preflight.currentRecipe.differenceReason,
          materials: preflight.currentRecipe.materials,
          steps: preflight.currentRecipe.steps,
          estimatedAbv: preflight.currentRecipe.estimatedAbv,
          safetyLevel: preflight.currentRecipe.safetyLevel,
          experimental: preflight.currentRecipe.experimental,
          missingIngredients: preflight.currentRecipe.missingIngredients,
        }),
        confirmedMaterialNames,
      );
    } catch {
      throw new AdjustmentProviderUnavailableError();
    }
    if (adjustedCandidate.id === preflight.currentRecipe.id) {
      throw new AdjustmentProviderUnavailableError();
    }

    let evaluated: ReturnType<typeof evaluateRecipeCandidateSafety>;
    let sourceMode = providerResult.sourceMode;
    let degraded = providerResult.degraded;
    try {
      evaluated = evaluateRecipeCandidateSafety(adjustedCandidate, ingredients, evaluateSafety);
    } catch {
      throw new AdjustmentSafetyEvaluationError();
    }
    adjustedCandidate = evaluated.candidate;

    if (evaluated.safetyDecision.level === "BLOCK") {
      try {
        const repaired = await repairBlockedRecipe({
          preferences: preflight.session.preferences ?? {
            sweetness: 3,
            acidity: 3,
            alcoholIntensity: 3,
            body: 3,
          },
          candidate: adjustedCandidate,
          confirmedIngredients: ingredients,
          confirmedMaterialNames,
          primaryProvider: dependencies.primaryProvider,
          fallbackProvider: dependencies.fallbackProvider,
          evaluateSafety,
          initialEvaluation: evaluated,
          experimentMemories,
          constraints,
          beforeExternalCall: async () => {
            dependencies.transaction((repository) =>
              repository.renewIdempotencyLease({
                requestId: parsed.requestId,
                expectedVersion: parsed.expectedVersion,
                leaseOwner,
                leaseExpiresAt: new Date(clock.now().getTime() + leaseDurationMs),
                now: clock.now(),
              }),
            );
          },
        });
        adjustedCandidate = repaired.candidate;
        evaluated = repaired;
        sourceMode = repaired.sourceMode;
        degraded = repaired.degraded;
      } catch (error) {
        if (error instanceof IdempotencyLeaseLostError) {
          throw error;
        }
        if (error instanceof BlockedRecipeFallbackExhaustedError) {
          throw new AdjustmentSafetyBlockedError();
        }
        throw new AdjustmentProviderUnavailableError();
      }
    }

    if (evaluated.safetyDecision.level === "BLOCK") {
      throw new AdjustmentSafetyBlockedError();
    }

    return dependencies.transaction((repository) => {
      repository.assertIdempotencyLease({
        requestId: parsed.requestId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner,
        now: clock.now(),
      });
      const currentSession = repository.findSessionById(parsed.sessionId);
      if (currentSession === null) {
        throw new SessionNotFoundError();
      }
      if (
        currentSession.version !== parsed.expectedVersion ||
        currentSession.state !== "ADJUSTMENT" ||
        currentSession.selectedRecipeId !== preflight.currentRecipe.id
      ) {
        throw new VersionConflictError();
      }
      const currentFeedback = repository.findFeedbackById(parsed.feedbackId);
      if (
        currentFeedback === null ||
        currentFeedback.sessionId !== parsed.sessionId ||
        currentFeedback.recipeId !== currentSession.selectedRecipeId ||
        currentFeedback.accepted
      ) {
        throw new AdjustmentFeedbackInvalidError();
      }

      const existingProposal = repository
        .listRecipesBySession(parsed.sessionId)
        .filter(
          (recipe) =>
            recipe.parentRecipeId === currentSession.selectedRecipeId &&
            recipe.feedbackId === parsed.feedbackId,
        );
      if (existingProposal.length > 0) {
        throw new AdjustmentFeedbackInvalidError();
      }

      const recipeSetId = randomUUID();
      const proposedRecipe = repository.createSingleRecipeSet({
        recipeSet: {
          id: recipeSetId,
          sessionId: parsed.sessionId,
          sourceMode,
        },
        recipe: {
          recipeSetId,
          sessionId: parsed.sessionId,
          candidate: adjustedCandidate,
          version: preflight.currentRecipe.version + 1,
          parentRecipeId: preflight.currentRecipe.id,
          feedbackId: parsed.feedbackId,
        },
      });
      repository.createSafetyDecision({
        recipeId: proposedRecipe.id,
        level: evaluated.safetyDecision.level,
        ruleHits: evaluated.safetyDecision.hits,
        engineVersion: "1.0.0",
      });
      repository.createExperimentMemory({
        id: randomUUID(),
        recipeId: proposedRecipe.id,
        feedbackId: parsed.feedbackId,
        summary: `已根据反馈生成 V${proposedRecipe.version} 待确认调整。`,
        tags: ["adjustment-proposed", `version:${proposedRecipe.version}`],
      });
      repository.createDecisionEvent({
        sessionId: parsed.sessionId,
        type: "adjustment_proposed",
        summary: "已生成待确认的调整配方，等待用户明确接受。",
        metadata: {
          currentRecipeId: preflight.currentRecipe.id,
          proposedRecipeId: proposedRecipe.id,
          feedbackId: parsed.feedbackId,
          version: proposedRecipe.version,
          safetyLevel: evaluated.safetyDecision.level,
          sourceMode,
          degraded,
        },
      });
      const updatedSession = repository.updateVersion({
        id: parsed.sessionId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner,
        state: "ADJUSTMENT",
      });
      const proposedReadModel = toVersionedRecipeReadModel(
        proposedRecipe,
        repository.listSafetyDecisionsBySet(recipeSetId),
        updatedSession.selectedRecipeId,
      );
      const result: GenerateAdjustmentResult = {
        sessionId: parsed.sessionId,
        state: "ADJUSTMENT",
        sessionVersion: updatedSession.version,
        currentRecipeId: preflight.currentRecipe.id,
        proposedRecipe: proposedReadModel,
        constraints,
        safety: proposedReadModel.safety,
      };
      repository.completeIdempotencyRecord({
        requestId: parsed.requestId,
        leaseOwner,
        now: clock.now(),
        response: toResponse(result),
        statusCode: 200,
      });
      return result;
    });
  } catch (error) {
    cleanupPendingReservation(dependencies, parsed.requestId, leaseOwner, clock);
    if (error instanceof SessionVersionConflictError) {
      throw new VersionConflictError();
    }
    throw error;
  }
}
