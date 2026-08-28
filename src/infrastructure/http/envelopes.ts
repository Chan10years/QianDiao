import { z } from "zod";

import {
  SessionMutationInProgressError,
  SessionMutationLeaseLostError,
  SessionNotFoundError,
} from "@/src/repositories/session-repository";
import {
  IdempotencyInProgressError,
  IdempotencyKeyReusedError,
} from "@/src/application/idempotency";
import { VersionConflictError } from "@/src/application/save-preferences";
import {
  IngredientAbvRequiredError,
  IngredientCategoryRequiredError,
  IngredientConfirmationRequiredError,
} from "@/src/application/confirm-ingredients";
import {
  RecognitionImageNotFoundError,
  VisionProviderUnavailableError,
} from "@/src/application/recognize-ingredients";
import {
  IdempotencyLeaseLostError,
  IdempotencyReservationCleanupError,
} from "@/src/repositories/idempotency-reservation-repository";
import { SessionTransitionError } from "@/src/workflow/session-machine";
import {
  FeedbackImageInvalidError,
  FeedbackRecipeNotFoundError,
} from "@/src/application/save-feedback";
import {
  AdjustmentFeedbackInvalidError,
  AdjustmentInvalidStateError,
  AdjustmentProviderUnavailableError,
  AdjustmentSafetyEvaluationError,
  AdjustmentSafetyBlockedError,
  AdjustmentProposalPendingError,
} from "@/src/application/generate-adjustment";
import {
  AcceptAdjustmentInvalidStateError,
  AdjustmentProposalInvalidError,
} from "@/src/application/accept-adjustment";
import {
  CompletionFeedbackInvalidError,
  CompletionSafetyInvalidError,
} from "@/src/application/complete-session";
import { RecipeDataIntegrityError } from "@/src/repositories/recipe-repository";

export const SessionErrorCodeSchema = z.enum([
  "INVALID_REQUEST",
  "NOT_FOUND",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "IDEMPOTENCY_LEASE_LOST",
  "IDEMPOTENCY_CLEANUP_FAILED",
  "SESSION_MUTATION_IN_PROGRESS",
  "SESSION_MUTATION_LEASE_LOST",
  "IMAGE_NOT_FOUND",
  "INGREDIENT_CONFIRMATION_REQUIRED",
  "INGREDIENT_CATEGORY_REQUIRED",
  "ABV_REQUIRED",
  "PROVIDER_UNAVAILABLE",
  "SAFETY_BLOCKED",
  "INVALID_STATE",
  "INTERNAL_ERROR",
]);

export class InvalidRequestError extends Error {
  readonly code = "INVALID_REQUEST";

  constructor() {
    super("INVALID_REQUEST");
    this.name = "InvalidRequestError";
  }
}

export const SessionErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: SessionErrorCodeSchema,
        message: z.string().trim().min(1),
        retryable: z.boolean(),
        fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
      })
      .strict(),
  })
  .strict();

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new InvalidRequestError();
  }
}

export function errorResponse(
  code: z.infer<typeof SessionErrorCodeSchema>,
  message: string,
  status: number,
  retryable = false,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        retryable,
      },
    },
    { status },
  );
}

export function mapSessionError(error: unknown): Response {
  if (error instanceof InvalidRequestError || error instanceof z.ZodError) {
    return errorResponse("INVALID_REQUEST", "请求格式不正确", 400);
  }

  if (error instanceof SessionNotFoundError) {
    return errorResponse("NOT_FOUND", "会话不存在", 404);
  }

  if (error instanceof IdempotencyKeyReusedError) {
    return errorResponse("IDEMPOTENCY_KEY_REUSED", "requestId 已用于不同请求内容", 409);
  }

  if (error instanceof IdempotencyInProgressError) {
    return errorResponse(
      "IDEMPOTENCY_IN_PROGRESS",
      "相同 requestId 的请求正在处理中，请稍后重试",
      409,
      true,
    );
  }

  if (error instanceof IdempotencyLeaseLostError) {
    return errorResponse("IDEMPOTENCY_LEASE_LOST", "识别请求已被其他执行者接管，请重试", 409, true);
  }

  if (error instanceof IdempotencyReservationCleanupError) {
    return errorResponse("IDEMPOTENCY_CLEANUP_FAILED", "识别请求清理失败，请稍后重试", 503, true);
  }

  if (error instanceof SessionMutationInProgressError) {
    return errorResponse(
      "SESSION_MUTATION_IN_PROGRESS",
      "会话正在被其他请求修改，请稍后重试",
      409,
      true,
    );
  }

  if (error instanceof SessionMutationLeaseLostError) {
    return errorResponse("SESSION_MUTATION_LEASE_LOST", "会话修改租约已失效，请重试", 409, true);
  }

  if (error instanceof VersionConflictError) {
    return errorResponse("VERSION_CONFLICT", "会话版本已过期，请重新加载", 409, true);
  }

  if (error instanceof RecognitionImageNotFoundError) {
    return errorResponse("IMAGE_NOT_FOUND", "识别所需图片不存在", 404);
  }

  if (error instanceof IngredientConfirmationRequiredError) {
    return errorResponse("INGREDIENT_CONFIRMATION_REQUIRED", "请确认所有材料后继续", 422);
  }

  if (error instanceof IngredientCategoryRequiredError) {
    return errorResponse("INGREDIENT_CATEGORY_REQUIRED", "请先将未知材料归类为受控材料", 422);
  }

  if (error instanceof IngredientAbvRequiredError) {
    return errorResponse("ABV_REQUIRED", "请确认酒类的酒精度（ABV）后继续", 422);
  }

  if (error instanceof VisionProviderUnavailableError) {
    return errorResponse("PROVIDER_UNAVAILABLE", "识别服务暂时不可用，请重试或手动确认", 503, true);
  }

  if (error instanceof FeedbackRecipeNotFoundError) {
    return errorResponse("NOT_FOUND", "配方不存在或不属于当前会话", 404);
  }

  if (error instanceof FeedbackImageInvalidError) {
    return errorResponse("INVALID_REQUEST", "成品图片不存在或不是 final_drink 图片", 422);
  }

  if (error instanceof AdjustmentProviderUnavailableError) {
    return errorResponse("PROVIDER_UNAVAILABLE", "调整服务暂时不可用，请重试", 503, true);
  }

  if (error instanceof AdjustmentSafetyBlockedError) {
    return errorResponse("SAFETY_BLOCKED", "调整配方未通过确定性安全裁决", 422);
  }

  if (error instanceof AdjustmentSafetyEvaluationError) {
    return errorResponse("INVALID_STATE", "调整配方安全裁决失败，请重试", 503, true);
  }

  if (
    error instanceof AdjustmentInvalidStateError ||
    error instanceof AcceptAdjustmentInvalidStateError ||
    error instanceof AdjustmentFeedbackInvalidError ||
    error instanceof AdjustmentProposalPendingError ||
    error instanceof AdjustmentProposalInvalidError ||
    error instanceof CompletionFeedbackInvalidError ||
    error instanceof CompletionSafetyInvalidError ||
    error instanceof RecipeDataIntegrityError
  ) {
    return errorResponse("INVALID_STATE", "当前反馈调整状态不允许此操作", 409);
  }

  if (error instanceof SessionTransitionError) {
    return errorResponse("INVALID_STATE", "当前会话状态不允许此操作", 409);
  }

  return errorResponse("INTERNAL_ERROR", "服务器内部错误", 500);
}
