import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  assertIdempotencyFingerprint,
  fingerprintRequest,
  IdempotencyInProgressError,
} from "@/src/application/idempotency";
import { sleep, systemClock, type Clock } from "@/src/application/clock";
import type { VisionUnitOfWork } from "@/src/application/unit-of-work";
import { SuccessEnvelopeSchema, MutationMetaSchema } from "@/src/domain/api";
import { SessionIdSchema } from "@/src/domain/id";
import {
  VisionInputSchema,
  VisionResultSchema,
  normalizeVisionResult,
} from "@/src/providers/vision-provider";
import type { VisionProvider } from "@/src/providers/vision-provider";
import { VersionConflictError } from "@/src/application/save-preferences";
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";
import {
  IdempotencyLeaseLostError,
  IdempotencyReservationCleanupError,
  type IdempotencyLeaseAcquisition,
} from "@/src/repositories/idempotency-reservation-repository";
import { SessionEvent, transition } from "@/src/workflow/session-machine";
import { SessionStateSchema } from "@/src/domain/session";

const RecognitionInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  overviewImageId: z.string().uuid(),
  labelImageIds: z.array(z.string().uuid()).max(5),
})
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.labelImageIds).size !== input.labelImageIds.length) {
      context.addIssue({
        code: "custom",
        path: ["labelImageIds"],
        message: "标签图片不能重复",
      });
    }
  });

const RecognitionResponseSchema = SuccessEnvelopeSchema(
  z.object({
    recognition: VisionResultSchema,
  }),
);

const IDEMPOTENCY_PENDING_STATUS_CODE = 102;
export const RECOGNITION_LEASE_DURATION_MS = 60_000;
const IDEMPOTENCY_WAIT_ATTEMPTS = 600;
const IDEMPOTENCY_WAIT_MS = 10;

export type RecognizeIngredientsInput = z.input<typeof RecognitionInputSchema>;
export type RecognizeIngredientsResponse = z.infer<typeof RecognitionResponseSchema>;

export interface RecognizeIngredientsResult {
  requestId: string;
  response: RecognizeIngredientsResponse;
  replayed: boolean;
}

export interface RecognizeIngredientsOptions {
  clock?: Clock;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseDurationMs?: number;
  maxWaitAttempts?: number;
  leaseOwnerFactory?: () => string;
}

export class VisionProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE";

  constructor() {
    super("PROVIDER_UNAVAILABLE");
    this.name = "VisionProviderUnavailableError";
  }
}

export class RecognitionImageNotFoundError extends Error {
  readonly code = "IMAGE_NOT_FOUND";

  constructor() {
    super("IMAGE_NOT_FOUND");
    this.name = "RecognitionImageNotFoundError";
  }
}

function parseStoredResponse(response: Record<string, unknown>): RecognizeIngredientsResponse {
  return RecognitionResponseSchema.parse(response);
}

function isPendingIdempotencyRecord(record: { statusCode: number }): boolean {
  return record.statusCode === IDEMPOTENCY_PENDING_STATUS_CODE;
}

function hasActiveLease(
  record: {
    leaseOwner: string | null;
    leaseExpiresAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    record.leaseOwner !== null &&
    record.leaseExpiresAt !== null &&
    record.leaseExpiresAt.getTime() > now.getTime()
  );
}

function replayFromRecord(
  requestId: string,
  record: { response: Record<string, unknown> },
): RecognizeIngredientsResult {
  return {
    requestId,
    response: parseStoredResponse(record.response),
    replayed: true,
  };
}

async function resolveIdempotencyRecord(
  unitOfWork: VisionUnitOfWork,
  requestId: string,
  requestFingerprint: string,
  clock: Clock,
  wait: (milliseconds: number) => Promise<void>,
  maxWaitAttempts: number,
): Promise<RecognizeIngredientsResult | null> {
  for (let attempt = 0; attempt < maxWaitAttempts; attempt += 1) {
    const record = unitOfWork.read().findIdempotencyRecordByRequestId(requestId);
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
  unitOfWork: VisionUnitOfWork,
  input: RecognizeIngredientsInput,
  requestFingerprint: string,
  leaseOwner: string,
  leaseExpiresAt: Date,
  now: Date,
): IdempotencyLeaseAcquisition {
  try {
    return unitOfWork.transactionVision((repository) =>
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
  unitOfWork: VisionUnitOfWork,
  requestId: string,
  leaseOwner: string,
  now: Date,
): void {
  try {
    unitOfWork.transactionVision((repository) => {
      repository.deleteIdempotencyRecord({ requestId, leaseOwner, now });
    });
  } catch (error) {
    if (error instanceof IdempotencyLeaseLostError) {
      return;
    }
    throw new IdempotencyReservationCleanupError(error);
  }
}

function assertImageBelongsToSession(
  unitOfWork: VisionUnitOfWork,
  sessionId: string,
  imageId: string,
  expectedRole: "overview" | "label_closeup",
): void {
  const image = unitOfWork.readVision().findImageById(imageId);
  if (image === null || image.sessionId !== sessionId || image.role !== expectedRole) {
    throw new RecognitionImageNotFoundError();
  }
}

function assertRecognitionPreconditions(
  unitOfWork: VisionUnitOfWork,
  input: RecognizeIngredientsInput,
): void {
  const session = unitOfWork.readVision().findById(input.sessionId);
  if (session === null) {
    throw new SessionNotFoundError();
  }
  if (session.version !== input.expectedVersion) {
    throw new VersionConflictError();
  }

  assertImageBelongsToSession(unitOfWork, input.sessionId, input.overviewImageId, "overview");
  for (const labelImageId of input.labelImageIds) {
    assertImageBelongsToSession(unitOfWork, input.sessionId, labelImageId, "label_closeup");
  }

  transition(session.state, SessionEvent.RECOGNIZE_INGREDIENTS, {
    hasPreferences: session.preferences !== null,
    hasOverviewImage: true,
    allIngredientsConfirmed: false,
    alcoholAbvConfirmed: false,
    hasRecipeSet: false,
    hasSelectedRecipe: false,
    hasSelectedAdjustedRecipe: false,
    currentStep: session.currentStep,
    totalSteps: null,
    hasFeedback: false,
  });
}

function isVersionConflict(error: unknown): boolean {
  return (
    error instanceof SessionVersionConflictError ||
    (error instanceof Error && error.message === "VERSION_CONFLICT")
  );
}

export async function recognizeIngredients(
  unitOfWork: VisionUnitOfWork,
  provider: VisionProvider,
  input: unknown,
  options: RecognizeIngredientsOptions = {},
): Promise<RecognizeIngredientsResult> {
  const clock = options.clock ?? systemClock;
  const wait = options.sleep ?? sleep;
  const leaseDurationMs = options.leaseDurationMs ?? RECOGNITION_LEASE_DURATION_MS;
  const maxWaitAttempts = options.maxWaitAttempts ?? IDEMPOTENCY_WAIT_ATTEMPTS;
  const leaseOwner = options.leaseOwnerFactory?.() ?? randomUUID();
  const parsed = RecognitionInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "recognize-ingredients",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    overviewImageId: parsed.overviewImageId,
    labelImageIds: parsed.labelImageIds,
  });
  for (let reservationAttempt = 0; reservationAttempt < 8; reservationAttempt += 1) {
    const existingResult = await resolveIdempotencyRecord(
      unitOfWork,
      parsed.requestId,
      requestFingerprint,
      clock,
      wait,
      maxWaitAttempts,
    );
    if (existingResult !== null) {
      return existingResult;
    }

    assertRecognitionPreconditions(unitOfWork, parsed);
    const now = clock.now();
    const acquisition = acquireIdempotencyLease(
      unitOfWork,
      parsed,
      requestFingerprint,
      leaseOwner,
      new Date(now.getTime() + leaseDurationMs),
      now,
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

    const visionInput = VisionInputSchema.parse({
      overviewImageId: parsed.overviewImageId,
      labelImageIds: parsed.labelImageIds,
    });
    let recognition: ReturnType<typeof normalizeVisionResult>;
    try {
      recognition = normalizeVisionResult(
        VisionResultSchema.parse(await provider.recognize(visionInput)),
      );
    } catch {
      releaseIdempotencyRecord(unitOfWork, parsed.requestId, leaseOwner, clock.now());
      throw new VisionProviderUnavailableError();
    }

    try {
      return unitOfWork.transactionVision((repository) => {
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

        const session = repository.findById(parsed.sessionId);
        if (session === null) {
          throw new SessionNotFoundError();
        }
        if (session.version !== parsed.expectedVersion) {
          throw new VersionConflictError();
        }

        const nextState = transition(session.state, SessionEvent.RECOGNIZE_INGREDIENTS, {
          hasPreferences: session.preferences !== null,
          hasOverviewImage: true,
          allIngredientsConfirmed: false,
          alcoholAbvConfirmed: false,
          hasRecipeSet: false,
          hasSelectedRecipe: false,
          hasSelectedAdjustedRecipe: false,
          currentStep: session.currentStep,
          totalSteps: null,
          hasFeedback: false,
        });

        repository.replaceForSession({
          sessionId: parsed.sessionId,
          ingredients: recognition.ingredients,
        });

        let updated;
        try {
          updated = repository.updateVersion({
            id: parsed.sessionId,
            expectedVersion: parsed.expectedVersion,
            leaseOwner,
            leaseNow: clock.now(),
            state: nextState,
          });
        } catch (error) {
          if (isVersionConflict(error)) {
            throw new VersionConflictError();
          }
          throw error;
        }

        repository.createDecisionEvent({
          sessionId: parsed.sessionId,
          type: "ingredients_recognized",
          summary: `已识别 ${recognition.ingredients.length} 项材料，等待用户确认。`,
          metadata: {
            sourceMode: recognition.sourceMode,
            needsLabelCloseup: recognition.needsLabelCloseup,
            ingredientCount: recognition.ingredients.length,
          },
        });

        const response: RecognizeIngredientsResponse = {
          data: { recognition },
          session: {
            id: SessionIdSchema.parse(updated.id),
            state: SessionStateSchema.parse(updated.state),
            version: updated.version,
          },
        };

        repository.completeIdempotencyRecord({
          requestId: parsed.requestId,
          leaseOwner,
          now: clock.now(),
          response,
          statusCode: 200,
        });

        return {
          requestId: parsed.requestId,
          response,
          replayed: false,
        };
      });
    } catch (error) {
      releaseIdempotencyRecord(unitOfWork, parsed.requestId, leaseOwner, clock.now());
      throw error;
    }
  }

  throw new IdempotencyInProgressError();
}
