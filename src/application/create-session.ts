import { z } from "zod";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import type { SessionUnitOfWork } from "@/src/application/unit-of-work";
import { createSessionId, RequestIdSchema, SessionIdSchema } from "@/src/domain/id";
import { SuccessEnvelopeSchema } from "@/src/domain/api";

const CreateSessionInputSchema = z
  .object({
    requestId: RequestIdSchema,
    requestContent: z.unknown().optional(),
  })
  .strict();

const CreateSessionResponseSchema = SuccessEnvelopeSchema(
  z.object({
    created: z.literal(true),
  }),
);

export type CreateSessionInput = z.input<typeof CreateSessionInputSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export interface CreateSessionResult {
  requestId: string;
  response: CreateSessionResponse;
  replayed: boolean;
}

function parseStoredResponse(response: Record<string, unknown>): CreateSessionResponse {
  return CreateSessionResponseSchema.parse(response);
}

function isRequestIdUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("idempotency_records.request_id");
}

export function createSession(
  unitOfWork: SessionUnitOfWork,
  input: CreateSessionInput,
): CreateSessionResult {
  const parsed = CreateSessionInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "create-session",
    requestContent: parsed.requestContent ?? {},
  });
  const existing = unitOfWork.read().findIdempotencyRecordByRequestId(parsed.requestId);

  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprint);

    return {
      requestId: parsed.requestId,
      response: parseStoredResponse(existing.response),
      replayed: true,
    };
  }

  const sessionId = createSessionId();

  try {
    return unitOfWork.transaction((repository) => {
      const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);

      if (transactionExisting !== null) {
        assertIdempotencyFingerprint(transactionExisting, requestFingerprint);

        return {
          requestId: parsed.requestId,
          response: parseStoredResponse(transactionExisting.response),
          replayed: true,
        };
      }

      const session = repository.create({ id: sessionId });
      const response: CreateSessionResponse = {
        data: { created: true },
        session: {
          id: SessionIdSchema.parse(session.id),
          state: session.state,
          version: session.version,
        },
      };

      repository.saveIdempotencyRecord({
        id: crypto.randomUUID(),
        sessionId: session.id,
        requestId: parsed.requestId,
        requestFingerprint,
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
    };
  }
}
