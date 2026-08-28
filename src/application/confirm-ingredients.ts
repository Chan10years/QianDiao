import { randomUUID } from "node:crypto";

import { z } from "zod";

import { assertIdempotencyFingerprint, fingerprintRequest } from "@/src/application/idempotency";
import { acquireSessionMutationLease } from "@/src/application/session-mutation-lease";
import type { VisionUnitOfWork } from "@/src/application/unit-of-work";
import { MutationMetaSchema, SuccessEnvelopeSchema } from "@/src/domain/api";
import { DetectedIngredientSchema, type DetectedIngredient } from "@/src/domain/ingredient";
import { SessionIdSchema } from "@/src/domain/id";
import { isAlcoholIngredient } from "@/src/providers/vision-provider";
import {
  SessionNotFoundError,
  SessionVersionConflictError,
} from "@/src/repositories/session-repository";
import { SessionEvent, transition } from "@/src/workflow/session-machine";
import { VersionConflictError } from "@/src/application/save-preferences";

const ConfirmIngredientsInputSchema = MutationMetaSchema.extend({
  sessionId: SessionIdSchema,
  ingredients: z.array(DetectedIngredientSchema).min(1).max(50),
})
  .strict()
  .superRefine((input, context) => {
    const canonicalNames = input.ingredients.map((ingredient) => ingredient.canonicalName);
    if (new Set(canonicalNames).size !== canonicalNames.length) {
      context.addIssue({
        code: "custom",
        path: ["ingredients"],
        message: "材料规范名称不能重复",
      });
    }
  });

const ConfirmIngredientsResponseSchema = SuccessEnvelopeSchema(
  z.object({
    ingredients: z.array(DetectedIngredientSchema).min(1).max(50),
  }),
);

export type ConfirmIngredientsInput = z.input<typeof ConfirmIngredientsInputSchema>;
export type ConfirmIngredientsResponse = z.infer<typeof ConfirmIngredientsResponseSchema>;

export interface ConfirmIngredientsResult {
  requestId: string;
  response: ConfirmIngredientsResponse;
  replayed: boolean;
}

export class IngredientConfirmationRequiredError extends Error {
  readonly code = "INGREDIENT_CONFIRMATION_REQUIRED";

  constructor() {
    super("INGREDIENT_CONFIRMATION_REQUIRED");
    this.name = "IngredientConfirmationRequiredError";
  }
}

export class IngredientAbvRequiredError extends Error {
  readonly code = "ABV_REQUIRED";

  constructor() {
    super("ABV_REQUIRED");
    this.name = "IngredientAbvRequiredError";
  }
}

export class IngredientCategoryRequiredError extends Error {
  readonly code = "INGREDIENT_CATEGORY_REQUIRED";

  constructor() {
    super("INGREDIENT_CATEGORY_REQUIRED");
    this.name = "IngredientCategoryRequiredError";
  }
}

function parseStoredResponse(response: Record<string, unknown>): ConfirmIngredientsResponse {
  return ConfirmIngredientsResponseSchema.parse(response);
}

function isRequestIdUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes("idempotency_records.request_id");
}

function replayFromRecord(
  requestId: string,
  record: { response: Record<string, unknown> },
): ConfirmIngredientsResult {
  return {
    requestId,
    response: parseStoredResponse(record.response),
    replayed: true,
  };
}

function assertIngredientsCanBeConfirmed(ingredients: readonly DetectedIngredient[]): void {
  if (ingredients.some((ingredient) => !ingredient.confirmed)) {
    throw new IngredientConfirmationRequiredError();
  }

  if (ingredients.some((ingredient) => ingredient.category === "unknown")) {
    throw new IngredientCategoryRequiredError();
  }

  if (
    ingredients.some((ingredient) => isAlcoholIngredient(ingredient) && ingredient.abv === null)
  ) {
    throw new IngredientAbvRequiredError();
  }
}

export async function confirmIngredients(
  unitOfWork: VisionUnitOfWork,
  input: unknown,
): Promise<ConfirmIngredientsResult> {
  const parsed = ConfirmIngredientsInputSchema.parse(input);
  const requestFingerprint = fingerprintRequest({
    operation: "confirm-ingredients",
    sessionId: parsed.sessionId,
    expectedVersion: parsed.expectedVersion,
    ingredients: parsed.ingredients,
  });
  const existing = unitOfWork.read().findIdempotencyRecordByRequestId(parsed.requestId);

  if (existing !== null) {
    assertIdempotencyFingerprint(existing, requestFingerprint);
    return replayFromRecord(parsed.requestId, existing);
  }

  assertIngredientsCanBeConfirmed(parsed.ingredients);

  try {
    return unitOfWork.transactionVision((repository) => {
      const transactionExisting = repository.findIdempotencyRecordByRequestId(parsed.requestId);
      if (transactionExisting !== null) {
        assertIdempotencyFingerprint(transactionExisting, requestFingerprint);
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
          throw new VersionConflictError();
        }
        throw error;
      }

      const session = repository.findById(parsed.sessionId);
      if (session === null) {
        throw new SessionNotFoundError();
      }
      if (session.version !== parsed.expectedVersion) {
        throw new VersionConflictError();
      }

      const nextState = transition(session.state, SessionEvent.CONFIRM_INGREDIENTS, {
        hasPreferences: session.preferences !== null,
        hasOverviewImage: true,
        allIngredientsConfirmed: parsed.ingredients.every((ingredient) => ingredient.confirmed),
        alcoholAbvConfirmed: parsed.ingredients.every(
          (ingredient) => !isAlcoholIngredient(ingredient) || ingredient.abv !== null,
        ),
        hasRecipeSet: false,
        hasSelectedRecipe: false,
        hasSelectedAdjustedRecipe: false,
        currentStep: session.currentStep,
        totalSteps: null,
        hasFeedback: false,
      });

      repository.replaceForSession({
        sessionId: parsed.sessionId,
        ingredients: parsed.ingredients,
      });
      let updated;
      try {
        updated = repository.updateVersion({
          id: parsed.sessionId,
          expectedVersion: parsed.expectedVersion,
          leaseOwner: parsed.requestId,
          state: nextState,
        });
      } catch (error) {
        if (error instanceof SessionVersionConflictError) {
          throw new VersionConflictError();
        }
        throw error;
      }

      repository.createDecisionEvent({
        sessionId: parsed.sessionId,
        type: "ingredients_confirmed",
        summary: `用户已确认 ${parsed.ingredients.length} 项材料，可进入配方生成。`,
        metadata: {
          ingredientCount: parsed.ingredients.length,
          alcoholAbvConfirmed: true,
        },
      });

      const response: ConfirmIngredientsResponse = {
        data: { ingredients: parsed.ingredients },
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
  } catch (error) {
    if (!isRequestIdUniqueViolation(error)) {
      throw error;
    }

    const record = unitOfWork.read().findIdempotencyRecordByRequestId(parsed.requestId);
    if (record === null) {
      throw error;
    }
    assertIdempotencyFingerprint(record, requestFingerprint);
    return replayFromRecord(parsed.requestId, record);
  }
}
