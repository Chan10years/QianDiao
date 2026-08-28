import { randomUUID } from "node:crypto";

import { z } from "zod";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import { VersionConflictError } from "@/src/application/save-preferences";
import type {
  FeedbackUnitOfWork,
  FeedbackTransactionRepository,
} from "@/src/application/unit-of-work";
import { MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";
import { FeedbackSchema, type Feedback } from "@/src/domain/feedback";
import { RecipeIdSchema, SessionIdSchema } from "@/src/domain/id";
import { SessionEvent, transition } from "@/src/workflow/session-machine";
import {
  SessionMutationInProgressError,
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";

const SaveFeedbackInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  recipeId: RecipeIdSchema,
  feedback: FeedbackSchema,
}).strict();

const SaveFeedbackDataSchema = z
  .object({
    sessionId: SessionIdSchema,
    state: z.enum(["ADJUSTMENT", "COMPLETED"]),
    sessionVersion: z.number().int().nonnegative(),
    feedbackId: z.string().uuid(),
    finalImageId: z.string().uuid().nullable(),
  })
  .strict();

const SaveFeedbackResponseSchema = SuccessEnvelopeSchema(SaveFeedbackDataSchema);

export type SaveFeedbackInput = z.input<typeof SaveFeedbackInputSchema>;

export interface SaveFeedbackResult {
  sessionId: string;
  state: "ADJUSTMENT" | "COMPLETED";
  sessionVersion: number;
  feedbackId: string;
  finalImageId: string | null;
}

export type SaveFeedbackReadRepository = ReturnType<FeedbackUnitOfWork["read"]>;
export type SaveFeedbackTransactionRepository = FeedbackTransactionRepository;

export interface SaveFeedbackDependencies {
  read(): SaveFeedbackReadRepository;
  transaction<T>(operation: (repository: SaveFeedbackTransactionRepository) => T): T;
}

export class FeedbackRecipeNotFoundError extends Error {
  readonly code = "FEEDBACK_RECIPE_NOT_FOUND";

  constructor() {
    super("FEEDBACK_RECIPE_NOT_FOUND");
    this.name = "FeedbackRecipeNotFoundError";
  }
}

export class FeedbackImageInvalidError extends Error {
  readonly code = "FEEDBACK_IMAGE_INVALID";

  constructor() {
    super("FEEDBACK_IMAGE_INVALID");
    this.name = "FeedbackImageInvalidError";
  }
}

function parseStoredResult(response: Record<string, unknown>): SaveFeedbackResult {
  const parsed = SaveFeedbackResponseSchema.parse(response);
  return parsed.data;
}

function memorySummary(feedback: Feedback): string {
  return feedback.notes?.trim() || `用户评分 ${feedback.rating}/5。`;
}

function memoryTags(feedback: Feedback): string[] {
  const deltas = Object.entries(feedback.deltas)
    .filter(([, delta]) => delta !== 0)
    .map(([dimension, delta]) => `${dimension}:${delta > 0 ? "increase" : "decrease"}`);
  return [feedback.accepted ? "accepted" : "adjustment", `rating:${feedback.rating}`, ...deltas];
}

function assertCurrentRecipe(
  repository: Pick<SaveFeedbackReadRepository, "findRecipeById">,
  session: { id: string; selectedRecipeId: string | null },
  recipeId: string,
) {
  if (session.selectedRecipeId !== recipeId) {
    throw new FeedbackRecipeNotFoundError();
  }

  const recipe = repository.findRecipeById(recipeId);
  if (recipe === null || recipe.sessionId !== session.id) {
    throw new FeedbackRecipeNotFoundError();
  }
  return recipe;
}

function assertFinalImage(
  repository: Pick<SaveFeedbackReadRepository, "findImageById">,
  sessionId: string,
  imageId: string | null,
): void {
  if (imageId === null) {
    return;
  }

  const image = repository.findImageById(imageId);
  if (image === null || image.sessionId !== sessionId || image.role !== "final_drink") {
    throw new FeedbackImageInvalidError();
  }
}

function toResponse(result: SaveFeedbackResult) {
  return SaveFeedbackResponseSchema.parse({
    data: result,
    session: {
      id: result.sessionId,
      state: result.state,
      version: result.sessionVersion,
    },
  });
}

export async function saveFeedback(
  dependencies: SaveFeedbackDependencies,
  input: unknown,
): Promise<SaveFeedbackResult> {
  const parsed = SaveFeedbackInputSchema.parse(input);
  const feedback = {
    ...parsed.feedback,
    finalImageId: parsed.feedback.finalImageId ?? null,
  } satisfies Feedback;
  const requestFingerprint = fingerprintRequest({
    operation: "save-feedback",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    recipeId: parsed.recipeId,
    feedback,
  });

  const existing = dependencies.read().findIdempotencyRecordByRequestId(parsed.requestId);
  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprint);
    return parseStoredResult(existing.response);
  }

  return dependencies.transaction((repository) => {
    const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);
    if (transactionExisting !== null) {
      assertIdempotencyFingerprint(transactionExisting, requestFingerprint);
      return parseStoredResult(transactionExisting.response);
    }

    try {
      const acquisition = repository.acquireSessionMutationLease({
        sessionId: parsed.sessionId,
        requestId: parsed.requestId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner: parsed.requestId,
        leaseExpiresAt: new Date(Date.now() + 15_000),
        now: new Date(),
      });
      if (acquisition.status === "version-conflict") {
        throw new VersionConflictError();
      }
      if (acquisition.status === "busy") {
        throw new SessionMutationInProgressError();
      }
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
    if (session.version !== parsed.expectedVersion) {
      throw new VersionConflictError();
    }

    const recipe = assertCurrentRecipe(repository, session, parsed.recipeId);
    assertFinalImage(repository, parsed.sessionId, feedback.finalImageId);

    const event = feedback.accepted ? SessionEvent.COMPLETE_SESSION : SessionEvent.SUBMIT_FEEDBACK;
    const nextState = transition(session.state, event, {
      hasPreferences: session.preferences !== null,
      hasOverviewImage: true,
      allIngredientsConfirmed: true,
      alcoholAbvConfirmed: true,
      hasRecipeSet: true,
      hasSelectedRecipe: true,
      hasSelectedAdjustedRecipe: recipe.version > 1,
      currentStep: session.currentStep,
      totalSteps: recipe.steps.length,
      hasFeedback: true,
    });

    const feedbackId = randomUUID();
    repository.create({
      id: feedbackId,
      sessionId: parsed.sessionId,
      recipeId: parsed.recipeId,
      feedback,
    });
    repository.createExperimentMemory({
      id: randomUUID(),
      recipeId: parsed.recipeId,
      feedbackId,
      summary: memorySummary(feedback),
      tags: memoryTags(feedback),
    });
    repository.createDecisionEvent({
      sessionId: parsed.sessionId,
      type: "feedback_saved",
      summary: feedback.accepted
        ? "用户已确认当前配方满意。"
        : "已保存用户反馈，等待生成调整配方。",
      metadata: {
        recipeId: parsed.recipeId,
        feedbackId,
        accepted: feedback.accepted,
        rating: feedback.rating,
      },
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

    const result: SaveFeedbackResult = {
      sessionId: updated.id,
      state: updated.state as "ADJUSTMENT" | "COMPLETED",
      sessionVersion: updated.version,
      feedbackId,
      finalImageId: feedback.finalImageId,
    };
    const response = toResponse(result);
    repository.saveIdempotencyRecord({
      id: randomUUID(),
      sessionId: updated.id,
      requestId: parsed.requestId,
      requestFingerprint,
      response,
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
