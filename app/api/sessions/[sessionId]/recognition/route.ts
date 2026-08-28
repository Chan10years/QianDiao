import { z } from "zod";

import { getDefaultSessionUnitOfWork } from "@/src/application/unit-of-work";
import { recognizeIngredients } from "@/src/application/recognize-ingredients";
import type { VisionUnitOfWork } from "@/src/application/unit-of-work";
import { parseEnv } from "@/src/config/env";
import { LocalImageStore } from "@/src/infrastructure/uploads/local-image-store";
import { RepositoryVisionImageLoader } from "@/src/infrastructure/providers/repository-vision-image-loader";
import { createConfiguredVisionProvider } from "@/src/infrastructure/providers/vision-provider-factory";
import type { VisionProvider } from "@/src/providers/vision-provider";
import { mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const JsonObjectSchema = z.record(z.string(), z.unknown());

export interface RecognitionRouteContext {
  params: Promise<{ sessionId: string }>;
}

export function createRecognitionRouteHandlers(
  unitOfWork: VisionUnitOfWork,
  provider: VisionProvider,
) {
  return {
    async POST(request: Request, context: RecognitionRouteContext): Promise<Response> {
      try {
        const { sessionId } = await context.params;
        const body = JsonObjectSchema.parse(await readJson(request));
        const result = await recognizeIngredients(unitOfWork, provider, { ...body, sessionId });

        return Response.json(result.response, { status: 200 });
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function POST(request: Request, context: RecognitionRouteContext): Promise<Response> {
  const environment = parseEnv();
  const unitOfWork = getDefaultSessionUnitOfWork();
  return createRecognitionRouteHandlers(
    unitOfWork,
    createConfiguredVisionProvider(environment, {
      imageLoader: new RepositoryVisionImageLoader(
        unitOfWork.readVision(),
        new LocalImageStore(environment.UPLOAD_DIR),
      ),
    }),
  ).POST(request, context);
}
