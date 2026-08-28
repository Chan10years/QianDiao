import { z } from "zod";

import { RequestIdSchema, SessionIdSchema, type SessionId } from "@/src/domain/id";
import { SessionStateSchema, SessionVersionSchema, type SessionState } from "@/src/domain/session";

export const ErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "INVALID_STATE",
  "IDEMPOTENCY_CONFLICT",
  "FILE_TOO_LARGE",
  "UNSUPPORTED_MEDIA_TYPE",
  "ABV_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "SAFETY_BLOCKED",
  "INTERNAL_ERROR",
]);

export const MutationMetaSchema = z
  .object({
    requestId: RequestIdSchema,
    expectedVersion: SessionVersionSchema,
  })
  .strict();

const SessionEnvelopeSchema = z
  .object({
    id: SessionIdSchema,
    state: SessionStateSchema,
    version: SessionVersionSchema,
  })
  .strict();

export function SuccessEnvelopeSchema<T extends z.ZodType>(dataSchema: T) {
  return z
    .object({
      data: dataSchema,
      session: SessionEnvelopeSchema,
    })
    .strict();
}

export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        message: z.string().trim().min(1),
        retryable: z.boolean(),
        fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
      })
      .strict(),
  })
  .strict();

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export type MutationMeta = z.infer<typeof MutationMetaSchema>;
export type SuccessEnvelope<T> = {
  data: T;
  session: {
    id: SessionId;
    state: SessionState;
    version: number;
  };
};
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
