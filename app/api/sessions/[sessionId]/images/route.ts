import { z } from "zod";

import type { ImageProcessor } from "@/src/application/image-processing-port";
import { uploadSessionImage, type ImageUploadLimits } from "@/src/application/upload-session-image";
import type { SessionUnitOfWork } from "@/src/application/unit-of-work";
import { getDefaultSessionUnitOfWork } from "@/src/application/unit-of-work";
import { ImageRoleSchema, type ImageStore } from "@/src/providers/image-store";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import {
  ImageValidationError,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_UPLOAD_BYTES,
  validateImage,
} from "@/src/infrastructure/uploads/validate-image";
import {
  ImageNormalizationError,
  normalizeImage,
} from "@/src/infrastructure/uploads/normalize-image";
import { parseEnv } from "@/src/config/env";
import { IdempotencyKeyReusedError } from "@/src/application/idempotency";
import { RequestIdSchema } from "@/src/domain/id";
import { RecipeIdSchema } from "@/src/domain/id";
import { SessionNotFoundError } from "@/src/repositories/session-repository";
import { SessionMutationInProgressError } from "@/src/repositories/session-repository";
import {
  UploadStateError,
  UploadVersionConflictError,
} from "@/src/application/upload-session-image";

export interface ImageRouteContext {
  params: Promise<{ sessionId: string }>;
}

export const DEFAULT_MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface ImageRouteLimits extends ImageUploadLimits {
  maxRequestBodyBytes?: number;
}

class RequestBodyTooLargeError extends Error {
  readonly code = "FILE_TOO_LARGE" as const;
  readonly status = 413 as const;

  constructor() {
    super("图片请求体过大");
    this.name = "RequestBodyTooLargeError";
  }
}

class UnsupportedMultipartRequestError extends Error {
  readonly code = "UNSUPPORTED_MEDIA_TYPE" as const;
  readonly status = 415 as const;

  constructor() {
    super("图片上传必须使用 multipart/form-data");
    this.name = "UnsupportedMultipartRequestError";
  }
}

class MalformedMultipartRequestError extends Error {
  readonly code = "INVALID_REQUEST" as const;
  readonly status = 400 as const;

  constructor() {
    super("multipart/form-data 请求无法解析");
    this.name = "MalformedMultipartRequestError";
  }
}

function requestBodyLimit(limits: ImageRouteLimits): number {
  return limits.maxRequestBodyBytes ?? limits.maxBytes + DEFAULT_MULTIPART_OVERHEAD_BYTES;
}

async function readRequestWithinLimit(request: Request, maxBytes: number): Promise<Request> {
  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader !== null) {
    const contentLength = contentLengthHeader.trim();
    if (!/^\d+$/.test(contentLength)) {
      throw new MalformedMultipartRequestError();
    }
    if (!Number.isSafeInteger(Number(contentLength)) || Number(contentLength) > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
  }

  if (request.body === null) {
    return request;
  }

  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;

      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        throw new RequestBodyTooLargeError();
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw error;
    }
    throw new MalformedMultipartRequestError();
  } finally {
    reader.releaseLock();
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: Buffer.concat(chunks, total),
  });
}

async function readMultipartFormData(request: Request, maxBytes: number): Promise<FormData> {
  const contentType = request.headers.get("content-type")?.trim() ?? "";
  if (!/^multipart\/form-data\b/i.test(contentType)) {
    throw new UnsupportedMultipartRequestError();
  }
  if (!/;\s*boundary\s*=/i.test(contentType)) {
    throw new MalformedMultipartRequestError();
  }

  const boundedRequest = await readRequestWithinLimit(request, maxBytes);
  try {
    return await boundedRequest.formData();
  } catch {
    throw new MalformedMultipartRequestError();
  }
}

const ExpectedVersionSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative());

const StepIndexSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative());

const defaultImageProcessor: ImageProcessor = {
  validate: validateImage,
  normalize: normalizeImage,
};

function responseError(code: string, message: string, status: number, retryable = false): Response {
  return Response.json({ error: { code, message, retryable } }, { status });
}

function isFileLike(value: FormDataEntryValue | null): value is File {
  return (
    value !== null &&
    typeof value === "object" &&
    "arrayBuffer" in value &&
    typeof value.arrayBuffer === "function" &&
    "name" in value &&
    typeof value.name === "string" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

async function readFileWithinLimit(file: File, maxBytes: number): Promise<Uint8Array> {
  if (file.size > maxBytes) {
    throw new ImageValidationError("FILE_TOO_LARGE", 413, "图片文件过大");
  }

  const reader = file.stream().getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;

      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > maxBytes) {
        throw new ImageValidationError("FILE_TOO_LARGE", 413, "图片文件过大");
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

export function createImageRouteHandlers(
  unitOfWork: SessionUnitOfWork,
  store: ImageStore,
  limits: ImageRouteLimits = {
    maxBytes: DEFAULT_MAX_UPLOAD_BYTES,
    maxPixels: DEFAULT_MAX_IMAGE_PIXELS,
    longEdge: 2_048,
  },
  imageProcessor: ImageProcessor = defaultImageProcessor,
) {
  return {
    async POST(request: Request, context: ImageRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const form = await readMultipartFormData(request, requestBodyLimit(limits));
        const requestId = RequestIdSchema.parse(form.get("requestId"));
        const expectedVersion = ExpectedVersionSchema.parse(form.get("expectedVersion"));
        const role = ImageRoleSchema.parse(form.get("role"));
        const recipeIdValue = form.get("recipeId");
        const stepIndexValue = form.get("stepIndex");
        const recipeId = recipeIdValue === null ? undefined : RecipeIdSchema.parse(recipeIdValue);
        const stepIndex =
          stepIndexValue === null ? undefined : StepIndexSchema.parse(stepIndexValue);
        const file = form.get("file");

        if (!isFileLike(file)) {
          return responseError("INVALID_REQUEST", "请求格式不正确", 400);
        }

        const bytes = await readFileWithinLimit(file, limits.maxBytes);
        const result = await uploadSessionImage(
          unitOfWork,
          store,
          {
            sessionId,
            requestId,
            expectedVersion,
            role,
            recipeId,
            stepIndex,
            filename: file.name,
            declaredMime: file.type,
            bytes,
            limits: {
              maxBytes: limits.maxBytes,
              maxPixels: limits.maxPixels,
              longEdge: limits.longEdge,
            },
          },
          imageProcessor,
        );

        return Response.json(result.response, { status: 201 });
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return responseError(error.code, error.message, error.status);
        }

        if (error instanceof UnsupportedMultipartRequestError) {
          return responseError(error.code, error.message, error.status);
        }

        if (error instanceof MalformedMultipartRequestError) {
          return responseError(error.code, error.message, error.status);
        }

        if (error instanceof ImageValidationError || error instanceof ImageNormalizationError) {
          return responseError(error.code, error.message, error.status);
        }

        if (error instanceof z.ZodError) {
          return responseError("INVALID_REQUEST", "请求格式不正确", 400);
        }

        if (error instanceof SessionNotFoundError) {
          return responseError("NOT_FOUND", "会话不存在", 404);
        }

        if (error instanceof IdempotencyKeyReusedError) {
          return responseError("IDEMPOTENCY_KEY_REUSED", "requestId 已用于不同请求内容", 409);
        }

        if (error instanceof UploadVersionConflictError) {
          return responseError("VERSION_CONFLICT", "会话版本已过期，请重新加载", 409, true);
        }

        if (error instanceof SessionMutationInProgressError) {
          return responseError(
            "SESSION_MUTATION_IN_PROGRESS",
            "会话正在被其他请求修改，请稍后重试",
            409,
            true,
          );
        }

        if (error instanceof UploadStateError) {
          return responseError("INVALID_STATE", "当前会话状态不允许上传此角色图片", 409);
        }

        return responseError("INTERNAL_ERROR", "服务器内部错误", 500);
      }
    },
  };
}

export async function POST(request: Request, context: ImageRouteContext): Promise<Response> {
  try {
    const environment = parseEnv();
    const handlers = createImageRouteHandlers(
      getDefaultSessionUnitOfWork(),
      new LocalImageStore(environment.UPLOAD_DIR),
      {
        maxBytes: environment.MAX_UPLOAD_BYTES,
        maxPixels: environment.MAX_IMAGE_PIXELS,
        longEdge: environment.IMAGE_LONG_EDGE,
        maxRequestBodyBytes: environment.MAX_UPLOAD_BYTES + DEFAULT_MULTIPART_OVERHEAD_BYTES,
      },
    );

    return await handlers.POST(request, context);
  } catch {
    return responseError("INTERNAL_ERROR", "服务器内部错误", 500);
  }
}
