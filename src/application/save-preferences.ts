import { z } from "zod";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import { acquireSessionMutationLease } from "@/src/application/session-mutation-lease";
import type { SessionUnitOfWork } from "@/src/application/unit-of-work";
import type { SessionRecord } from "@/src/repositories/session-repository";
import { MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";
import { TasteProfileSchema } from "@/src/domain/preferences";
import { SessionIdSchema } from "@/src/domain/id";
import { SessionEvent, transition } from "@/src/workflow/session-machine";
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";

const SavePreferencesInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  preferences: TasteProfileSchema,
}).strict();

const SavePreferencesResponseSchema = SuccessEnvelopeSchema(
  z.object({
    preferences: TasteProfileSchema,
  }),
);

export type SavePreferencesInput = z.input<typeof SavePreferencesInputSchema>;
export type SavePreferencesResponse = z.infer<typeof SavePreferencesResponseSchema>;

export class VersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";

  constructor() {
    super("VERSION_CONFLICT");
    this.name = "VersionConflictError";
  }
}

export interface SavePreferencesResult {
  requestId: string;
  response: SavePreferencesResponse;
  replayed: boolean;
  transitionEvent: typeof SessionEvent.SAVE_PREFERENCES;
}

function parseStoredResponse(response: Record<string, unknown>): SavePreferencesResponse {
  return SavePreferencesResponseSchema.parse(response);
}

function isRequestIdUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("idempotency_records.request_id");
}

export function savePreferences(
  unitOfWork: SessionUnitOfWork,
  input: unknown,
): SavePreferencesResult {
  const parsed = SavePreferencesInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "save-preferences",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    preferences: parsed.preferences,
  });
  const existing = unitOfWork.read().findIdempotencyRecordByRequestId(parsed.requestId);

  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprint);

    return {
      requestId: parsed.requestId,
      response: parseStoredResponse(existing.response),
      replayed: true,
      transitionEvent: SessionEvent.SAVE_PREFERENCES,
    };
  }

  try {
    return unitOfWork.transaction((repository) => {
      const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);

      if (transactionExisting !== null) {
        assertIdempotencyFingerprint(transactionExisting, requestFingerprint);

        return {
          requestId: parsed.requestId,
          response: parseStoredResponse(transactionExisting.response),
          replayed: true,
          transitionEvent: SessionEvent.SAVE_PREFERENCES,
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

      const nextState = transition(session.state, SessionEvent.SAVE_PREFERENCES, {
        hasPreferences: true,
        hasOverviewImage: false,
        allIngredientsConfirmed: false,
        alcoholAbvConfirmed: false,
        hasRecipeSet: false,
        hasSelectedRecipe: false,
        hasSelectedAdjustedRecipe: false,
        currentStep: session.currentStep,
        totalSteps: null,
        hasFeedback: false,
      });

      let updated: SessionRecord;

      try {
        updated = repository.updateVersion({
          id: parsed.sessionId,
          expectedVersion: parsed.expectedVersion,
          leaseOwner: parsed.requestId,
          state: nextState,
          preferences: parsed.preferences,
        });
      } catch (error) {
        if (error instanceof SessionVersionConflictError) {
          throw new VersionConflictError();
        }
        throw error;
      }

      const response: SavePreferencesResponse = {
        data: { preferences: parsed.preferences },
        session: {
          id: SessionIdSchema.parse(updated.id),
          state: updated.state,
          version: updated.version,
        },
      };

      repository.saveIdempotencyRecord({
        id: crypto.randomUUID(),
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
        transitionEvent: SessionEvent.SAVE_PREFERENCES,
      };
    });
  } catch (error) {
    if (!isRequestIdUniqueViolation(error)) {
      throw error;
    }

    const record = unitOfWork.read().findIdempotencyRecordByRequestId(parsed.requestId);

    if (record === null) {
      throw error;
    }

    assertIdempotencyFingerprint(record, requestFingerprint);

    return {
      requestId: parsed.requestId,
      response: parseStoredResponse(record.response),
      replayed: true,
      transitionEvent: SessionEvent.SAVE_PREFERENCES,
    };
  }
}
