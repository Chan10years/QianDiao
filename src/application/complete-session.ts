import { randomUUID } from "node:crypto";

import { z } from "zod";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import { acquireSessionMutationLease } from "@/src/application/session-mutation-lease";
import type { AdjustmentUnitOfWork } from "@/src/application/unit-of-work";
import { MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";
import { SessionIdSchema } from "@/src/domain/id";
import { SessionEvent, transition } from "@/src/workflow/session-machine";
import { VersionConflictError } from "@/src/application/save-preferences";
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";
import { RecipeDataIntegrityError } from "@/src/repositories/recipe-repository";

const CompleteSessionInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  feedbackId: z.string().uuid(),
}).strict();

const CompleteSessionDataSchema = z
  .object({
    sessionId: SessionIdSchema,
    state: z.literal("COMPLETED"),
    sessionVersion: z.number().int().nonnegative(),
    currentRecipeId: z.string().uuid(),
  })
  .strict();

const CompleteSessionResponseSchema = SuccessEnvelopeSchema(CompleteSessionDataSchema);

export type CompleteSessionInput = z.input<typeof CompleteSessionInputSchema>;

export interface CompleteSessionResult {
  sessionId: string;
  state: "COMPLETED";
  sessionVersion: number;
  currentRecipeId: string;
}

export type CompleteSessionDependencies = AdjustmentUnitOfWork;

export class CompletionFeedbackInvalidError extends Error {
  readonly code = "COMPLETION_FEEDBACK_INVALID";

  constructor() {
    super("COMPLETION_FEEDBACK_INVALID");
    this.name = "CompletionFeedbackInvalidError";
  }
}

export class CompletionSafetyInvalidError extends Error {
  readonly code = "COMPLETION_SAFETY_INVALID";

  constructor() {
    super("COMPLETION_SAFETY_INVALID");
    this.name = "CompletionSafetyInvalidError";
  }
}

function parseStoredResponse(response: Record<string, unknown>): CompleteSessionResult {
  return CompleteSessionResponseSchema.parse(response).data;
}

function toResponse(result: CompleteSessionResult) {
  return CompleteSessionResponseSchema.parse({
    data: result,
    session: {
      id: result.sessionId,
      state: result.state,
      version: result.sessionVersion,
    },
  });
}

export function completeSession(
  dependencies: CompleteSessionDependencies,
  input: unknown,
): CompleteSessionResult {
  const parsed = CompleteSessionInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "complete-session",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    feedbackId: parsed.feedbackId,
  });
  const existing = dependencies.read().findIdempotencyRecordByRequestId(parsed.requestId);
  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprint);
    return parseStoredResponse(existing.response);
  }

  return dependencies.transaction((repository) => {
    const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);
    if (transactionExisting !== null) {
      assertIdempotencyFingerprint(transactionExisting, requestFingerprint);
      return parseStoredResponse(transactionExisting.response);
    }

    try {
      acquireSessionMutationLease(repository, {
        sessionId: parsed.sessionId,
        requestId: parsed.requestId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner: parsed.requestId,
      });
    } catch (error) {
      if (error instanceof SessionVersionConflictError) {
        throw new VersionConflictError();
      }
      throw error;
    }

    const session = repository.findSessionById(parsed.sessionId);
    if (session === null) {
      throw new SessionNotFoundError();
    }
    if (
      (session.state !== "FEEDBACK" && session.state !== "ADJUSTMENT") ||
      session.version !== parsed.expectedVersion
    ) {
      throw new CompletionFeedbackInvalidError();
    }
    if (session.selectedRecipeId === null) {
      throw new CompletionFeedbackInvalidError();
    }

    const currentRecipe = repository.findRecipeById(session.selectedRecipeId);
    const feedback = repository.findFeedbackById(parsed.feedbackId);
    if (
      currentRecipe === null ||
      currentRecipe.sessionId !== parsed.sessionId ||
      feedback === null ||
      feedback.sessionId !== parsed.sessionId ||
      feedback.recipeId !== currentRecipe.id ||
      !feedback.accepted
    ) {
      throw new CompletionFeedbackInvalidError();
    }
    const feedbackHistory = repository.listFeedbackByRecipe(currentRecipe.id);
    if (feedbackHistory.at(-1)?.id !== feedback.id) {
      throw new CompletionFeedbackInvalidError();
    }

    const chain = repository.listRecipeVersionChain(currentRecipe.id);
    if (chain.at(-1)?.id !== currentRecipe.id) {
      throw new RecipeDataIntegrityError();
    }
    const safetyDecisions = repository
      .listSafetyDecisionsBySet(currentRecipe.recipeSetId)
      .filter((decision) => decision.recipeId === currentRecipe.id);
    if (
      safetyDecisions.length !== 1 ||
      safetyDecisions[0]?.level !== currentRecipe.safetyLevel ||
      safetyDecisions[0]?.level === "BLOCK"
    ) {
      throw new CompletionSafetyInvalidError();
    }

    const nextState = transition(session.state, SessionEvent.COMPLETE_SESSION, {
      hasPreferences: session.preferences !== null,
      hasOverviewImage: true,
      allIngredientsConfirmed: true,
      alcoholAbvConfirmed: true,
      hasRecipeSet: true,
      hasSelectedRecipe: true,
      hasSelectedAdjustedRecipe: currentRecipe.version > 1,
      currentStep: session.currentStep,
      totalSteps: currentRecipe.steps.length,
      hasFeedback: true,
    });

    let updated;
    try {
      updated = repository.updateVersion({
        id: parsed.sessionId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner: parsed.requestId,
        state: nextState,
        currentStep: null,
      });
    } catch (error) {
      if (error instanceof SessionVersionConflictError) {
        throw new VersionConflictError();
      }
      throw error;
    }

    repository.createDecisionEvent({
      sessionId: parsed.sessionId,
      type: "session_completed",
      summary: "用户已确认满意，调饮会话完成。",
      metadata: {
        recipeId: currentRecipe.id,
        feedbackId: parsed.feedbackId,
        version: currentRecipe.version,
      },
    });

    const result: CompleteSessionResult = {
      sessionId: updated.id,
      state: "COMPLETED",
      sessionVersion: updated.version,
      currentRecipeId: currentRecipe.id,
    };
    repository.saveIdempotencyRecord({
      id: randomUUID(),
      sessionId: updated.id,
      requestId: parsed.requestId,
      requestFingerprint,
      response: toResponse(result),
      statusCode: 200,
    });
    repository.releaseSessionMutationLease({
      sessionId: parsed.sessionId,
      leaseOwner: parsed.requestId,
      now: new Date(),
    });
    return result;
  });
}
