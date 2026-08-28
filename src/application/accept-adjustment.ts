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

const AcceptAdjustmentInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  proposedRecipeId: z.string().uuid(),
}).strict();

const AcceptAdjustmentDataSchema = z
  .object({
    sessionId: SessionIdSchema,
    state: z.literal("MIXING"),
    sessionVersion: z.number().int().nonnegative(),
    currentRecipeId: z.string().uuid(),
  })
  .strict();

const AcceptAdjustmentResponseSchema = SuccessEnvelopeSchema(AcceptAdjustmentDataSchema);

export type AcceptAdjustmentInput = z.input<typeof AcceptAdjustmentInputSchema>;

export interface AcceptAdjustmentResult {
  sessionId: string;
  state: "MIXING";
  sessionVersion: number;
  currentRecipeId: string;
}

export type AcceptAdjustmentDependencies = AdjustmentUnitOfWork;

export class AdjustmentProposalInvalidError extends Error {
  readonly code = "ADJUSTMENT_PROPOSAL_INVALID";

  constructor() {
    super("ADJUSTMENT_PROPOSAL_INVALID");
    this.name = "AdjustmentProposalInvalidError";
  }
}

export class AcceptAdjustmentInvalidStateError extends Error {
  readonly code = "INVALID_STATE";

  constructor() {
    super("INVALID_STATE");
    this.name = "AcceptAdjustmentInvalidStateError";
  }
}

function parseStoredResponse(response: Record<string, unknown>): AcceptAdjustmentResult {
  return AcceptAdjustmentResponseSchema.parse(response).data;
}

function toResponse(result: AcceptAdjustmentResult) {
  return AcceptAdjustmentResponseSchema.parse({
    data: result,
    session: {
      id: result.sessionId,
      state: result.state,
      version: result.sessionVersion,
    },
  });
}

export function acceptAdjustment(
  dependencies: AcceptAdjustmentDependencies,
  input: unknown,
): AcceptAdjustmentResult {
  const parsed = AcceptAdjustmentInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "accept-adjustment",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    proposedRecipeId: parsed.proposedRecipeId,
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
    if (session.version !== parsed.expectedVersion) {
      throw new VersionConflictError();
    }
    if (session.state !== "ADJUSTMENT") {
      throw new AcceptAdjustmentInvalidStateError();
    }
    if (session.selectedRecipeId === null) {
      throw new AdjustmentProposalInvalidError();
    }

    const currentRecipe = repository.findRecipeById(session.selectedRecipeId);
    const proposedRecipe = repository.findRecipeById(parsed.proposedRecipeId);
    if (
      currentRecipe === null ||
      proposedRecipe === null ||
      currentRecipe.sessionId !== parsed.sessionId ||
      proposedRecipe.sessionId !== parsed.sessionId ||
      currentRecipe.id === proposedRecipe.id
    ) {
      throw new AdjustmentProposalInvalidError();
    }

    const proposalSet = repository.findRecipeSetById(proposedRecipe.recipeSetId);
    const recipesInProposalSet = repository.listRecipesBySet(proposedRecipe.recipeSetId);
    if (
      proposalSet === null ||
      proposalSet.sessionId !== parsed.sessionId ||
      recipesInProposalSet.length !== 1 ||
      recipesInProposalSet[0]?.id !== proposedRecipe.id
    ) {
      throw new AdjustmentProposalInvalidError();
    }

    if (
      proposedRecipe.parentRecipeId !== currentRecipe.id ||
      proposedRecipe.version !== currentRecipe.version + 1 ||
      proposedRecipe.feedbackId === null
    ) {
      throw new AdjustmentProposalInvalidError();
    }

    const feedback = repository.findFeedbackById(proposedRecipe.feedbackId);
    if (
      feedback === null ||
      feedback.sessionId !== parsed.sessionId ||
      feedback.recipeId !== currentRecipe.id ||
      feedback.accepted
    ) {
      throw new AdjustmentProposalInvalidError();
    }
    const feedbackHistory = repository.listFeedbackByRecipe(currentRecipe.id);
    if (feedbackHistory.at(-1)?.id !== feedback.id) {
      throw new AdjustmentProposalInvalidError();
    }
    const directProposals = repository
      .listRecipesBySession(parsed.sessionId)
      .filter(
        (recipe) =>
          recipe.parentRecipeId === currentRecipe.id &&
          recipe.version === currentRecipe.version + 1 &&
          recipe.feedbackId === feedback.id,
      );
    if (directProposals.length !== 1 || directProposals[0]?.id !== proposedRecipe.id) {
      throw new AdjustmentProposalInvalidError();
    }

    const chain = repository.listRecipeVersionChain(proposedRecipe.id);
    const chainTail = chain.at(-1);
    if (
      chainTail?.id !== proposedRecipe.id ||
      chainTail.version !== proposedRecipe.version ||
      chain.some(
        (recipe, index) => recipe.sessionId !== parsed.sessionId || recipe.version !== index + 1,
      )
    ) {
      throw new RecipeDataIntegrityError();
    }

    const safetyDecisions = repository.listSafetyDecisionsBySet(proposedRecipe.recipeSetId);
    const matchingSafetyDecisions = safetyDecisions.filter(
      (decision) => decision.recipeId === proposedRecipe.id,
    );
    if (
      matchingSafetyDecisions.length !== 1 ||
      matchingSafetyDecisions[0]?.level !== proposedRecipe.safetyLevel ||
      matchingSafetyDecisions[0]?.level === "BLOCK"
    ) {
      throw new AdjustmentProposalInvalidError();
    }

    const nextState = transition(session.state, SessionEvent.ACCEPT_ADJUSTMENT, {
      hasPreferences: session.preferences !== null,
      hasOverviewImage: true,
      allIngredientsConfirmed: true,
      alcoholAbvConfirmed: true,
      hasRecipeSet: true,
      hasSelectedRecipe: true,
      hasSelectedAdjustedRecipe: true,
      currentStep: session.currentStep,
      totalSteps: proposedRecipe.steps.length,
      hasFeedback: true,
    });

    let updated;
    try {
      updated = repository.updateVersion({
        id: parsed.sessionId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner: parsed.requestId,
        state: nextState,
        selectedRecipeId: proposedRecipe.id,
        currentStep: 0,
      });
    } catch (error) {
      if (error instanceof SessionVersionConflictError) {
        throw new VersionConflictError();
      }
      throw error;
    }

    repository.createDecisionEvent({
      sessionId: parsed.sessionId,
      type: "adjustment_accepted",
      summary: "用户已接受调整配方，继续进入调制。",
      metadata: {
        previousRecipeId: currentRecipe.id,
        proposedRecipeId: proposedRecipe.id,
        feedbackId: proposedRecipe.feedbackId,
        version: proposedRecipe.version,
      },
    });

    const result: AcceptAdjustmentResult = {
      sessionId: updated.id,
      state: "MIXING",
      sessionVersion: updated.version,
      currentRecipeId: proposedRecipe.id,
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
