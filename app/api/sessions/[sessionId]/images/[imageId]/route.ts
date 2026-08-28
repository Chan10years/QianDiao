import { z } from "zod";

import type { VisionUnitOfWork } from "@/src/application/unit-of-work";
import { getDefaultSessionUnitOfWork } from "@/src/application/unit-of-work";
import { SessionIdSchema } from "@/src/domain/id";
import type { ImageReader } from "@/src/providers/image-store";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { parseEnv } from "@/src/config/env";

export interface ImageReadRouteContext {
  params: Promise<{ sessionId: string; imageId: string }>;
}

const ImageIdSchema = z.string().uuid();

export function createImageReadRouteHandler(
  unitOfWork: VisionUnitOfWork,
  reader: ImageReader,
): (request: Request, context: ImageReadRouteContext) => Promise<Response> {
  return async (_request, context) => {
    const { sessionId, imageId } = await context.params;
    const parsedSessionId = SessionIdSchema.safeParse(sessionId);
    const parsedImageId = ImageIdSchema.safeParse(imageId);
    if (!parsedSessionId.success || !parsedImageId.success) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "图片不存在" } },
        { status: 404 },
      );
    }

    const image = unitOfWork.readVision().findImageById(parsedImageId.data);
    if (image === null || image.sessionId !== parsedSessionId.data) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "图片不存在" } },
        { status: 404 },
      );
    }

    try {
      const bytes = await reader.read(image.objectKey);
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: {
          "cache-control": "private, no-store",
          "content-type": image.mime,
        },
      });
    } catch {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "图片不存在" } },
        { status: 404 },
      );
    }
  };
}

export async function GET(request: Request, context: ImageReadRouteContext): Promise<Response> {
  const environment = parseEnv();
  return createImageReadRouteHandler(
    getDefaultSessionUnitOfWork(),
    new LocalImageStore(environment.UPLOAD_DIR),
  )(request, context);
}
