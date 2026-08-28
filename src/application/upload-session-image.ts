import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import { acquireSessionMutationLease } from "@/src/application/session-mutation-lease";
import type {
  SessionTransactionRepository,
  SessionUnitOfWork,
} from "@/src/application/unit-of-work";
import { SuccessEnvelopeSchema } from "@/src/domain/api";
import { RecipeIdSchema, RequestIdSchema, SessionIdSchema } from "@/src/domain/id";
import { SessionStateSchema } from "@/src/domain/session";
import {
  DEFAULT_IMAGE_PIXELS,
  DEFAULT_IMAGE_UPLOAD_BYTES,
  type ImageProcessor,
  type ImageValidationLimits,
} from "@/src/application/image-processing-port";
import type { ImageStore } from "@/src/providers/image-store";
import { ImageRoleSchema, type ImageRole } from "@/src/providers/image-store";
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";

const UploadLimitsSchema = z.object({
  maxBytes: z.number().int().positive(),
  maxPixels: z.number().int().positive(),
  longEdge: z.number().int().positive(),
});

const UploadBytesSchema = z.custom<Uint8Array<ArrayBufferLike>>(
  (value) => value instanceof Uint8Array,
  "Expected image bytes",
);

const UploadSessionImageInputSchema = z
  .object({
    sessionId: SessionIdSchema,
    requestId: RequestIdSchema,
    expectedVersion: z.number().int().nonnegative(),
    role: ImageRoleSchema,
    filename: z.string().min(1),
    declaredMime: z.string().min(1),
    bytes: UploadBytesSchema,
    recipeId: RecipeIdSchema.optional(),
    stepIndex: z.number().int().nonnegative().optional(),
    limits: UploadLimitsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const hasRecipe = value.recipeId !== undefined;
    const hasStep = value.stepIndex !== undefined;
    if (value.role === "mixing_step" && (!hasRecipe || !hasStep)) {
      context.addIssue({
        code: "custom",
        path: ["recipeId"],
        message: "Mixing step images require a recipe and step",
      });
    }
    if (value.role !== "mixing_step" && (hasRecipe || hasStep)) {
      context.addIssue({
        code: "custom",
        path: ["recipeId"],
        message: "Only mixing step images may include a recipe and step",
      });
    }
  });

const UploadSessionImageResponseSchema = SuccessEnvelopeSchema(
  z.object({
    image: z.object({
      id: z.string().uuid(),
      role: ImageRoleSchema,
      mime: z.literal("image/jpeg"),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }),
  }),
);

export type ImageUploadLimits = z.infer<typeof UploadLimitsSchema>;
export type UploadSessionImageInput = z.input<typeof UploadSessionImageInputSchema>;
export type UploadSessionImageResponse = z.infer<typeof UploadSessionImageResponseSchema>;

export interface UploadSessionImageResult {
  requestId: string;
  response: UploadSessionImageResponse;
  replayed: boolean;
}

interface TransactionUploadResult extends UploadSessionImageResult {
  replacedObjectKey: string | null;
}

export class UploadVersionConflictError extends Error {
  readonly code = "VERSION_CONFLICT";

  constructor() {
    super("VERSION_CONFLICT");
    this.name = "UploadVersionConflictError";
  }
}

export class UploadStateError extends Error {
  readonly code = "INVALID_STATE";

  constructor() {
    super("INVALID_STATE");
    this.name = "UploadStateError";
  }
}

export class UploadCompensationError extends Error {
  readonly code = "UPLOAD_COMPENSATION_FAILED";

  constructor(cause: unknown) {
    super("UPLOAD_COMPENSATION_FAILED", { cause });
    this.name = "UploadCompensationError";
  }
}

const DEFAULT_LIMITS: ImageUploadLimits = {
  maxBytes: DEFAULT_IMAGE_UPLOAD_BYTES,
  maxPixels: DEFAULT_IMAGE_PIXELS,
  longEdge: 2_048,
};

function parseStoredResponse(response: Record<string, unknown>): UploadSessionImageResponse {
  return UploadSessionImageResponseSchema.parse(response);
}

function requestFingerprint(input: UploadSessionImageInput): string {
  const bytesSha256 = createHash("sha256").update(input.bytes).digest("hex");

  return fingerprintRequest({
    operation: "upload-session-image",
    sessionId: input.sessionId,
    expectedVersion: input.expectedVersion,
    role: input.role,
    recipeId: input.recipeId ?? null,
    stepIndex: input.stepIndex ?? null,
    filename: input.filename,
    declaredMime: input.declaredMime.trim().toLowerCase(),
    bytesSha256,
  });
}

function allowedStateForRole(role: ImageRole): "SCAN" | "CONFIRM" | "FEEDBACK" | "MIXING" {
  if (role === "overview") return "SCAN";
  if (role === "label_closeup") return "CONFIRM";
  if (role === "mixing_step") return "MIXING";
  return "FEEDBACK";
}

function assertRoleState(role: ImageRole, state: string): void {
  const expectedState = allowedStateForRole(role);
  if (state !== expectedState) {
    throw new UploadStateError();
  }
}

function assertMixingStepUpload(
  repository: Pick<SessionTransactionRepository, "findRecipeById">,
  input: UploadSessionImageInput,
  session: { id: string; selectedRecipeId: string | null; currentStep: number | null },
): void {
  if (input.recipeId === undefined || input.stepIndex === undefined) {
    throw new UploadStateError();
  }
  if (session.selectedRecipeId !== input.recipeId || session.currentStep !== input.stepIndex) {
    throw new UploadStateError();
  }
  const recipe = repository.findRecipeById(input.recipeId);
  if (
    recipe === null ||
    recipe.sessionId !== session.id ||
    recipe.steps[input.stepIndex]?.isPhotoCheckpoint !== true
  ) {
    throw new UploadStateError();
  }
}

async function deleteStoredObject(store: ImageStore, objectKey: string): Promise<void> {
  try {
    await store.delete(objectKey);
  } catch (error) {
    throw new UploadCompensationError(error);
  }
}

function replayFromRecord(
  requestId: string,
  record: { response: Record<string, unknown> },
): TransactionUploadResult {
  return {
    requestId,
    response: parseStoredResponse(record.response),
    replayed: true,
    replacedObjectKey: null,
  };
}

export async function uploadSessionImage(
  unitOfWork: SessionUnitOfWork,
  store: ImageStore,
  input: UploadSessionImageInput,
  imageProcessor: ImageProcessor,
): Promise<UploadSessionImageResult> {
  const parsed = UploadSessionImageInputSchema.parse(input);
  const limits = parsed.limits ?? DEFAULT_LIMITS;
  const requestFingerprintValue = requestFingerprint(parsed);
  const existing = unitOfWork.read().findIdempotencyRecordByRequestId(parsed.requestId);

  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprintValue);
    return replayFromRecord(parsed.requestId, existing);
  }

  const validated = await imageProcessor.validate(
    {
      filename: parsed.filename,
      declaredMime: parsed.declaredMime,
      bytes: parsed.bytes,
    },
    limits satisfies ImageValidationLimits,
  );
  const normalized = await imageProcessor.normalize(validated.bytes, { longEdge: limits.longEdge });
  const imageId = randomUUID();
  const stored = await store.save({
    sessionId: parsed.sessionId,
    role: parsed.role,
    imageId,
    bytes: normalized.bytes,
  });

  let result: TransactionUploadResult;
  try {
    result = unitOfWork.transaction<TransactionUploadResult>((repository) => {
      const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);

      if (transactionExisting !== null) {
        assertIdempotencyFingerprint(transactionExisting, requestFingerprintValue);
        return replayFromRecord(parsed.requestId, transactionExisting);
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
          throw new UploadVersionConflictError();
        }
        throw error;
      }

      const session = repository.findById(parsed.sessionId);
      if (session === null) {
        throw new SessionNotFoundError();
      }
      assertRoleState(parsed.role, SessionStateSchema.parse(session.state));

      if (parsed.role === "mixing_step") {
        assertMixingStepUpload(repository, parsed, session);
      }

      const previous =
        parsed.role === "mixing_step" &&
        parsed.recipeId !== undefined &&
        parsed.stepIndex !== undefined
          ? repository.findMixingStepImage(parsed.sessionId, parsed.recipeId, parsed.stepIndex)
          : null;
      const savedImage =
        previous === null
          ? repository.createImage({
              id: imageId,
              sessionId: parsed.sessionId,
              role: parsed.role,
              recipeId: parsed.recipeId ?? null,
              stepIndex: parsed.stepIndex ?? null,
              objectKey: stored.objectKey,
              mime: normalized.mime,
              width: normalized.width,
              height: normalized.height,
            })
          : repository.updateImage({
              id: previous.id,
              objectKey: stored.objectKey,
              mime: normalized.mime,
              width: normalized.width,
              height: normalized.height,
            });

      let updated;
      try {
        updated = repository.updateVersion({
          id: parsed.sessionId,
          expectedVersion: parsed.expectedVersion,
          leaseOwner: parsed.requestId,
          state: session.state,
        });
      } catch (error) {
        if (error instanceof SessionVersionConflictError) {
          throw new UploadVersionConflictError();
        }
        throw error;
      }

      const response: UploadSessionImageResponse = {
        data: {
          image: {
            id: savedImage.id,
            role: parsed.role,
            mime: normalized.mime,
            width: normalized.width,
            height: normalized.height,
          },
        },
        session: {
          id: SessionIdSchema.parse(updated.id),
          state: updated.state,
          version: updated.version,
        },
      };

      repository.saveIdempotencyRecord({
        id: randomUUID(),
        sessionId: updated.id,
        requestId: parsed.requestId,
        requestFingerprint: requestFingerprintValue,
        response,
        statusCode: 201,
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
        replacedObjectKey: previous?.objectKey ?? null,
      };
    });
  } catch (error) {
    const record = unitOfWork.read().findIdempotencyRecordByRequestId(parsed.requestId);
    if (record !== null) {
      try {
        assertIdempotencyFingerprint(record, requestFingerprintValue);
      } catch (fingerprintError) {
        await deleteStoredObject(store, stored.objectKey);
        throw fingerprintError;
      }

      await deleteStoredObject(store, stored.objectKey);
      return replayFromRecord(parsed.requestId, record);
    }

    await deleteStoredObject(store, stored.objectKey);
    throw error;
  }

  if (result.replacedObjectKey !== null) {
    await deleteStoredObject(store, result.replacedObjectKey);
  }

  if (result.replayed) {
    const winningImageId = result.response.data.image.id;
    if (winningImageId !== imageId) {
      await deleteStoredObject(store, stored.objectKey);
    }
  }

  return result;
}
