import { z } from "zod";

import { createSession } from "@/src/application/create-session";
import type { SessionUnitOfWork } from "@/src/application/unit-of-work";
import { getDefaultSessionUnitOfWork } from "@/src/application/unit-of-work";
import { RequestIdSchema } from "@/src/domain/id";
import { errorResponse, mapSessionError, readJson } from "@/src/infrastructure/http/envelopes";

const CreateSessionBodySchema = z
  .object({
    requestId: RequestIdSchema,
  })
  .catchall(z.unknown());

export function createSessionRouteHandlers(unitOfWork: SessionUnitOfWork) {
  return {
    async POST(request: Request): Promise<Response> {
      try {
        const rawBody = CreateSessionBodySchema.parse(await readJson(request));
        const { requestId, ...requestContent } = rawBody;
        const result = createSession(unitOfWork, { requestId, requestContent });

        return Response.json(result.response, { status: 201 });
      } catch (error) {
        return mapSessionError(error);
      }
    },
  };
}

export async function POST(request: Request): Promise<Response> {
  try {
    return await createSessionRouteHandlers(getDefaultSessionUnitOfWork()).POST(request);
  } catch {
    return errorResponse("INTERNAL_ERROR", "服务器内部错误", 500);
  }
}
