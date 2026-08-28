import { z } from "zod";
import { randomUUID } from "node:crypto";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import { acquireSessionMutationLease } from "@/src/application/session-mutation-lease";
import { VersionConflictError } from "@/src/application/save-preferences";
import { MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";
import { SessionIdSchema } from "@/src/domain/id";
import { MixingActionSchema, type MixingAction } from "@/src/domain/session";
import type { RecipeRepository } from "@/src/repositories/recipe-repository";
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";
import type {
  SessionMutationLeaseRepository,
  SessionRepository,
} from "@/src/repositories/session-repository";
import { SessionEvent, transition } from "@/src/workflow/session-machine";

const AdvanceMixingInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  action: MixingActionSchema,
}).strict();

const AdvanceMixingResponseSchema = SuccessEnvelopeSchema(
  z
    .object({
      action: MixingActionSchema,
      currentStep: z.number().int().nonnegative().nullable(),
      totalSteps: z.number().int().positive(),
    })
    .strict(),
);

export type AdvanceMixingInput = z.input<typeof AdvanceMixingInputSchema>;
export type AdvanceMixingResponse = z.infer<typeof AdvanceMixingResponseSchema>;

export interface AdvanceMixingResult {
  requestId: string;
  response: AdvanceMixingResponse;
  replayed: boolean;
}

export type AdvanceMixingReadRepository = Pick<
  SessionRepository,
  "findById" | "findIdempotencyRecordByRequestId"
> & { findRecipeById(id: string): ReturnType<RecipeRepository["findById"]> };
export type AdvanceMixingTransactionRepository = AdvanceMixingReadRepository &
  SessionMutationLeaseRepository &
  Pick<SessionRepository, "updateVersion" | "saveIdempotencyRecord">;

export interface AdvanceMixingDependencies {
  read(): AdvanceMixingReadRepository;
  transaction<T>(operation: (repository: AdvanceMixingTransactionRepository) => T): T;
}

export function advanceMixing(
  dependencies: AdvanceMixingDependencies,
  input: unknown,
): AdvanceMixingResult {
  const parsed = AdvanceMixingInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "advance-mixing",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    action: parsed.action,
  });
  const existing = dependencies.read().findIdempotencyRecordByRequestId(parsed.requestId);

  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprint);
    return {
      requestId: parsed.requestId,
      response: AdvanceMixingResponseSchema.parse(existing.response),
      replayed: true,
    };
  }

  return dependencies.transaction((repository) => {
    const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);
    if (transactionExisting !== null) {
      assertIdempotencyFingerprint(transactionExisting, requestFingerprint);
      return {
        requestId: parsed.requestId,
        response: AdvanceMixingResponseSchema.parse(transactionExisting.response),
        replayed: true,
      };
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

    const session = repository.findById(parsed.sessionId);
    if (session === null) {
      throw new SessionNotFoundError();
    }

    const selectedRecipe =
      session.selectedRecipeId === null
        ? null
        : repository.findRecipeById(session.selectedRecipeId);
    const totalSteps = selectedRecipe?.steps.length ?? null;
    const event =
      parsed.action === "ADVANCE_MIXING" ? SessionEvent.ADVANCE_MIXING : SessionEvent.BACK_MIXING;
    const nextState = transition(session.state, event, {
      hasPreferences: session.preferences !== null,
      hasOverviewImage: true,
      allIngredientsConfirmed: true,
      alcoholAbvConfirmed: true,
      hasRecipeSet: selectedRecipe !== null,
      hasSelectedRecipe: selectedRecipe !== null,
      hasSelectedAdjustedRecipe: false,
      currentStep: session.currentStep,
      totalSteps,
      hasFeedback: false,
    });
    const nextCurrentStep =
      nextState === "FEEDBACK"
        ? null
        : parsed.action === "ADVANCE_MIXING"
          ? (session.currentStep ?? 0) + 1
          : (session.currentStep ?? 0) - 1;

    let updated;
    try {
      updated = repository.updateVersion({
        id: parsed.sessionId,
        expectedVersion: parsed.expectedVersion,
        leaseOwner: parsed.requestId,
        state: nextState,
        currentStep: nextCurrentStep,
      });
    } catch (error) {
      if (error instanceof SessionVersionConflictError) {
        throw new VersionConflictError();
      }
      throw error;
    }

    const response = AdvanceMixingResponseSchema.parse({
      data: {
        action: parsed.action,
        currentStep: nextCurrentStep,
        totalSteps,
      },
      session: {
        id: updated.id,
        state: updated.state,
        version: updated.version,
      },
    });

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

    return {
      requestId: parsed.requestId,
      response,
      replayed: false,
    };
  });
}

export { MixingActionSchema, type MixingAction };
